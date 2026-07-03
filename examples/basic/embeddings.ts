import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileOkfStore } from '../../src/fs/index.js';
import { openEmbeddingIndex, rebuildEmbeddingCache, type EmbeddingProvider } from '../../src/embeddings/index.js';
import { OkfSearchEngine } from '../../src/search/index.js';

const provider: EmbeddingProvider = {
  modelId: 'mock',
  dimensions: 2,
  async embedTexts(texts) {
    return texts.map((text) => [text.toLowerCase().includes('order') ? 1 : 0, text.length / 1000]);
  },
};

const store = new FileOkfStore('tests/fixtures/minimal');
const cachePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'okf-example-')), 'embeddings.jsonl');
await rebuildEmbeddingCache(await store.scanBundle(), provider, { cachePath });
const vectorIndex = await openEmbeddingIndex(cachePath);
const engine = new OkfSearchEngine(store, { embeddingProvider: provider, vectorIndex });
console.log(await engine.search('orders', { mode: 'hybrid' }));
