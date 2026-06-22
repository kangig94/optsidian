import initKiwiModule from "kiwi-nlp/dist/build/kiwi-wasm.js";
import {
  KIWI_MODEL_TYPE,
  KIWI_MODEL_VERSION,
  KIWI_NLP_VERSION,
  ensureKiwiModelArtifact,
  ensureKiwiWasmArtifact,
  readVerifiedKiwiModelFiles,
  readVerifiedKiwiWasmBinary,
  type KiwiModelFileName
} from "./kiwi-artifact.js";

export type KiwiAnalyzerIdentity = {
  engine: "kiwi";
  kiwiNlpVersion: string;
  modelVersion: string;
  modelType: typeof KIWI_MODEL_TYPE;
};

export type KiwiAnalyzer = {
  identity: KiwiAnalyzerIdentity;
  tokens(text: string): string[];
  dispose(): Promise<void>;
};

export type LoadKiwiAnalyzerOptions = {
  installIfMissing?: boolean;
  env?: NodeJS.ProcessEnv;
};

type KiwiTokenInfo = {
  str?: string;
};

type KiwiWasmModule = {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
    rmdir(path: string): void;
  };
  api(command: string): string;
};

type KiwiWasmInitializer = (moduleArg?: Record<string, unknown>) => Promise<KiwiWasmModule>;
type KiwiWasmInitializerImport = KiwiWasmInitializer | { default?: KiwiWasmInitializer };

type KiwiApi = {
  cmd<T = unknown>(command: Record<string, unknown>): T;
  loadModelFiles(files: Record<KiwiModelFileName, Uint8Array>): Promise<{
    modelPath: string;
    unload(): Promise<void>;
  }>;
};

const initKiwi = resolveKiwiWasmInitializer(initKiwiModule as unknown as KiwiWasmInitializerImport);
const KIWI_MATCH_ALL_WITH_NORMALIZING = 8_454_207;

export function __resolveKiwiWasmInitializerForTests(imported: unknown): KiwiWasmInitializer {
  return resolveKiwiWasmInitializer(imported as KiwiWasmInitializerImport);
}

function resolveKiwiWasmInitializer(imported: KiwiWasmInitializerImport): KiwiWasmInitializer {
  const initializer = typeof imported === "function" ? imported : imported.default;
  if (typeof initializer !== "function") {
    throw new Error("Kiwi wasm initializer is not available");
  }
  return initializer;
}

export async function loadKiwiAnalyzer(options: LoadKiwiAnalyzerOptions = {}): Promise<KiwiAnalyzer> {
  const env = options.env ?? process.env;
  if (options.installIfMissing === true) {
    const installed = await ensureKiwiModelArtifact(env, { verifyFiles: "metadata" });
    if (installed.status === "error") throw new Error(installed.message);
  }

  const modelFiles = await readLoadableModelFiles(env, options.installIfMissing === true);

  const loaded = await buildDisposableKiwi(modelFiles, env);
  if (!loaded.ready()) {
    await loaded.dispose();
    throw new Error("Kiwi analyzer was constructed but is not ready");
  }

  let disposed = false;
  return {
    identity: kiwiAnalyzerIdentity(),
    tokens(text: string): string[] {
      if (disposed) throw new Error("Kiwi analyzer has been disposed");
      return loaded.tokenize(text).map((token) => token.str).filter((token): token is string => Boolean(token));
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await loaded.dispose();
    }
  };
}

export function kiwiAnalyzerIdentity(): KiwiAnalyzerIdentity {
  return {
    engine: "kiwi",
    kiwiNlpVersion: KIWI_NLP_VERSION,
    modelVersion: KIWI_MODEL_VERSION,
    modelType: KIWI_MODEL_TYPE
  };
}

export async function loadKiwiWasmBinary(env: NodeJS.ProcessEnv = process.env): Promise<Uint8Array> {
  const installed = await ensureKiwiWasmArtifact(env, { verifyFile: "metadata" });
  if (installed.status === "error") throw new Error(installed.message);
  return readLoadableWasmBinary(env);
}

async function readLoadableModelFiles(env: NodeJS.ProcessEnv, repairIfInvalid: boolean): Promise<Record<KiwiModelFileName, Uint8Array>> {
  try {
    return readVerifiedKiwiModelFiles(env);
  } catch (error) {
    if (!repairIfInvalid) throw new Error("Kiwi model artifact is not installed", { cause: error });
    const installed = await ensureKiwiModelArtifact(env, { forceInstall: true });
    if (installed.status === "error") throw new Error(installed.message);
    return readVerifiedKiwiModelFiles(env);
  }
}

async function readLoadableWasmBinary(env: NodeJS.ProcessEnv): Promise<Uint8Array> {
  try {
    return readVerifiedKiwiWasmBinary(env);
  } catch {
    const installed = await ensureKiwiWasmArtifact(env, { forceInstall: true });
    if (installed.status === "error") throw new Error(installed.message);
    return readVerifiedKiwiWasmBinary(env);
  }
}

async function buildDisposableKiwi(modelFiles: Record<KiwiModelFileName, Uint8Array>, env: NodeJS.ProcessEnv): Promise<{
  ready(): boolean;
  tokenize(text: string): KiwiTokenInfo[];
  dispose(): Promise<void>;
}> {
  const api = await createKiwiApi(env);
  const loadedModel = await api.loadModelFiles(modelFiles);
  let disposed = false;
  try {
    const id = api.cmd<number>({
      method: "build",
      args: [{
        modelType: KIWI_MODEL_TYPE,
        modelPath: loadedModel.modelPath
      }]
    });
    return {
      ready(): boolean {
        return api.cmd<boolean>({ method: "ready", id, args: [] });
      },
      tokenize(text: string): KiwiTokenInfo[] {
        return api.cmd<KiwiTokenInfo[]>({
          method: "tokenize",
          id,
          args: [text, KIWI_MATCH_ALL_WITH_NORMALIZING]
        });
      },
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await loadedModel.unload();
      }
    };
  } catch (error) {
    await loadedModel.unload();
    throw error;
  }
}

async function createKiwiApi(env: NodeJS.ProcessEnv): Promise<KiwiApi> {
  const kiwi = await initKiwi({
    wasmBinary: await loadKiwiWasmBinary(env)
  });
  return {
    cmd<T = unknown>(command: Record<string, unknown>): T {
      return JSON.parse(kiwi.api(JSON.stringify(command))) as T;
    },
    async loadModelFiles(files: Record<KiwiModelFileName, Uint8Array>) {
      const modelPath = `kiwi-model-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      kiwi.FS.mkdir(modelPath);
      const loadedFiles: string[] = [];
      try {
        for (const [name, data] of Object.entries(files)) {
          const filePath = `${modelPath}/${name}`;
          kiwi.FS.writeFile(filePath, data);
          loadedFiles.push(filePath);
        }
      } catch (error) {
        cleanupLoadedFiles(kiwi, modelPath, loadedFiles);
        throw error;
      }

      return {
        modelPath,
        async unload(): Promise<void> {
          cleanupLoadedFiles(kiwi, modelPath, loadedFiles);
        }
      };
    }
  };
}

function cleanupLoadedFiles(kiwi: KiwiWasmModule, modelPath: string, loadedFiles: string[]): void {
  for (const filePath of [...loadedFiles].reverse()) {
    try {
      kiwi.FS.unlink(filePath);
    } catch {
      // Best-effort cleanup only.
    }
  }
  try {
    kiwi.FS.rmdir(modelPath);
  } catch {
    // Best-effort cleanup only.
  }
}
