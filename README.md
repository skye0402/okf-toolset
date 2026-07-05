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

## Optional LLM/MCP e2e test

The normal test suite is offline. There is also an opt-in e2e smoke test that exercises an LLM through an in-process MCP-style tool registry:

1. The LLM reads source text and returns `okf_create_draft` tool calls.
2. Drafts are approved into OKF concepts.
3. `okf_context` retrieves the new knowledge for a second LLM answer.
4. An adversarial prompt attempts path traversal / `drafts/` writes and verifies `executeSafely()` rejects it.

SAP GenAI Hub is the preferred provider:

```bash
cp .env.example .env.local
# edit .env.local, then run:
pnpm run test:e2e:llm
```

Equivalent inline SAP GenAI Hub configuration:

```bash
OKF_LLM_PROVIDER=sap-genai-hub \
OKF_LLM_BASE_URL=https://api.ai.prod.<region>.aws.ml.hana.ondemand.com \
OKF_LLM_TOKEN_URL='https://.../oauth/token' \
OKF_LLM_CLIENT_ID='<client-id>' \
OKF_LLM_CLIENT_SECRET='<client-secret>' \
OKF_LLM_MODEL='<deployment-id>' \
pnpm run test:e2e:llm
```

If you already have a bearer token, use `OKF_LLM_API_KEY='<bearer-token>'` instead of `OKF_LLM_TOKEN_URL`, `OKF_LLM_CLIENT_ID`, and `OKF_LLM_CLIENT_SECRET`. If your OAuth server requires a scope, set `OKF_LLM_OAUTH_SCOPE`.

`OKF_LLM_MODEL` may be a SAP GenAI Hub deployment ID, deployment URL, or model name such as `gpt-5.5`. If it is empty, or if it looks like a model name and `OKF_LLM_RESOURCE_GROUP` is set, the e2e test calls `GET /lm/deployments` and selects the first matching HTTP deployment. Optional filters are `OKF_LLM_MODEL_NAME`, `OKF_LLM_SCENARIO_ID`, `OKF_LLM_CONFIGURATION_ID`, `OKF_LLM_EXECUTABLE_IDS` as a comma-separated list, `OKF_LLM_DEPLOYMENT_STATUS`, and `OKF_LLM_DEPLOYMENT_TOP`. Model-name matching uses the deployment payload model name, or `name:version`, for example `gemini-3.5-flash`, `gemini-3.5-flash:001`, or `gpt-5.5`.

LiteLLM, or any OpenAI-compatible `/chat/completions` gateway, can be used as fallback:

```bash
OKF_LLM_PROVIDER=litellm \
OKF_LLM_BASE_URL=http://localhost:4000/v1 \
OKF_LLM_API_KEY='<api-key>' \
OKF_LLM_MODEL='<model-name>' \
pnpm run test:e2e:llm
```

The e2e test is skipped unless `OKF_LLM_E2E=true`; the package script sets that flag automatically. Do not commit real tokens or deployment IDs.

`OKF_LLM_TEMPERATURE` is optional and omitted by default because some SAP-hosted models, including GPT-5.5 deployments, reject non-default temperature values.

## Migration from the Python prototype

- `memory.py` maps to core, filesystem store, and drafts.
- `okf_tools.py` maps to `DefaultOkfToolbox`, search, and context rendering.
- `okf_mcp_server.py` maps to `registerOkfTools`.
- `refiner/*` maps to `/refiner` operations.
