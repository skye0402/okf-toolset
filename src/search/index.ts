import type { EmbeddingProvider, VectorIndex } from '../embeddings/index.js';
import { buildConceptEmbeddingText } from '../embeddings/index.js';
import type { OkfConcept, OkfSearchResult, OkfStore, SearchOptions, SearchWeights } from '../core/types.js';
import { extractCitations, extractOkfLinks } from '../core/links.js';

const DEFAULT_WEIGHTS: SearchWeights = { embedding: 0.6, keyword: 0.35, boost: 0.05 };

export class OkfSearchEngine {
  constructor(readonly store: OkfStore, readonly options: { embeddingProvider?: EmbeddingProvider; vectorIndex?: VectorIndex } = {}) {}

  async search(query: string, options: SearchOptions = {}): Promise<OkfSearchResult[]> {
    const limit = options.limit ?? 10;
    const mode = options.mode ?? (this.options.embeddingProvider && this.options.vectorIndex ? 'hybrid' : 'keyword');
    const concepts = await this.store.listConcepts(options);
    const keywordScores = scoreKeywords(query, concepts);
    const embeddingScores = new Map<string, number>();

    if ((mode === 'embedding' || mode === 'hybrid') && this.options.embeddingProvider && this.options.vectorIndex) {
      const [queryVector] = await this.options.embeddingProvider.embedTexts([query]);
      if (queryVector) {
        const vectorResults = await this.options.vectorIndex.search(queryVector, pickVectorFilter(options));
        for (const result of vectorResults) embeddingScores.set(result.conceptId, normalizeCosine(result.score));
      }
    }

    const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    const results = concepts.map((concept) => buildResult(concept, query, mode, weights, keywordScores.get(concept.conceptId) ?? 0, embeddingScores.get(concept.conceptId)));
    return results
      .filter((result) => result.scores.combined > 0)
      .sort((a, b) => b.scores.combined - a.scores.combined || a.conceptId.localeCompare(b.conceptId))
      .slice(0, limit);
  }

  async context(query: string, options: SearchOptions = {}): Promise<{ context: string; concepts: OkfSearchResult[] }> {
    const concepts = await this.search(query, options);
    if (!concepts.length) return { context: 'No relevant OKF memory was found for this query.', concepts };
    const context = concepts.map((result) => {
      const title = result.title ?? result.conceptId;
      const snippet = result.snippet ? `\n  ${result.snippet}` : '';
      return `- [${title}](${result.conceptId}) (${result.type}) score=${result.scores.combined.toFixed(3)}${snippet}`;
    }).join('\n');
    return { context, concepts };
  }
}

function pickVectorFilter(options: SearchOptions) {
  return {
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.tags !== undefined ? { tags: options.tags } : {}),
    ...(options.pathPrefix !== undefined ? { pathPrefix: options.pathPrefix } : {}),
    ...(options.includeDrafts !== undefined ? { includeDrafts: options.includeDrafts } : {}),
  };
}

export function scoreKeywords(query: string, concepts: OkfConcept[]): Map<string, number> {
  const queryTokens = tokenize(query);
  const rawScores = new Map<string, number>();
  let max = 0;
  for (const concept of concepts) {
    const haystack = [concept.conceptId, concept.type, concept.title, concept.description, concept.resource, concept.tags.join(' '), concept.body].filter(Boolean).join(' ');
    const tokens = tokenize(haystack);
    const overlap = [...queryTokens].filter((token) => tokens.has(token)).length;
    const score = queryTokens.size ? overlap / queryTokens.size : 0;
    rawScores.set(concept.conceptId, score);
    max = Math.max(max, score);
  }
  if (max <= 0) return rawScores;
  return new Map([...rawScores].map(([key, value]) => [key, value / max]));
}

export function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function buildResult(concept: OkfConcept, query: string, mode: OkfSearchResult['mode'], weights: SearchWeights, keyword: number, embedding?: number): OkfSearchResult {
  const boost = recencyBoost(concept) * weights.boost;
  const effectiveEmbedding = embedding ?? 0;
  const combined = mode === 'keyword'
    ? keyword
    : mode === 'embedding'
      ? effectiveEmbedding
      : (effectiveEmbedding * weights.embedding) + (keyword * weights.keyword) + boost;
  return {
    conceptId: concept.conceptId,
    path: concept.path,
    type: concept.type,
    ...(concept.title ? { title: concept.title } : {}),
    snippet: makeSnippet(concept, query),
    mode,
    scores: {
      keyword,
      ...(embedding !== undefined ? { embedding } : {}),
      combined: Math.max(0, Math.min(1, combined)),
    },
    citations: extractCitations(concept.body),
    links: extractOkfLinks(concept.body, concept.conceptId),
  };
}

function normalizeCosine(score: number): number {
  return Math.max(0, Math.min(1, (score + 1) / 2));
}

function recencyBoost(concept: OkfConcept): number {
  if (!concept.timestamp) return 0;
  const time = Date.parse(concept.timestamp);
  if (Number.isNaN(time)) return 0;
  const ageDays = Math.max(0, (Date.now() - time) / 86_400_000);
  return Math.max(0, 1 - ageDays / 365);
}

function makeSnippet(concept: OkfConcept, query: string): string {
  const tokens = [...tokenize(query)];
  const normalized = concept.body.replace(/\s+/g, ' ').trim();
  if (!normalized) return concept.description ?? '';
  const lower = normalized.toLowerCase();
  const hit = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 80);
  return normalized.slice(start, start + 240) + (normalized.length > start + 240 ? '…' : '');
}
