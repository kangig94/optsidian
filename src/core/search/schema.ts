import crypto from 'node:crypto';
import type { SearchBuildDocument } from './markdown.js';
import type { SearchField } from '../types.js';
import type { SearchTokenChannel } from './analysis/index.js';

export const SEARCH_PROPERTIES = [
  'title',
  'aliases',
  'tags',
  'headings',
  'path',
  'body',
] as const satisfies readonly SearchField[];
export const SEARCH_DB_SCHEMA = {
  persistedDocument: {
    fields: ['documentId', 'path', 'contentHash', 'partitionId', 'title', 'tags'],
  },
  indexedPostings: {
    fields: ['title', 'aliases', 'tags', 'headings', 'path', 'body'],
    channels: ['morph', 'surface', 'ngram'],
  },
  indexedTokenProperties: {
    morph: ['titleTokens', 'aliasesTokens', 'tagsTokens', 'headingsTokens', 'pathTokens', 'bodyTokens'],
    surface: [
      'titleSurfaceTokens',
      'aliasesSurfaceTokens',
      'tagsSurfaceTokens',
      'headingsSurfaceTokens',
      'pathSurfaceTokens',
      'bodySurfaceTokens',
    ],
    ngram: [
      'titleNgramTokens',
      'aliasesNgramTokens',
      'tagsNgramTokens',
      'headingsNgramTokens',
      'pathNgramTokens',
      'bodyNgramTokens',
    ],
  },
  segmentFieldTexts: {
    fields: ['title', 'aliases', 'tags', 'headings', 'path'],
  },
  snippetCorpus: {
    name: 'single-snippet-corpus',
    version: 2,
    fields: {
      bodyStartLine: 'number',
      lines: ['snippetId', 'segmentId', 'documentId', 'line', 'text', 'byteStart', 'byteEnd', 'channels'],
      fallback: {
        line: ['kind', 'snippetId'],
        title: ['kind', 'line'],
      },
    },
  },
} as const;
export const SEARCH_SCHEMA_DIGEST = crypto.createHash('sha256').update(JSON.stringify(SEARCH_DB_SCHEMA)).digest('hex');
export const SEARCH_FIELD_INDEX_PROPERTY: Record<SearchField, keyof SearchBuildDocument> = {
  title: 'titleTokens',
  aliases: 'aliasesTokens',
  tags: 'tagsTokens',
  headings: 'headingsTokens',
  path: 'pathTokens',
  body: 'bodyTokens',
};
export const SEARCH_FIELD_CHANNEL_INDEX_PROPERTY: Record<
  SearchTokenChannel,
  Record<SearchField, keyof SearchBuildDocument>
> = {
  morph: SEARCH_FIELD_INDEX_PROPERTY,
  surface: {
    title: 'titleSurfaceTokens',
    aliases: 'aliasesSurfaceTokens',
    tags: 'tagsSurfaceTokens',
    headings: 'headingsSurfaceTokens',
    path: 'pathSurfaceTokens',
    body: 'bodySurfaceTokens',
  },
  ngram: {
    title: 'titleNgramTokens',
    aliases: 'aliasesNgramTokens',
    tags: 'tagsNgramTokens',
    headings: 'headingsNgramTokens',
    path: 'pathNgramTokens',
    body: 'bodyNgramTokens',
  },
};
export const SEARCH_BOOST: Record<SearchField, number> = {
  title: 8,
  tags: 7,
  aliases: 6,
  headings: 4,
  path: 2,
  body: 1,
};
export const SEARCH_FIELD_CHANNEL_BOOST: Record<SearchTokenChannel, Record<SearchField, number>> = {
  morph: SEARCH_BOOST,
  surface: {
    title: 6,
    tags: 5,
    aliases: 4,
    headings: 3,
    path: 1.5,
    body: 0.8,
  },
  ngram: {
    title: 3,
    tags: 2.5,
    aliases: 2,
    headings: 1.5,
    path: 1,
    body: 0.4,
  },
};
