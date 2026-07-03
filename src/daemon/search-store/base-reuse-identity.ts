import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SearchAnalyzerIdentity } from '../../core/search/analyzer.js';
import { canonicalValueBytes } from '../../core/search/segments/canonical.js';

const BASE_REUSE_IMPLEMENTATION_IDENTITY_SCHEMA_VERSION = 1;
const TEST_ARTIFACT_ENV = 'OPTSIDIAN_SEARCH_DAEMON_BUILD_ARTIFACT_PATH';

export type BaseReuseImplementationIdentity = {
  identity?: string;
  artifactPath?: string;
  artifactSha256?: string;
  warning?: string;
};

export function computeBaseReuseImplementationIdentity(input: {
  analyzerIdentity: SearchAnalyzerIdentity;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): BaseReuseImplementationIdentity {
  const env = input.env ?? process.env;
  const artifactPath = daemonBuildArtifactPath(env, input.cwd ?? process.cwd());
  if (!artifactPath) {
    return { warning: 'daemon build artifact dist/optsidian is unavailable; base reuse disabled' };
  }
  try {
    const artifactBytes = fs.readFileSync(artifactPath);
    const artifactSha256 = sha256(artifactBytes);
    // This binary-derived identity is deliberately separate from index identity.
    // It is a pre-publish reuse fence only: a binary change may force one full
    // recompute, but it must never change corpusSnapshotId or lexicalIdentityHash.
    const identity = sha256(
      canonicalValueBytes({
        schemaVersion: BASE_REUSE_IMPLEMENTATION_IDENTITY_SCHEMA_VERSION,
        analyzerIdentity: input.analyzerIdentity,
        daemonBuildArtifactSha256: artifactSha256,
      }),
    );
    return { identity, artifactPath, artifactSha256 };
  } catch (error) {
    return {
      artifactPath,
      warning: `daemon build artifact ${artifactPath} could not be hashed; base reuse disabled: ${errorMessage(error)}`,
    };
  }
}

function daemonBuildArtifactPath(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const override = env[TEST_ARTIFACT_ENV]?.trim();
  if (override) return path.resolve(cwd, override);

  const argvBinary = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  if (argvBinary && path.basename(argvBinary) === 'optsidian' && fs.existsSync(argvBinary)) {
    return argvBinary;
  }

  const modulePath = fileURLToPath(import.meta.url);
  if (path.basename(modulePath) === 'optsidian' && fs.existsSync(modulePath)) {
    return modulePath;
  }

  const repoDist = path.resolve(cwd, 'dist', 'optsidian');
  if (fs.existsSync(repoDist)) return repoDist;
  return undefined;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
