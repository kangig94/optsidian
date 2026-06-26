import crypto from "node:crypto";
import { canonicalValueBytes } from "./segments/index.js";

export type IndexAffectingSearchSettings = {
  ngram: boolean;
};

export const DEFAULT_INDEX_AFFECTING_SEARCH_SETTINGS: IndexAffectingSearchSettings = Object.freeze({
  ngram: false
});

export const INDEX_AFFECTING_SEARCH_SETTINGS_HASH = indexAffectingSearchSettingsHash(
  DEFAULT_INDEX_AFFECTING_SEARCH_SETTINGS
);

export function normalizeIndexAffectingSearchSettings(
  value: Partial<IndexAffectingSearchSettings> | undefined = DEFAULT_INDEX_AFFECTING_SEARCH_SETTINGS
): IndexAffectingSearchSettings {
  return {
    ngram: value.ngram === true
  };
}

export function indexAffectingSearchSettingsHash(
  settings: Partial<IndexAffectingSearchSettings> | undefined = DEFAULT_INDEX_AFFECTING_SEARCH_SETTINGS
): string {
  return sha256(canonicalValueBytes({
    indexAffectingSettings: normalizeIndexAffectingSearchSettings(settings)
  }));
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
