import { getValue, ParsedArgs } from "../args.js";
import { parseFormat, type OutputFormat } from "../render.js";
import { UsageError } from "../../errors.js";
import { loadAddonManifest, type InstalledAddon } from "../../addons/manifest.js";
import { addonHome, installGitAddon, installLocalAddon, listAddonSummaries, normalizeGitSource, removeAddon, type AddonSource, type AddonSummary } from "../../addons/registry.js";
import { NATIVE_SUFFICIENT_COMMANDS, implementedCommands } from "../policy.js";

type AddonCommandResult =
  | { ok: true; command: "addon"; action: "install"; addon: AddonSummary; registry: string }
  | { ok: true; command: "addon"; action: "list"; addons: AddonSummary[]; registry: string }
  | { ok: true; command: "addon"; action: "remove"; id: string; removed: boolean; registry: string };

const RESERVED_ADDON_IDS = new Set(["raw", "help"]);

export function runAddon(args: ParsedArgs): void {
  const format = parseFormat(getValue(args, "format"));
  const [action, value, ...extra] = args.positionals;
  if (!action) {
    throw new UsageError("Missing addon action: install, list, or remove");
  }
  if (extra.length > 0) {
    throw new UsageError(`Unexpected addon argument: ${extra[0]}`);
  }

  let result: AddonCommandResult;
  switch (action) {
    case "install": {
      if (!value) throw new UsageError("Missing addon source: optsidian addon install <path-or-git-url>");
      const ref = getValue(args, "ref");
      const gitUrl = normalizeGitSource(value);
      const source: AddonSource = gitUrl ? { type: "git", url: gitUrl, ...(ref ? { ref } : {}) } : { type: "local" };
      let addon: InstalledAddon;
      if (source.type === "git") {
        addon = installGitAddon(source.url, { ref: source.ref, validateAddon: rejectCommandCollision });
      } else {
        const candidate = loadAddonManifest(value);
        rejectCommandCollision(candidate);
        addon = installLocalAddon(candidate.root);
      }
      result = {
        ok: true,
        command: "addon",
        action: "install",
        addon: summarizeAddon(addon, source),
        registry: addonHome()
      };
      break;
    }
    case "list": {
      if (value) throw new UsageError(`Unexpected addon argument: ${value}`);
      result = {
        ok: true,
        command: "addon",
        action: "list",
        addons: listAddonSummaries(),
        registry: addonHome()
      };
      break;
    }
    case "remove": {
      if (!value) throw new UsageError("Missing addon id: optsidian addon remove <id>");
      result = {
        ok: true,
        command: "addon",
        action: "remove",
        id: value,
        removed: removeAddon(value),
        registry: addonHome()
      };
      break;
    }
    default:
      throw new UsageError(`Unknown addon action: ${action}`);
  }

  process.stdout.write(renderAddonResult(result, format));
}

function rejectCommandCollision(addon: InstalledAddon): void {
  const id = addon.id;
  if (RESERVED_ADDON_IDS.has(id) || implementedCommands().includes(id) || NATIVE_SUFFICIENT_COMMANDS.has(id)) {
    throw new UsageError(`Addon id conflicts with an existing optsidian or native command: ${id}`);
  }
}

function summarizeAddon(addon: InstalledAddon, source: AddonSource): AddonSummary {
  return {
    id: addon.id,
    name: addon.manifest.name,
    version: addon.manifest.version,
    root: addon.root,
    source
  };
}

function renderAddonResult(result: AddonCommandResult, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result)}\n`;
  }
  if (result.action === "install") {
    return [
      `Installed addon ${result.addon.id}.`,
      `name: ${result.addon.name}`,
      `version: ${result.addon.version}`,
      `source: ${formatSource(result.addon.source)}`,
      `root: ${result.addon.root}`,
      `registry: ${result.registry}`
    ].join("\n").concat("\n");
  }
  if (result.action === "remove") {
    return result.removed ? `Removed addon ${result.id}.\n` : `Addon ${result.id} was not installed.\n`;
  }
  if (result.addons.length === 0) {
    return "No addons installed.\n";
  }
  const lines = result.addons.map((addon) => `${addon.id}\t${addon.version}\t${formatSource(addon.source)}\t${addon.root}`);
  return `${lines.join("\n")}\n`;
}

function formatSource(source: AddonSource): string {
  if (source.type === "local") return "local";
  return source.ref ? `git ${source.url}#${source.ref}` : `git ${source.url}`;
}
