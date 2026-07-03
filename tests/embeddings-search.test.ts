import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileOkfStore } from '../src/fs/index.js';
import { conceptContentHash, cosineSimilarity, openEmbeddingIndex, rebuildEmbeddingCache, type EmbeddingProvider } from '../src/embeddings/index.js';
import { OkfSearchEngine } from '../src/search/index.js';

const provider: EmbeddingProvider = {
  modelId: 'mock',
  dimensions: 3,
  async embedTexts(texts: string[]) {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return [lower.includes('sales') ? 1 : 0, lower.includes('customer') ? 1 : 0, lower.length / 1000];
    });
  },
};

describe('embeddings and search', () => {
  it('builds JSONL cache and loads vector index once', async () => {
    const store = new FileOkfStore(path.resolve('tests/fixtures/minimal'));
    const cachePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'okf-cache-')), 'embeddings.jsonl');
    const rows = await rebuildEmbeddingCache(await store.scanBundle(), provider, { cachePath });
    expect(rows.length).toBe(2);
    const index = await openEmbeddingIndex(cachePath);
    const results = await index.search([1, 1, 0], { limit: 1 });
    expect(results[0]?.conceptId).toBeTruthy();
  });

  it('has stable selected content hashes and incremental cache pruning', async () => {
    const store = new FileOkfStore(path.resolve('tests/fixtures/minimal'));
    const concepts = await store.scanBundle();
    const orders = concepts.find((concept) => concept.conceptId === 'orders')!;
    expect(conceptContentHash({ ...orders, frontmatter: { ...orders.frontmatter, status: 'ignored' } })).toBe(conceptContentHash(orders));
    expect(conceptContentHash({ ...orders, body: `${orders.body}\nchanged` })).not.toBe(conceptContentHash(orders));
    const cachePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'okf-cache-')), 'embeddings.jsonl');
    const first = await rebuildEmbeddingCache(concepts, provider, { cachePath });
    const second = await rebuildEmbeddingCache(concepts.slice(0, 1), provider, { cachePath, incremental: true });
    expect(second.length).toBe(1);
    expect(second[0]?.updatedAt).toBe(first.find((row) => row.conceptId === second[0]?.conceptId)?.updatedAt);
  });

  it('throws on vector dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow(/dimension mismatch/);
  });

  it('supports keyword and hybrid search with transparent scores', async () => {
    const store = new FileOkfStore(path.resolve('tests/fixtures/minimal'));
    const cachePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'okf-cache-')), 'embeddings.jsonl');
    await rebuildEmbeddingCache(await store.scanBundle(), provider, { cachePath });
    const index = await openEmbeddingIndex(cachePath);
    const engine = new OkfSearchEngine(store, { embeddingProvider: provider, vectorIndex: index });
    const keyword = await engine.search('completed customer order', { mode: 'keyword' });
    expect(keyword[0]?.conceptId).toBe('orders');
    const hybrid = await engine.search('sales customer', { mode: 'hybrid' });
    expect(hybrid[0]?.scores.embedding).toBeTypeOf('number');
    expect(hybrid[0]?.scores.combined).toBeGreaterThan(0);
  });

  it('normalizes vector pathPrefix filters', async () => {
    const store = new FileOkfStore(path.resolve('tests/fixtures/minimal'));
    const cachePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'okf-cache-')), 'embeddings.jsonl');
    await rebuildEmbeddingCache(await store.scanBundle(), provider, { cachePath });
    const index = await openEmbeddingIndex(cachePath);
    expect((await index.search([1, 1, 0], { pathPrefix: '/orders.md' })).length).toBe(1);
  });
});
