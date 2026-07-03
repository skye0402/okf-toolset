# okf-toolset

TypeScript toolkit for Open Knowledge Format (OKF) v0.1 bundles. The current OKF draft spec is published in the Google Cloud Platform knowledge-catalog repository at `okf/SPEC.md`.

`okf-toolset` is filesystem-first: Markdown files with YAML frontmatter are the source of truth and can be versioned in Git. Embeddings, search indexes, MCP tools, and Git history helpers are library extensions around that source of truth, not OKF conformance requirements.

## Status

Published as [`okf-toolset`](https://www.npmjs.com/package/okf-toolset). Early v0.1 implementation, intended for Node.js/server-side use with ESM.

## Install

```bash
npm install okf-toolset
```

`okf-toolset` is ESM-only and requires Node.js 20 or newer.

```ts
import { parseConcept, DefaultOkfToolbox } from 'okf-toolset';
import { FileOkfStore } from 'okf-toolset/fs';
import { rebuildEmbeddingCache } from 'okf-toolset/embeddings';
import { OkfSearchEngine } from 'okf-toolset/search';
import { registerOkfTools } from 'okf-toolset/mcp';
import { OkfRefiner } from 'okf-toolset/refiner';
import { OkfGitHelper } from 'okf-toolset/git';
```

## Design

- **Core OKF**: parse, render, validate, normalize concept IDs, resolve links, extract citations.
- **Filesystem store**: scan/list/get/write/delete concepts, append OKF logs, manage drafts.
- **Refiner**: create/move/delete/update concepts, rewrite links, regenerate indexes.
- **Embeddings**: injectable provider interface plus rebuildable JSONL cache.
- **Search**: keyword, embedding, and deterministic hybrid search.
- **MCP**: register OKF tools on a host-owned MCP server; transport is not owned here.
- **Git**: optional history/diff/blame helpers; Git history is not part of `OkfConcept`.

## OKF conformance vs extensions

OKF v0.1 conformance is intentionally small: non-reserved `.md` files need parseable YAML frontmatter and a non-empty `type`. Unknown frontmatter fields are preserved. Missing indexes, unknown types, and broken links are tolerated by default.

This library adds producer-defined extensions such as drafts, `status`, `source_run`, `proposed_type`, `startup_policy`, embeddings, and Git helpers. These are useful operationally but not required by OKF.

## Filesystem and Git

The OKF bundle on disk is the canonical store. Git is recommended for versioning, diffs, attribution, review, and rollback, but the library works without Git. `/git` helpers are optional and never commit or push unless explicitly called by the host application.

## Embeddings

Embeddings are included as a derived cache:

```text
knowledge/
  index.md
  concepts/example.md
.okf-cache/
  embeddings.jsonl
```

The cache can be deleted and rebuilt from the bundle. v1 uses JSONL and in-process cosine search, intended for hundreds to roughly 10k concept-level embeddings. For larger/high-concurrency systems, add a future `VectorIndex` adapter for SQLite, pgvector, HANA vector, Qdrant, etc.

## Write safety

`FileOkfStore` uses an in-process mutex per bundle and atomic temp-file rename. This protects one MCP server process from parallel tool-call races. Multi-process write coordination is out of scope for v1; use a single writer or add a lockfile adapter.

## No watcher in v1

File watching is intentionally out of scope. A future extension can add `chokidar`-based cache invalidation.

## Example

```ts
import { FileOkfStore } from 'okf-toolset/fs';
import { OkfSearchEngine } from 'okf-toolset/search';
import { DefaultOkfToolbox } from 'okf-toolset';

const store = new FileOkfStore('./knowledge');
const engine = new OkfSearchEngine(store);
const toolbox = new DefaultOkfToolbox(engine);

console.log(await toolbox.search('sales order'));
```

## Embedding example

The library does not ship cloud-provider SDKs. Provide your own embedding adapter and keep the generated cache as rebuildable state.

```ts
import { FileOkfStore } from 'okf-toolset/fs';
import { rebuildEmbeddingCache, openEmbeddingIndex } from 'okf-toolset/embeddings';
import { OkfSearchEngine } from 'okf-toolset/search';

const provider = {
  modelId: 'my-embedding-model',
  dimensions: 1536,
  async embedTexts(texts: string[]) {
    // Call OpenAI, SAP GenAI Hub, Vertex, a local model, etc.
    return texts.map(() => new Array(1536).fill(0));
  },
};

const store = new FileOkfStore('./knowledge');
await rebuildEmbeddingCache(await store.scanBundle(), provider, {
  cachePath: '.okf-cache/embeddings.jsonl',
  incremental: true,
});

const vectorIndex = await openEmbeddingIndex('.okf-cache/embeddings.jsonl');
const engine = new OkfSearchEngine(store, { embeddingProvider: provider, vectorIndex });

console.log(await engine.search('sales order playbook', { mode: 'hybrid' }));
```

## MCP example

`okf-toolset/mcp` registers tools on a host-owned MCP server. The host still chooses stdio, Streamable HTTP, auth, and deployment.

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DefaultOkfToolbox } from 'okf-toolset';
import { FileOkfStore } from 'okf-toolset/fs';
import { registerOkfTools } from 'okf-toolset/mcp';
import { OkfSearchEngine } from 'okf-toolset/search';

const server = new McpServer({ name: 'okf', version: '0.1.0' });
const store = new FileOkfStore('./knowledge');
const toolbox = new DefaultOkfToolbox(new OkfSearchEngine(store));

registerOkfTools(server, toolbox, { store });
```

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run check
```

## Migration from the Python prototype

- `memory.py` maps to core, filesystem store, and drafts.
- `okf_tools.py` maps to `DefaultOkfToolbox`, search, and context rendering.
- `okf_mcp_server.py` maps to `registerOkfTools`.
- `refiner/*` maps to `/refiner` operations.
