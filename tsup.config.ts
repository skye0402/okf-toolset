import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'fs/index': 'src/fs/index.ts',
    'embeddings/index': 'src/embeddings/index.ts',
    'search/index': 'src/search/index.ts',
    'mcp/index': 'src/mcp/index.ts',
    'refiner/index': 'src/refiner/index.ts',
    'git/index': 'src/git/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
});
