import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SEARCH_TOKEN_CHANNELS } from '../src/core/search/analysis/index.ts';
import { uniqueSearchTerms } from '../src/core/search/analysis/channels.ts';
import {
  CANDIDATE_LIMIT_MIN,
  CANDIDATE_LIMIT_MULTIPLIER,
  COVERAGE_FIELD_WEIGHT,
  SEARCH_TOKEN_CHANNEL_WEIGHT,
  WEAK_METADATA_COVERAGE_TERMS,
} from '../src/core/search/constants.ts';
import { decodeCanonicalSegment } from '../src/core/search/segments/canonical.ts';
import { normalizeSearchParams } from '../src/core/search/params.ts';
import { SEARCH_PROPERTIES } from '../src/core/search/schema.ts';
import {
  bestExactPriority,
  bestPhrasePriority,
  identityPhraseCandidates,
} from '../src/core/search/ranking/identity.ts';
import {
  bm25BoundKey,
  compareCanonicalBm25Terms,
  exactDominanceLambda,
  identityScoreFromExactPriority,
  rerankCandidatesWithSignals,
} from '../src/core/search/ranking/score.ts';
import { buildCanonicalSearchSnapshot } from '../src/daemon/search-store/builder.ts';
import { executeSearchJob } from '../src/daemon/search-execution.ts';
import { fieldChannelBm25Boost } from '../src/core/search/retrieval/positional/bm25.ts';
import { findPhraseMatches } from '../src/core/search/retrieval/positional/postings.ts';
import { findProximityMatches } from '../src/core/search/retrieval/positional/proximity.ts';
import { POSITIONAL_FIELD_BY_ID, POSITIONAL_FIELD_ID } from '../src/core/search/retrieval/positional/types.ts';

function testAnalyzer() {
  const tokenize = (text) =>
    [
      ...text
        .normalize('NFKC')
        .toLowerCase()
        .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
    ].map((match) => match[0]);
  return {
    identity: { name: 'test-analyzer', version: '1', node: 'test' },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map((text) => tokenize(text)),
  };
}

function tempRoot(prefix = 'optsidian-search-batch2-parity-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sharedHandle(bytes) {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { buffer, byteOffset: 0, byteLength: bytes.byteLength };
}

function bm25StatsFromManifest(manifest) {
  return {
    schemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((entry) => ({
      channel: entry.channel,
      fieldId: entry.fieldId,
      documentCount: entry.documentCount,
      totalFieldLength: entry.totalFieldLength,
      averageFieldLength: entry.documentCount > 0 ? entry.totalFieldLength / entry.documentCount : 0,
    })),
    rows: manifest.bm25GlobalStatsRows.map((row) => ({
      channel: row[0],
      fieldId: row[1],
      term: row[2],
      documentFrequency: row[3],
    })),
    hash: manifest.bm25GlobalStatsHash,
  };
}

function testQueryAnalysis(raw) {
  const terms = [
    ...raw
      .normalize('NFKC')
      .toLowerCase()
      .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
  ].map((match) => match[0]);
  return {
    raw,
    primaryChannel: 'morph',
    primaryTerms: terms,
    channels: { morph: terms, surface: terms, ngram: [] },
  };
}

test('AC3 bytes-in-place monolithic path matches the pre-Batch-2 decoded monolithic path', async () => {
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha Calibration.md', '# Alpha Calibration\n\nPrimary exact target for alpha calibration.\n');
  writeVaultFile(vault, 'Ops/Alpha Calibration.md', '# Ops Note\n\nFilename exact target for alpha calibration.\n');
  writeVaultFile(vault, 'Alpha Calibration Guide.md', '# Alpha Calibration Guide\n\nPhrase title target.\n');
  writeVaultFile(
    vault,
    'Research/Calibration Notes.md',
    '# Calibration Notes\n\nNeedle project alpha calibration body evidence.\n',
  );
  writeVaultFile(
    vault,
    'Needle Project.md',
    '---\ntags: [focus]\n---\n# Needle Project\n\nNeedle project body evidence.\n',
  );

  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: 'pin-parity',
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes),
    })),
  };

  for (const rawQuery of ['alpha calibration', 'needle project', 'calibration']) {
    const analysis = testQueryAnalysis(rawQuery);
    const search = normalizeSearchParams({ query: rawQuery, limit: 5, debug: true });
    const fresh = executeSearchJob({
      vault,
      search,
      analysis,
      analyzerIdentity: analyzer.identity,
      snapshot,
    });
    const legacy = legacyDecodedSearch(built, snapshot.bm25Stats, search, analysis);
    const freshRows = fresh.matches.map((match) => ({
      path: match.path,
      score: match.debug?.rerankScore,
    }));
    assert.deepEqual(freshRows, legacy, `decoded parity for ${rawQuery}`);
  }
});

function legacyDecodedSearch(built, bm25Stats, search, analysis) {
  const state = legacyDecodedState(built);
  const fields = search.fields ?? [...SEARCH_PROPERTIES];
  const candidateLimit = positionalCandidateLimit(state.documents.length, search, analysis.channels);
  const candidateSet = legacyRetrieve(state, bm25Stats, analysis, fields, candidateLimit, built.snapshotId);
  const hits = candidateSet.candidates
    .map((candidate) => {
      const record = state.recordsByDocumentId.get(candidate.documentId);
      if (!record) return undefined;
      return {
        document: {
          id: record.documentId,
          path: record.path,
          title: record.title,
          tags: record.tags,
        },
        score: candidate.retrievalScore,
        queryChannels: analysis.channels,
        candidate,
      };
    })
    .filter(Boolean);
  const rerankCandidateSet = {
    ...candidateSet,
    candidates: candidateSet.candidates.filter((candidate) =>
      hits.some((hit) => hit.candidate.candidateId === candidate.candidateId),
    ),
  };
  const signals = legacyRankSignals(state, bm25Stats, rerankCandidateSet, hits, search, analysis);
  const ranked = rerankCandidatesWithSignals(analysis.raw, analysis.primaryTerms, hits, search.fields, signals).slice(
    0,
    search.limit,
  );
  return ranked.map((rank) => ({ path: rank.path, score: rank.score }));
}

function legacyDecodedState(built) {
  const recordsByDocumentId = new Map(built.documents.map((record) => [record.documentId, record]));
  const documents = [];
  const fieldTextByDocId = new Map();
  const postingsByChannel = Object.fromEntries(SEARCH_TOKEN_CHANNELS.map((channel) => [channel, new Map()]));
  const lengthsByChannel = Object.fromEntries(SEARCH_TOKEN_CHANNELS.map((channel) => [channel, new Map()]));
  let nextDocId = 1;
  for (const segment of built.segments) {
    const decoded = decodeCanonicalSegment(segment.bytes);
    const localToGlobal = new Map();
    for (const [index, document] of (decoded.documents ?? []).entries()) {
      const docId = nextDocId++;
      localToGlobal.set(index + 1, docId);
      documents.push({
        docId,
        documentId: document.documentId,
        path: document.path,
        documentKey: document.path,
      });
    }
    for (const fieldText of decoded.fieldTexts ?? []) {
      const globalDocId = localToGlobal.get(fieldText.docId);
      const field = POSITIONAL_FIELD_BY_ID[fieldText.fieldId];
      if (!globalDocId || !field) continue;
      const fields = fieldTextByDocId.get(globalDocId) ?? new Map();
      fields.set(field, fieldText.text);
      fieldTextByDocId.set(globalDocId, fields);
    }
    for (const fieldStats of decoded.bm25 ?? []) {
      const channelLengths = lengthsByChannel[fieldStats.channel] ?? new Map();
      const fieldLengths = channelLengths.get(fieldStats.fieldId) ?? new Map();
      for (const length of fieldStats.documentLengths) {
        const globalDocId = localToGlobal.get(length.docId);
        if (globalDocId) fieldLengths.set(globalDocId, length.length);
      }
      channelLengths.set(fieldStats.fieldId, fieldLengths);
      lengthsByChannel[fieldStats.channel] = channelLengths;
    }
    for (const posting of decoded.postings) {
      const parsed = splitCanonicalPostingTerm(posting.term);
      if (!parsed) continue;
      const globalDocId = localToGlobal.get(posting.docId);
      if (!globalDocId) continue;
      const channelPostings = postingsByChannel[parsed.channel];
      const postings = channelPostings.get(parsed.term) ?? [];
      postings.push({ docId: globalDocId, fieldId: posting.fieldId, positions: posting.positions });
      channelPostings.set(parsed.term, postings);
    }
  }
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    postingsByChannel[channel] = new Map(
      [...postingsByChannel[channel].entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([term, postings]) => [
          term,
          postings.sort((left, right) => left.docId - right.docId || left.fieldId - right.fieldId),
        ]),
    );
  }
  return {
    recordsByDocumentId,
    documents: documents.sort((left, right) => left.docId - right.docId),
    fieldTextByDocId,
    postingsByChannel,
    lengthsByChannel,
  };
}

function legacyRetrieve(state, bm25Stats, analysis, fields, limit, snapshotId) {
  const builders = new Map();
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const terms = analysis.channels[channel].map((term) => term.normalize('NFC').trim()).filter(Boolean);
    if (terms.length === 0) continue;
    const scored = legacyScoreChannel(state, bm25Stats, channel, terms, fields);
    scored.forEach((entry, index) => {
      const rank = index + 1;
      const builder = legacyCandidateBuilder(state, builders, entry.docId);
      const weightedScore = SEARCH_TOKEN_CHANNEL_WEIGHT[channel] * entry.score;
      builder.retrievalScore += weightedScore;
      builder.channels.push({
        channel,
        rank,
        score: entry.score,
        weightedScore,
        matchedTerms: entry.matchedTerms,
        fieldScores: entry.fieldScores,
      });
    });
    const postings = state.postingsByChannel[channel];
    for (const phraseMatch of findPhraseMatches(postings, terms, {
      fieldIds: fields.map((field) => POSITIONAL_FIELD_ID[field]),
    })) {
      legacyCandidateBuilder(state, builders, phraseMatch.docId).phraseMatches.push({
        channel,
        field: POSITIONAL_FIELD_BY_ID[phraseMatch.fieldId],
        fieldId: phraseMatch.fieldId,
        starts: phraseMatch.starts,
      });
    }
    for (const proximityMatch of findProximityMatches(postings, terms, {
      fieldIds: fields.map((field) => POSITIONAL_FIELD_ID[field]),
    })) {
      legacyCandidateBuilder(state, builders, proximityMatch.docId).proximityMatches.push({
        channel,
        field: POSITIONAL_FIELD_BY_ID[proximityMatch.fieldId],
        fieldId: proximityMatch.fieldId,
        score: proximityMatch.score,
        window: proximityMatch.window,
      });
    }
  }
  return {
    schemaVersion: 1,
    snapshotId,
    retrieverIdentity: { id: 'legacy-decoded-parity', version: 'pre-batch-2' },
    complete: true,
    candidates: [...builders.values()]
      .sort((left, right) => right.retrievalScore - left.retrievalScore || left.path.localeCompare(right.path))
      .slice(0, limit)
      .map((candidate, index) => ({
        ...candidate,
        rank: index + 1,
        channels: candidate.channels.sort(
          (left, right) => left.rank - right.rank || left.channel.localeCompare(right.channel),
        ),
        phraseMatches: candidate.phraseMatches,
        proximityMatches: candidate.proximityMatches,
      })),
  };
}

function legacyScoreChannel(state, bm25Stats, channel, terms, fields) {
  const matchedByDocument = new Map();
  const allowedFieldIds = new Set(fields.map((field) => POSITIONAL_FIELD_ID[field]));
  for (const term of terms) {
    for (const posting of state.postingsByChannel[channel].get(term) ?? []) {
      if (!allowedFieldIds.has(posting.fieldId)) continue;
      const fieldsById = matchedByDocument.get(posting.docId) ?? new Map();
      const termFrequencies = fieldsById.get(posting.fieldId) ?? new Map();
      termFrequencies.set(term, posting.positions.length);
      fieldsById.set(posting.fieldId, termFrequencies);
      matchedByDocument.set(posting.docId, fieldsById);
    }
  }
  const scored = [];
  for (const [docId, fieldsById] of matchedByDocument) {
    const fieldScores = [];
    for (const field of fields) {
      const fieldId = POSITIONAL_FIELD_ID[field];
      const fieldMatched = fieldsById.get(fieldId);
      const matchedTerms = fieldMatched ? terms.filter((term) => fieldMatched.has(term)) : [];
      if (matchedTerms.length === 0) continue;
      const rawScore = matchedTerms.reduce(
        (sum, term) =>
          sum + legacyBm25TermScore(bm25Stats, state, channel, term, docId, fieldId, fieldMatched.get(term) ?? 0),
        0,
      );
      if (rawScore <= 0) continue;
      fieldScores.push({ field, fieldId, score: rawScore * fieldChannelBm25Boost(channel, field) });
    }
    const score = fieldScores.reduce((sum, fieldScore) => sum + fieldScore.score, 0);
    if (score > 0) {
      scored.push({
        docId,
        score,
        matchedTerms: terms.filter((term) => [...fieldsById.values()].some((fieldMatched) => fieldMatched.has(term))),
        fieldScores,
      });
    }
  }
  return scored.sort(
    (left, right) =>
      right.score - left.score ||
      legacyDocumentKey(state, left.docId).localeCompare(legacyDocumentKey(state, right.docId)),
  );
}

function legacyCandidateBuilder(state, builders, docId) {
  const existing = builders.get(docId);
  if (existing) return existing;
  const document = state.documents.find((entry) => entry.docId === docId);
  const builder = {
    candidateId: document.documentId,
    documentId: document.documentId,
    ordinalDocId: docId,
    path: document.path,
    retrievalScore: 0,
    channels: [],
    phraseMatches: [],
    proximityMatches: [],
  };
  builders.set(docId, builder);
  return builder;
}

function legacyRankSignals(state, bm25Stats, candidateSet, hits, search, analysis) {
  const fields = search.fields ?? [...SEARCH_PROPERTIES];
  const context = featureQueryContext(analysis.raw, analysis.primaryTerms, analysis.channels, fields);
  const exactLambda = exactDominanceLambda({
    channelTermCounts: queryChannelTermCounts(analysis.channels),
    fields,
    bm25SingleTermBounds: legacyBm25SingleTermBounds(state, bm25Stats),
  }).lambdaExact;
  const signals = new Map();
  for (const hit of hits) {
    const candidate = hit.candidate;
    const identityDocument = legacyIdentityDocument(state, candidate, hit.document);
    const coverage = legacyProjectionCoverage(state, candidate, context);
    const exactPriority = bestExactPriority(identityDocument, context);
    signals.set(hit.document.id, {
      exactPriority,
      phrasePriority: bestPhrasePriority(identityDocument, context),
      coverageTerms: coverage.terms,
      coverageFieldScore: coverage.fieldScore,
      lexicalScore: legacyFeatureLexicalScore(state, bm25Stats, candidate, fields),
      identityScore: identityScoreFromExactPriority(exactPriority),
      exactLambda,
      denseAgreement: 0,
      rarityScore: 0,
      proximityScore: legacyProximityScore(candidate),
      bodyScore: 0,
    });
  }
  void candidateSet;
  return signals;
}

const LEGACY_COVERAGE_FIELDS = ['title', 'aliases', 'tags', 'headings', 'path'];
const WEAK_METADATA_COVERAGE_TERM_SET = new Set(WEAK_METADATA_COVERAGE_TERMS);

function legacyProjectionCoverage(state, candidate, context) {
  if (context.terms.length === 0 && SEARCH_TOKEN_CHANNELS.every((channel) => context.channels[channel].length === 0)) {
    return { terms: 0, fieldScore: 0 };
  }

  let matchedTerms = 0;
  let fieldScore = 0;
  const surfaceTerms = new Set(context.channels.surface);
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const terms = context.channels[channel];
    if (terms.length === 0) continue;
    const channelWeight = SEARCH_TOKEN_CHANNEL_WEIGHT[channel];
    for (const term of terms) {
      if (WEAK_METADATA_COVERAGE_TERM_SET.has(term)) continue;
      if (channel === 'morph' && /[\uac00-\ud7af]/u.test(term) && !surfaceTerms.has(term)) continue;
      let matched = false;
      for (const field of LEGACY_COVERAGE_FIELDS) {
        if (!context.allowed.has(field)) continue;
        const fieldId = POSITIONAL_FIELD_ID[field];
        const postings = state.postingsByChannel[channel].get(term) ?? [];
        if (!postings.some((entry) => entry.docId === candidate.ordinalDocId && entry.fieldId === fieldId)) continue;
        matched = true;
        fieldScore += COVERAGE_FIELD_WEIGHT[field] * channelWeight;
      }
      if (matched) matchedTerms += channelWeight;
    }
  }

  return { terms: matchedTerms, fieldScore };
}

function legacyIdentityDocument(state, candidate, document) {
  const fields = state.fieldTextByDocId.get(candidate.ordinalDocId) ?? new Map();
  return {
    path: fields.get('path') ?? document.path,
    title: fields.get('title') ?? document.title,
    aliases: splitFieldLines(fields.get('aliases')),
    headings: splitFieldLines(fields.get('headings')),
    bodySurfaceTokens: '',
  };
}

function splitFieldLines(value) {
  return value ? value.split('\n').filter(Boolean) : [];
}

function legacyBm25TermScore(bm25Stats, state, channel, term, docId, fieldId, frequency) {
  const corpus = bm25Stats.corpusStats.find((entry) => entry.channel === channel && entry.fieldId === fieldId);
  const fieldLength = state.lengthsByChannel[channel]?.get(fieldId)?.get(docId) ?? 0;
  const documentFrequency = bm25DocumentFrequency(bm25Stats, channel, term, fieldId);
  if (!corpus || frequency <= 0 || fieldLength <= 0 || documentFrequency <= 0 || corpus.averageFieldLength <= 0)
    return 0;
  const idf = Math.log((corpus.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1);
  const tf = frequency / fieldLength;
  return (idf * (0.5 + tf * (1.2 + 1))) / (tf + 1.2 * (1 - 0.75 + (0.75 * fieldLength) / corpus.averageFieldLength));
}

function legacyFeatureLexicalScore(state, bm25Stats, candidate, fields) {
  const contributions = [];
  for (const channelRank of candidate.channels) {
    for (const term of channelRank.matchedTerms) {
      for (const field of fields) {
        const fieldId = POSITIONAL_FIELD_ID[field];
        const frequency =
          state.postingsByChannel[channelRank.channel]
            .get(term)
            ?.find((entry) => entry.docId === candidate.ordinalDocId && entry.fieldId === fieldId)?.positions.length ??
          0;
        if (frequency <= 0) continue;
        contributions.push({
          channel: channelRank.channel,
          fieldId,
          term,
          value:
            legacyBm25TermScore(
              bm25Stats,
              state,
              channelRank.channel,
              term,
              candidate.ordinalDocId,
              fieldId,
              frequency,
            ) *
            SEARCH_TOKEN_CHANNEL_WEIGHT[channelRank.channel] *
            fieldChannelBm25Boost(channelRank.channel, field),
        });
      }
    }
  }
  contributions.sort(compareCanonicalBm25Terms);
  return contributions.reduce((sum, entry) => sum + entry.value, 0);
}

function bm25DocumentFrequency(bm25Stats, channel, term, fieldId) {
  return (
    bm25Stats.rows.find((entry) => entry.channel === channel && entry.fieldId === fieldId && entry.term === term)
      ?.documentFrequency ?? 0
  );
}

function legacyBm25SingleTermBounds(state, bm25Stats) {
  const bounds = new Map();
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    for (const field of SEARCH_PROPERTIES) bounds.set(bm25BoundKey(channel, field), 0);
  }
  for (const row of bm25Stats.rows) {
    const field = POSITIONAL_FIELD_BY_ID[row.fieldId];
    if (!field) continue;
    const key = bm25BoundKey(row.channel, field);
    let maxScore = bounds.get(key) ?? 0;
    for (const posting of state.postingsByChannel[row.channel].get(row.term) ?? []) {
      if (posting.fieldId !== row.fieldId) continue;
      const score = legacyBm25TermScore(
        bm25Stats,
        state,
        row.channel,
        row.term,
        posting.docId,
        row.fieldId,
        posting.positions.length,
      );
      if (score > maxScore) maxScore = score;
    }
    bounds.set(key, maxScore);
  }
  return bounds;
}

function queryChannelTermCounts(channels) {
  return Object.fromEntries(SEARCH_TOKEN_CHANNELS.map((channel) => [channel, new Set(channels[channel]).size]));
}

function legacyDocumentKey(state, docId) {
  return state.documents.find((entry) => entry.docId === docId)?.documentKey ?? String(docId);
}

function legacyProximityScore(candidate) {
  let score = 0;
  for (const match of candidate.proximityMatches) {
    score += match.score;
  }
  return score;
}

function featureQueryContext(query, queryTerms, queryChannels, fields) {
  const phrases = [
    ...new Set([...identityPhraseCandidates(query), ...identityPhraseCandidates(queryTerms.join(' '))].filter(Boolean)),
  ];
  return {
    phrase: phrases[0] ?? '',
    phrases,
    terms: queryTerms,
    channels: normalizedQueryChannels(queryTerms, queryChannels),
    allowed: new Set(fields),
  };
}

function normalizedQueryChannels(queryTerms, queryChannels) {
  const channels = { morph: [], surface: [], ngram: [] };
  for (const channel of SEARCH_TOKEN_CHANNELS) channels[channel] = uniqueSearchTerms(queryChannels?.[channel] ?? []);
  if (SEARCH_TOKEN_CHANNELS.some((channel) => channels[channel].length > 0)) return channels;
  channels.morph = uniqueSearchTerms(queryTerms);
  return channels;
}

function splitCanonicalPostingTerm(value) {
  const separator = value.indexOf('\u0000');
  if (separator < 1) return undefined;
  const channel = value.slice(0, separator);
  if (!SEARCH_TOKEN_CHANNELS.includes(channel)) return undefined;
  return { channel, term: value.slice(separator + 1) };
}

function positionalCandidateLimit(documentCount, search, channels) {
  const perChannelLimit = search.query
    ? Math.min(documentCount, Math.max(search.limit * CANDIDATE_LIMIT_MULTIPLIER, CANDIDATE_LIMIT_MIN))
    : search.limit;
  if (!search.query) return perChannelLimit;
  const channelCount = SEARCH_TOKEN_CHANNELS.filter((channel) => channels[channel].length > 0).length || 1;
  return Math.min(documentCount, perChannelLimit * channelCount);
}
