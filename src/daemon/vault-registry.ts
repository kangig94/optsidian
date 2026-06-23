import fs from "node:fs";
import path from "node:path";
import type { VaultState } from "./protocol.js";

export type VaultRecord = {
  vault: string;
  state: VaultState;
  snapshotId?: string;
  updatedAt?: string;
  error?: string;
};

export class VaultRegistry {
  private readonly vaults = new Map<string, VaultRecord>();

  get(vault: string): VaultRecord {
    const key = canonicalVault(vault);
    const current = this.vaults.get(key);
    if (current) return current;
    const record: VaultRecord = { vault: key, state: "unloaded" };
    this.vaults.set(key, record);
    return record;
  }

  list(): VaultRecord[] {
    return [...this.vaults.values()].sort((left, right) => left.vault.localeCompare(right.vault));
  }

  transition(vault: string, state: VaultState, patch: Partial<Omit<VaultRecord, "vault" | "state">> = {}): VaultRecord {
    const current = this.get(vault);
    const next: VaultRecord = {
      ...current,
      ...patch,
      state,
      updatedAt: new Date().toISOString()
    };
    this.vaults.set(current.vault, next);
    return next;
  }
}

function canonicalVault(vault: string): string {
  const resolved = path.resolve(vault);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
