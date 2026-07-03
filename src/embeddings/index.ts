import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OkfConcept } from '../core/types.js';
import { normalizeConceptId } from '../core/paths.js';

export interface EmbeddingProvider {
  modelId: string;
  dimensions?: number;
  maxInputTokens?: number;
  embedTexts(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingCacheRow {
  conceptId: string;
  path: string;
  contentHash: string;
  modelId: string;
  dimension: number;
  embedding: number[];
  metadata: {
    type: string;
    title?: string;
    description?: string;
    tags: string[];
    timestamp?: string;
  };
  updatedAt: string;
}

export interface VectorSearchOptions {
  limit?: number;
  type?: string | string[];
  tags?: string[];
  pathPrefix?: string;
  includeDrafts?: boolean;
}

export interface VectorSearchResult {
  conceptId: string;
  path: string;
  score: number;
  metadata: EmbeddingCacheRow['metadata'];
}

export interface VectorIndex {
  search(vector: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  close?(): Promise<void>;
}

export interface RebuildEmbeddingCacheOptions {
  cachePath?: string;
  maxBodyChars?: number;
  incremental?: boolean;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortDeep(entry)]));
  }
  return value;
}

export function conceptContentHash(concept: OkfConcept): string {
  const selectedFrontmatter = {
    type: concept.type,
    title: concept.title,
    description: concept.description,
    resource: concept.resource,
    tags: concept.tags,
  };
  return createHash('sha256').update(`${canonicalJson(selectedFrontmatter)}\n${concept.body.trim()}`).digest('hex');
}

export function buildConceptEmbeddingText(concept: OkfConcept, options: { maxBodyChars?: number; provider?: Pick<EmbeddingProvider, 'maxInputTokens'> } = {}): string {
  const maxBodyChars = options.maxBodyChars ?? (options.provider?.maxInputTokens ? Math.max(1000, options.provider.maxInputTokens * 4) : 4000);
  const body = concept.body.replace(/\s+/g, ' ').trim().slice(0, maxBodyChars);
  return [
    `concept_id: ${concept.conceptId}`,
    `type: ${concept.type}`,
    concept.title ? `title: ${concept.title}` : '',
    concept.description ? `description: ${concept.description}` : '',
    concept.resource ? `resource: ${concept.resource}` : '',
    concept.tags.length ? `tags: ${concept.tags.join(', ')}` : '',
    `body: ${body}`,
  ].filter(Boolean).join('\n');
}

export async function rebuildEmbeddingCache(concepts: OkfConcept[], provider: EmbeddingProvider, options: RebuildEmbeddingCacheOptions = {}): Promise<EmbeddingCacheRow[]> {
  const cachePath = options.cachePath ?? path.join('.okf-cache', 'embeddings.jsonl');
  const textOptions: { maxBodyChars?: number; provider?: Pick<EmbeddingProvider, 'maxInputTokens'> } = { provider };
  if (options.maxBodyChars !== undefined) textOptions.maxBodyChars = options.maxBodyChars;
  const existingRows = options.incremental ? await readEmbeddingCache(cachePath) : [];
  const existingByConcept = new Map(existingRows.filter((row) => row.modelId === provider.modelId).map((row) => [row.conceptId, row]));
  const conceptIds = new Set(concepts.map((concept) => concept.conceptId));
  const rows: EmbeddingCacheRow[] = [];
  const changedConcepts: OkfConcept[] = [];

  for (const concept of concepts) {
    const contentHash = conceptContentHash(concept);
    const existing = existingByConcept.get(concept.conceptId);
    if (existing && existing.contentHash === contentHash && existing.modelId === provider.modelId && (provider.dimensions === undefined || existing.dimension === provider.dimensions)) {
      rows.push(existing);
    } else {
      changedConcepts.push(concept);
    }
  }

  const texts = changedConcepts.map((concept) => buildConceptEmbeddingText(concept, textOptions));
  const vectors = texts.length ? await provider.embedTexts(texts) : [];
  rows.push(...changedConcepts.map((concept, index): EmbeddingCacheRow => {
    const embedding = vectors[index];
    if (!embedding) throw new Error(`missing embedding for ${concept.conceptId}`);
    if (provider.dimensions !== undefined && embedding.length !== provider.dimensions) {
      throw new Error(`embedding dimension mismatch for ${concept.conceptId}: expected ${provider.dimensions}, got ${embedding.length}`);
    }
    return {
      conceptId: concept.conceptId,
      path: concept.path,
      contentHash: conceptContentHash(concept),
      modelId: provider.modelId,
      dimension: embedding.length,
      embedding,
      metadata: {
        type: concept.type,
        ...(concept.title ? { title: concept.title } : {}),
        ...(concept.description ? { description: concept.description } : {}),
        tags: concept.tags,
        ...(concept.timestamp ? { timestamp: concept.timestamp } : {}),
      },
      updatedAt: new Date().toISOString(),
    };
  }));
  const prunedRows = rows
    .filter((row) => conceptIds.has(row.conceptId))
    .sort((a, b) => a.conceptId.localeCompare(b.conceptId));
  await writeEmbeddingCache(cachePath, prunedRows);
  return prunedRows;
}

export async function writeEmbeddingCache(cachePath: string, rows: EmbeddingCacheRow[]): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

export async function readEmbeddingCache(cachePath: string): Promise<EmbeddingCacheRow[]> {
  const text = await readFile(cachePath, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as EmbeddingCacheRow);
}

export async function openEmbeddingIndex(cachePath: string): Promise<VectorIndex> {
  return new JsonlVectorIndex(await readEmbeddingCache(cachePath));
}

export class JsonlVectorIndex implements VectorIndex {
  constructor(readonly rows: EmbeddingCacheRow[]) {}

  async search(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const limit = options.limit ?? 10;
    return this.rows
      .filter((row) => matchesVectorFilter(row, options))
      .map((row) => ({ conceptId: row.conceptId, path: row.path, score: cosineSimilarity(vector, row.embedding), metadata: row.metadata }))
      .sort((a, b) => b.score - a.score || a.conceptId.localeCompare(b.conceptId))
      .slice(0, limit);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`vector dimension mismatch: ${a.length} != ${b.length}`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function matchesVectorFilter(row: EmbeddingCacheRow, options: VectorSearchOptions): boolean {
  if (!options.includeDrafts && row.conceptId.split('/').includes('drafts')) return false;
  if (options.type) {
    const allowed = Array.isArray(options.type) ? options.type : [options.type];
    if (!allowed.includes(row.metadata.type)) return false;
  }
  if (options.tags?.length && !options.tags.every((tag) => row.metadata.tags.includes(tag))) return false;
  if (options.pathPrefix) {
    const normalizedPrefix = normalizeConceptId(options.pathPrefix);
    if (!row.conceptId.startsWith(normalizedPrefix)) return false;
  }
  return true;
}
