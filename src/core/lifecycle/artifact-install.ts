import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirSync, fsyncDirSync, fsyncFileSync, writePrivateFileSync } from "../private-path.js";
import { ExclusiveClaim, type ExclusiveClaimAcquireOptions } from "./exclusive-claim.js";
import {
  createProcessToken,
  isAlive as defaultIsAlive,
  type ProcessStartIdentityProvider,
  type ProcessToken
} from "./process-token.js";

export type ArtifactVerifyDepth = "metadata" | "digest" | (string & {});

export type ArtifactInstallContext<TDepth extends ArtifactVerifyDepth> = {
  claim: ExclusiveClaim;
  stagingDir: string;
  verifyDepth: TDepth;
  expectedSha256?: string;
};

export type InstallArtifactOptions<TArtifact, TDepth extends ArtifactVerifyDepth = ArtifactVerifyDepth> = {
  artifactDir: string;
  claimDir: string;
  verifyDepth: TDepth;
  stage(stagingDir: string, context: ArtifactInstallContext<TDepth>): Promise<void> | void;
  computeChecksum(stagingDir: string, context: ArtifactInstallContext<TDepth>): Promise<string> | string;
  verifyInstalled(artifactDir: string, verifyDepth: TDepth): Promise<TArtifact | undefined> | TArtifact | undefined;
  activate?(stagingDir: string, artifactDir: string, context: ArtifactInstallContext<TDepth>): Promise<void> | void;
  stagingRoot?: string;
  expectedSha256?: string;
  token?: ProcessToken;
  claimId?: string;
  timeoutMs?: number;
  pollMs?: number;
  backstopTtlMs?: number;
  startIdentityProvider?: ProcessStartIdentityProvider;
  isAlive?: (token: ProcessToken) => boolean;
};

export type InstallArtifactResult<TArtifact, TDepth extends ArtifactVerifyDepth = ArtifactVerifyDepth> = {
  artifact: TArtifact;
  activated: boolean;
  checksum?: string;
  verifyDepth: TDepth;
};

export type SweepArtifactStagingOptions = {
  isAlive?: (token: ProcessToken) => boolean;
  backstopTtlMs?: number;
  now?: () => number;
};

type StagingOwner = {
  token: ProcessToken;
  claimId: string;
  createdAtMs: number;
};

export async function installArtifact<TArtifact, TDepth extends ArtifactVerifyDepth = ArtifactVerifyDepth>(
  options: InstallArtifactOptions<TArtifact, TDepth>
): Promise<InstallArtifactResult<TArtifact, TDepth>> {
  const existing = await options.verifyInstalled(options.artifactDir, options.verifyDepth);
  if (existing !== undefined) return { artifact: existing, activated: false, verifyDepth: options.verifyDepth };

  const token = options.token ?? createProcessToken(process.pid, options.startIdentityProvider);
  const claimOptions: ExclusiveClaimAcquireOptions = {
    token,
    claimId: options.claimId,
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
    backstopTtlMs: options.backstopTtlMs,
    startIdentityProvider: options.startIdentityProvider,
    isAlive: options.isAlive
  };
  const claim = await ExclusiveClaim.acquire(options.claimDir, claimOptions);
  const stagingRoot = options.stagingRoot ?? path.join(path.dirname(options.artifactDir), "staging");
  const stagingNamespace = path.join(stagingRoot, stagingNamespaceName(token));
  const stagingDir = path.join(stagingNamespace, claim.claimId);

  try {
    await sweepDeadArtifactStaging(stagingRoot, {
      isAlive: options.isAlive,
      backstopTtlMs: options.backstopTtlMs
    });

    const existingAfterClaim = await options.verifyInstalled(options.artifactDir, options.verifyDepth);
    if (existingAfterClaim !== undefined) {
      return { artifact: existingAfterClaim, activated: false, verifyDepth: options.verifyDepth };
    }

    prepareStagingNamespace(stagingNamespace, {
      token,
      claimId: claim.claimId,
      createdAtMs: Date.now()
    });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    ensurePrivateDirSync(stagingDir, "Artifact staging directory");

    const context: ArtifactInstallContext<TDepth> = {
      claim,
      stagingDir,
      verifyDepth: options.verifyDepth,
      expectedSha256: options.expectedSha256
    };
    await options.stage(stagingDir, context);
    const checksum = await options.computeChecksum(stagingDir, context);
    if (options.expectedSha256 && checksum !== options.expectedSha256) {
      throw new Error(`Artifact checksum mismatch: expected ${options.expectedSha256}, got ${checksum}.`);
    }

    await (options.activate ?? defaultActivate)(stagingDir, options.artifactDir, context);
    const installed = await options.verifyInstalled(options.artifactDir, options.verifyDepth);
    if (installed === undefined) throw new Error(`Artifact failed verification after activation: ${options.artifactDir}`);
    return { artifact: installed, activated: true, checksum, verifyDepth: options.verifyDepth };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    removeEmptyDir(stagingNamespace);
    claim.release();
  }
}

export async function sweepDeadArtifactStaging(stagingRoot: string, options: SweepArtifactStagingOptions = {}): Promise<void> {
  if (!fs.existsSync(stagingRoot)) return;
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? defaultIsAlive;
  for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const namespaceDir = path.join(stagingRoot, entry.name);
    const owner = readStagingOwner(namespaceDir);
    if (owner) {
      if (isAlive(owner.token)) continue;
      fs.rmSync(namespaceDir, { recursive: true, force: true });
      fsyncDirSync(stagingRoot);
      continue;
    }
    const backstopTtlMs = options.backstopTtlMs ?? 60_000;
    if (!Number.isFinite(backstopTtlMs)) continue;
    const stat = fs.statSync(namespaceDir);
    if (now() - stat.mtimeMs >= backstopTtlMs) {
      fs.rmSync(namespaceDir, { recursive: true, force: true });
      fsyncDirSync(stagingRoot);
    }
  }
}

export function stagingNamespaceName(token: ProcessToken): string {
  const digest = crypto.createHash("sha256").update(token.startId).digest("hex").slice(0, 16);
  return `${token.pid}-${digest}`;
}

async function defaultActivate<TDepth extends ArtifactVerifyDepth>(
  stagingDir: string,
  artifactDir: string,
  _context: ArtifactInstallContext<TDepth>
): Promise<void> {
  ensurePrivateDirSync(path.dirname(artifactDir), "Artifact parent directory");
  if (fs.existsSync(artifactDir)) return;
  fs.renameSync(stagingDir, artifactDir);
  fsyncDirSync(path.dirname(artifactDir));
}

function prepareStagingNamespace(namespaceDir: string, owner: StagingOwner): void {
  ensurePrivateDirSync(namespaceDir, "Artifact staging owner namespace");
  writePrivateFileSync(path.join(namespaceDir, "owner.json"), `${JSON.stringify(owner)}\n`, "Artifact staging owner file");
  fsyncFileSync(path.join(namespaceDir, "owner.json"));
  fsyncDirSync(namespaceDir);
  fsyncDirSync(path.dirname(namespaceDir));
}

function readStagingOwner(namespaceDir: string): StagingOwner | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(namespaceDir, "owner.json"), "utf8")) as unknown;
    if (isStagingOwner(parsed)) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function isStagingOwner(value: unknown): value is StagingOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<StagingOwner>;
  const token = owner.token as Partial<ProcessToken> | undefined;
  return (
    typeof owner.claimId === "string" &&
    Number.isFinite(owner.createdAtMs) &&
    !!token &&
    Number.isSafeInteger(token.pid) &&
    typeof token.startId === "string" &&
    token.startId.length > 0
  );
}

function removeEmptyDir(dirPath: string): void {
  try {
    fs.rmdirSync(dirPath);
    fsyncDirSync(path.dirname(dirPath));
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTEMPTY") return;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
