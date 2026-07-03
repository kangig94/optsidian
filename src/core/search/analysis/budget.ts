const KIB = 1024;
const MIB = 1024 * KIB;

const BODY_SHORT_MAX_CHARS = 64 * KIB;
export const BODY_FULL_ANALYSIS_MAX_CHARS = 512 * KIB;
const BODY_LONG_MAX_CHARS = 2 * MIB;

export const BODY_NGRAM_SHORT_MAX_TERMS = 4096;
const BODY_NGRAM_PAPER_MAX_TERMS = 8192;
const BODY_NGRAM_LONG_MAX_TERMS = 12288;
const BODY_NGRAM_HUGE_MAX_TERMS = 16384;

export const BODY_LEXICAL_SAMPLE_MAX_CHARS = 512 * KIB;
const BODY_NGRAM_LONG_SAMPLE_MAX_CHARS = 384 * KIB;
const BODY_NGRAM_HUGE_SAMPLE_MAX_CHARS = 512 * KIB;
const BODY_SAMPLE_WINDOWS = 32;

const BODY_SURFACE_MAX_TERMS = 50000;
const BODY_MORPH_MAX_TOKENS = 100000;

const SNIPPET_LINE_ANALYSIS_MAX_CHARS = 4096;
export const SNIPPET_LINE_NGRAM_MAX_TERMS = 512;
export const SNIPPET_LINE_SURFACE_MAX_TERMS = 512;
export const SNIPPET_LINE_MORPH_MAX_TERMS = 512;
const SNIPPET_DOC_ANALYZED_CHARS_MAX = 512 * KIB;
export const SNIPPET_DOC_ANALYZED_LINES_MAX = 3000;

type BodyIndexBudgetTier = 'short' | 'paper' | 'long' | 'huge';

export type BodyIndexBudget = {
  tier: BodyIndexBudgetTier;
  bodyLength: number;
  bodyLexicalText: string;
  bodyNgramText: string;
  bodyNgramMaxTerms: number;
  bodySurfaceMaxTerms: number;
  bodyMorphMaxTokens: number;
  snippetLineAnalysisMaxChars: number;
  snippetLineNgramMaxTerms: number;
  snippetLineSurfaceMaxTerms: number;
  snippetLineMorphMaxTerms: number;
  snippetDocMaxAnalyzedChars?: number;
  snippetDocMaxAnalyzedLines?: number;
};

export const BODY_INDEX_BUDGET_IDENTITY = {
  bodyShortMaxChars: BODY_SHORT_MAX_CHARS,
  bodyFullAnalysisMaxChars: BODY_FULL_ANALYSIS_MAX_CHARS,
  bodyLongMaxChars: BODY_LONG_MAX_CHARS,
  bodyNgramMaxTerms: {
    short: BODY_NGRAM_SHORT_MAX_TERMS,
    paper: BODY_NGRAM_PAPER_MAX_TERMS,
    long: BODY_NGRAM_LONG_MAX_TERMS,
    huge: BODY_NGRAM_HUGE_MAX_TERMS,
  },
  bodyLexicalSampleMaxChars: BODY_LEXICAL_SAMPLE_MAX_CHARS,
  bodyNgramSampleMaxChars: {
    long: BODY_NGRAM_LONG_SAMPLE_MAX_CHARS,
    huge: BODY_NGRAM_HUGE_SAMPLE_MAX_CHARS,
  },
  bodySampleWindows: BODY_SAMPLE_WINDOWS,
  bodySurfaceMaxTerms: BODY_SURFACE_MAX_TERMS,
  bodyMorphMaxTokens: BODY_MORPH_MAX_TOKENS,
  snippet: {
    lineAnalysisMaxChars: SNIPPET_LINE_ANALYSIS_MAX_CHARS,
    lineNgramMaxTerms: SNIPPET_LINE_NGRAM_MAX_TERMS,
    lineSurfaceMaxTerms: SNIPPET_LINE_SURFACE_MAX_TERMS,
    lineMorphMaxTerms: SNIPPET_LINE_MORPH_MAX_TERMS,
    docAnalyzedCharsMax: SNIPPET_DOC_ANALYZED_CHARS_MAX,
    docAnalyzedLinesMax: SNIPPET_DOC_ANALYZED_LINES_MAX,
  },
} as const;

export function bodyIndexBudgetForText(body: string): BodyIndexBudget {
  const bodyLength = body.length;
  if (bodyLength <= BODY_SHORT_MAX_CHARS) {
    return bodyIndexBudget({
      tier: 'short',
      bodyLength,
      bodyLexicalText: body,
      bodyNgramText: body,
      bodyNgramMaxTerms: BODY_NGRAM_SHORT_MAX_TERMS,
    });
  }
  if (bodyLength <= BODY_FULL_ANALYSIS_MAX_CHARS) {
    return bodyIndexBudget({
      tier: 'paper',
      bodyLength,
      bodyLexicalText: body,
      bodyNgramText: body,
      bodyNgramMaxTerms: BODY_NGRAM_PAPER_MAX_TERMS,
    });
  }
  if (bodyLength <= BODY_LONG_MAX_CHARS) {
    return bodyIndexBudget({
      tier: 'long',
      bodyLength,
      bodyLexicalText: sampleTextWindows(body, BODY_LEXICAL_SAMPLE_MAX_CHARS, BODY_SAMPLE_WINDOWS),
      bodyNgramText: sampleTextWindows(body, BODY_NGRAM_LONG_SAMPLE_MAX_CHARS, BODY_SAMPLE_WINDOWS),
      bodyNgramMaxTerms: BODY_NGRAM_LONG_MAX_TERMS,
      snippetDocMaxAnalyzedChars: SNIPPET_DOC_ANALYZED_CHARS_MAX,
      snippetDocMaxAnalyzedLines: SNIPPET_DOC_ANALYZED_LINES_MAX,
    });
  }
  return bodyIndexBudget({
    tier: 'huge',
    bodyLength,
    bodyLexicalText: sampleTextWindows(body, BODY_LEXICAL_SAMPLE_MAX_CHARS, BODY_SAMPLE_WINDOWS),
    bodyNgramText: sampleTextWindows(body, BODY_NGRAM_HUGE_SAMPLE_MAX_CHARS, BODY_SAMPLE_WINDOWS),
    bodyNgramMaxTerms: BODY_NGRAM_HUGE_MAX_TERMS,
    snippetDocMaxAnalyzedChars: SNIPPET_DOC_ANALYZED_CHARS_MAX,
    snippetDocMaxAnalyzedLines: SNIPPET_DOC_ANALYZED_LINES_MAX,
  });
}

function sampleTextWindows(text: string, maxChars: number, windows: number): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : text.length;
  if (text.length <= limit) return text;
  if (limit === 0) return '';
  const requestedWindows = Number.isFinite(windows) ? Math.max(1, Math.trunc(windows)) : 1;
  const windowCount = Math.max(1, Math.min(requestedWindows, limit, text.length));
  if (windowCount === 1) return text.slice(0, limit);
  const separatorBudget = windowCount - 1;
  const contentBudget = Math.max(1, limit - separatorBudget);
  const windowSize = Math.max(1, Math.floor(contentBudget / windowCount));
  const maxStart = Math.max(0, text.length - windowSize);
  const chunks: string[] = [];
  for (let index = 0; index < windowCount; index += 1) {
    const start =
      index === 0 ? 0 : index === windowCount - 1 ? maxStart : Math.round((maxStart * index) / (windowCount - 1));
    chunks.push(text.slice(start, start + windowSize));
  }
  return chunks.join('\n').slice(0, limit);
}

function bodyIndexBudget(input: {
  tier: BodyIndexBudgetTier;
  bodyLength: number;
  bodyLexicalText: string;
  bodyNgramText: string;
  bodyNgramMaxTerms: number;
  snippetDocMaxAnalyzedChars?: number;
  snippetDocMaxAnalyzedLines?: number;
}): BodyIndexBudget {
  return {
    tier: input.tier,
    bodyLength: input.bodyLength,
    bodyLexicalText: input.bodyLexicalText,
    bodyNgramText: input.bodyNgramText,
    bodyNgramMaxTerms: input.bodyNgramMaxTerms,
    bodySurfaceMaxTerms: BODY_SURFACE_MAX_TERMS,
    bodyMorphMaxTokens: BODY_MORPH_MAX_TOKENS,
    snippetLineAnalysisMaxChars: SNIPPET_LINE_ANALYSIS_MAX_CHARS,
    snippetLineNgramMaxTerms: SNIPPET_LINE_NGRAM_MAX_TERMS,
    snippetLineSurfaceMaxTerms: SNIPPET_LINE_SURFACE_MAX_TERMS,
    snippetLineMorphMaxTerms: SNIPPET_LINE_MORPH_MAX_TERMS,
    snippetDocMaxAnalyzedChars: input.snippetDocMaxAnalyzedChars ?? SNIPPET_DOC_ANALYZED_CHARS_MAX,
    snippetDocMaxAnalyzedLines: input.snippetDocMaxAnalyzedLines ?? SNIPPET_DOC_ANALYZED_LINES_MAX,
  };
}
