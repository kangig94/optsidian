import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCoralNeedleBinding } from './artifact.js';
import type {
  CoralChunkRecord,
  CoralEmbeddingSpec,
  CoralNeedleInstance,
  CoralNeedleInstanceFactory,
  CoralSearchResult,
  CoralStoreStats,
  VectorStoreKey,
  VectorStoreRole,
} from './types.js';

type ProcessRequest =
  | { id: number; type: 'initStore'; payload: { dbPath: string } }
  | { id: number; type: 'setActiveSpec'; payload: { spec: CoralEmbeddingSpec } }
  | { id: number; type: 'upsertChunks'; payload: { chunks: readonly CoralChunkRecord[] } }
  | { id: number; type: 'buildIndex'; payload: { engineName?: 'auto' | string } }
  | { id: number; type: 'searchVector'; payload: { queryVector: readonly number[] | Float32Array; candidateK: number } }
  | { id: number; type: 'getStats'; payload: Record<string, never> }
  | { id: number; type: 'close'; payload: Record<string, never> };

type ProcessReply =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { code?: string; message: string } };

type PendingCall = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export type CoralNeedleProcessFactoryOptions = {
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
  bindingPath?: string;
  ensureBinding?: typeof ensureCoralNeedleBinding;
};

export function createCoralNeedleProcessInstanceFactory(
  options: CoralNeedleProcessFactoryOptions = {},
): CoralNeedleInstanceFactory {
  return {
    async create(input) {
      const baseEnv = options.env ?? process.env;
      const bindingPath = options.bindingPath ?? (await (options.ensureBinding ?? ensureCoralNeedleBinding)(baseEnv));
      return new CoralNeedleProcessInstance(input, {
        ...options,
        env: {
          ...baseEnv,
          OPTSIDIAN_CORAL_NEEDLE_BINDING: bindingPath,
        },
      });
    },
  };
}

class CoralNeedleProcessInstance implements CoralNeedleInstance {
  readonly instanceId: string;
  readonly role: VectorStoreRole;
  readonly key: VectorStoreKey;
  readonly generationId: string;
  readonly dbPath: string;

  private readonly child: ChildProcess;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private closed = false;

  constructor(
    input: {
      role: VectorStoreRole;
      key: VectorStoreKey;
      generationId: string;
      dbPath: string;
    },
    options: CoralNeedleProcessFactoryOptions,
  ) {
    this.role = input.role;
    this.key = input.key;
    this.generationId = input.generationId;
    this.dbPath = input.dbPath;
    this.instanceId = `${input.role}:${input.key.vaultStateHash}:${input.key.embeddingSetId}:${input.generationId}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    this.child = fork(options.scriptPath ?? defaultProcessScript(), [], {
      env: options.env ?? process.env,
      execArgv: processExecArgv(),
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    this.child.on('message', (message) => {
      this.handleReply(message as ProcessReply);
    });
    this.child.on('exit', (code, signal) => {
      this.rejectAll(`coral-needle process exited (${code ?? signal ?? 'unknown'})`);
    });
    this.child.on('error', (error) => {
      this.rejectAll(error.message);
    });
  }

  initStore(dbPath: string): Promise<void> {
    return this.call<void>({ type: 'initStore', payload: { dbPath } });
  }

  setActiveSpec(spec: CoralEmbeddingSpec): Promise<void> {
    return this.call<void>({ type: 'setActiveSpec', payload: { spec } });
  }

  upsertChunks(chunks: readonly CoralChunkRecord[]): Promise<void> {
    return this.call<void>({ type: 'upsertChunks', payload: { chunks } });
  }

  buildIndex(engineName: 'auto' | string = 'auto'): Promise<void> {
    return this.call<void>({ type: 'buildIndex', payload: { engineName } });
  }

  searchVector(queryVector: readonly number[] | Float32Array, candidateK: number): Promise<CoralSearchResult[]> {
    return this.call<CoralSearchResult[]>({
      type: 'searchVector',
      payload: { queryVector: Array.from(queryVector), candidateK },
    });
  }

  getStats(): Promise<CoralStoreStats> {
    return this.call<CoralStoreStats>({ type: 'getStats', payload: {} });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      // Only attempt the graceful close RPC if the IPC channel is still open. A crashed/exited
      // child leaves `connected === false`; sending to it rejects with "Channel closed", which —
      // on the fire-and-forget retire path — would surface as an unhandled rejection that kills
      // the whole daemon, defeating the subprocess isolation this instance exists to provide.
      if (this.child.connected) {
        await this.call<void>({ type: 'close', payload: {} });
      }
    } catch {
      // Any close-RPC failure is non-actionable during teardown (channel closed, child already
      // exited, or an app-level close error we cannot recover from) — the kill below still runs.
    } finally {
      this.child.kill();
    }
  }

  private call<T>(request: Omit<ProcessRequest, 'id'>): Promise<T> {
    if (this.closed && request.type !== 'close') {
      return Promise.reject(Object.assign(new Error('coral-needle process instance is closed'), { code: 'INTERNAL' }));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject });
      this.child.send?.({ id, ...request }, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleReply(message: ProcessReply): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code ?? 'INTERNAL' }));
  }

  private rejectAll(message: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(Object.assign(new Error(message), { code: 'INTERNAL' }));
    }
  }
}

function defaultProcessScript(): string {
  const dist = path.resolve(process.cwd(), 'dist', 'daemon', 'vector-store', 'process-entry.js');
  if (fs.existsSync(dist)) return dist;
  const source = fileURLToPath(new URL('./process-entry.ts', import.meta.url));
  if (fs.existsSync(source)) return source;
  return fileURLToPath(import.meta.url);
}

function processExecArgv(): string[] {
  return process.execArgv.filter((arg) => arg === '--import' || arg === 'tsx' || arg.endsWith('/tsx'));
}
