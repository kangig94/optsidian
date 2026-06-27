import type { SearchTextAnalysis, SearchTokenChannel } from "../../analysis/index.js";
import { SEARCH_PROPERTIES } from "../../schema.js";
import type { ShardDocRef } from "../../contracts.js";
import type { SearchField } from "../../../types.js";

export type PositionalDocId = number;
export type PositionalFieldId = number;

export const POSITIONAL_SEARCH_FIELDS = [...SEARCH_PROPERTIES] as readonly SearchField[];

export const POSITIONAL_FIELD_ID: Record<SearchField, PositionalFieldId> = Object.fromEntries(
  POSITIONAL_SEARCH_FIELDS.map((field, index) => [field, index])
) as Record<SearchField, PositionalFieldId>;

export const POSITIONAL_FIELD_BY_ID: Record<PositionalFieldId, SearchField> = Object.fromEntries(
  POSITIONAL_SEARCH_FIELDS.map((field, index) => [index, field])
) as Record<PositionalFieldId, SearchField>;

export type PositionalPosting = {
  docId: PositionalDocId;
  fieldId: PositionalFieldId;
  positions: readonly number[];
};

export type PositionalPostings = ReadonlyMap<string, readonly PositionalPosting[]>;

export type PositionalFieldInput = {
  fieldId: PositionalFieldId;
  tokens: readonly string[];
};

export type PositionalDocumentInput = {
  docId: PositionalDocId;
  fields: readonly PositionalFieldInput[];
};

export type PositionalDocumentRecord = {
  shardDocRef: ShardDocRef;
  documentId: string;
  documentKey: string;
  path?: string;
  tags?: readonly string[];
};

export type PositionalChannelFieldInput = {
  field: SearchField;
  tokens: readonly string[];
};

export type PositionalChannelDocumentInput = {
  docId: PositionalDocId;
  documentId?: string;
  documentKey: string;
  path?: string;
  tags?: readonly string[];
  channels: Partial<Record<SearchTokenChannel, readonly PositionalChannelFieldInput[]>>;
};

export type PositionalChannelIndex = Partial<Record<SearchTokenChannel, PositionalPostings>>;

export type PositionalQueryAnalysis = SearchTextAnalysis;
