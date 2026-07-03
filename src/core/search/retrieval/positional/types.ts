import { SEARCH_PROPERTIES } from '../../schema.js';
import type { SearchField } from '../../../types.js';

export type PositionalDocId = number;
export type PositionalFieldId = number;

export const POSITIONAL_SEARCH_FIELDS = [...SEARCH_PROPERTIES] as readonly SearchField[];

export const POSITIONAL_FIELD_ID: Record<SearchField, PositionalFieldId> = Object.fromEntries(
  POSITIONAL_SEARCH_FIELDS.map((field, index) => [field, index]),
) as Record<SearchField, PositionalFieldId>;

export const POSITIONAL_FIELD_BY_ID: Record<PositionalFieldId, SearchField> = Object.fromEntries(
  POSITIONAL_SEARCH_FIELDS.map((field, index) => [index, field]),
);

export type PositionalPosting = {
  docId: PositionalDocId;
  fieldId: PositionalFieldId;
  positions: readonly number[];
};

export type PositionalPostings = ReadonlyMap<string, readonly PositionalPosting[]>;

type PositionalFieldInput = {
  fieldId: PositionalFieldId;
  tokens: readonly string[];
};

export type PositionalDocumentInput = {
  docId: PositionalDocId;
  fields: readonly PositionalFieldInput[];
};
