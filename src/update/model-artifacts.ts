import { RuntimeError } from "../errors.js";
import {
  ensureLocalOnnxModelArtifact,
  inspectLocalOnnxModelArtifact,
  resolveLocalOnnxModelKey,
  type LocalOnnxModelAlias,
  type LocalOnnxModelKey
} from "../core/search/dense/artifacts.js";

export type DenseModelArtifactInstallResult = {
  ok: true;
  command: "update";
  action: "model-artifact";
  model: LocalOnnxModelKey;
  status: "installed" | "already_installed";
  targetDir: string;
};

export type DenseModelArtifactStatusResult = {
  ok: true;
  command: "update";
  action: "model-artifact-status";
  model: LocalOnnxModelKey;
  installed: boolean;
  targetDir: string;
  missingFiles: string[];
};

export async function installDenseModelArtifact(options: {
  model?: LocalOnnxModelAlias | string;
  env?: NodeJS.ProcessEnv;
  forceInstall?: boolean;
} = {}): Promise<DenseModelArtifactInstallResult> {
  const env = options.env ?? process.env;
  const model = resolveLocalOnnxModelKey(options.model);
  const result = await ensureLocalOnnxModelArtifact(model, env, {
    forceInstall: options.forceInstall,
    verifyFiles: "metadata"
  });
  if (result.status === "error") throw new RuntimeError(result.message);
  return {
    ok: true,
    command: "update",
    action: "model-artifact",
    model,
    status: result.status,
    targetDir: result.targetDir
  };
}

export function denseModelArtifactStatus(options: {
  model?: LocalOnnxModelAlias | string;
  env?: NodeJS.ProcessEnv;
} = {}): DenseModelArtifactStatusResult {
  const env = options.env ?? process.env;
  const model = resolveLocalOnnxModelKey(options.model);
  const state = inspectLocalOnnxModelArtifact(model, env, { verifyFiles: "metadata" });
  return {
    ok: true,
    command: "update",
    action: "model-artifact-status",
    model,
    installed: state.installed,
    targetDir: state.targetDir,
    missingFiles: state.missingFiles
  };
}
