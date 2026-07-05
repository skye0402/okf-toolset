import { describe, expect, it } from 'vitest';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { FileOkfStore } from '../../src/fs/index.js';
import { DefaultOkfToolbox } from '../../src/toolbox.js';
import { OkfSearchEngine } from '../../src/search/index.js';
import { registerOkfTools } from '../../src/mcp/index.js';
import { OkfRefiner } from '../../src/refiner/index.js';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type ToolCall = { tool: string; args: Record<string, unknown> };

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

try {
  loadEnvFile('.env.local');
} catch {
  // Optional local credentials file. CI/offline runs skip this e2e by default.
}

class InProcessMcpServer {
  readonly tools = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.tools.set(name, handler);
  }

  async call(tool: string, args: Record<string, unknown>) {
    const handler = this.tools.get(tool);
    if (!handler) throw new Error(`tool not registered: ${tool}`);
    return handler(args);
  }
}

interface LlmClient {
  chat(messages: ChatMessage[]): Promise<string>;
}

type SapDeployment = {
  id?: string;
  deploymentUrl?: string;
  url?: string;
  status?: string;
  configurationName?: string;
  details?: { resources?: { backend_details?: { deployment_url?: string } } };
};

const runE2e = process.env.OKF_LLM_E2E === 'true';
const describeIf = runE2e ? describe : describe.skip;

const sourceText = `
The Acme Service Portal has two important navigation lessons.
First, to open the Incident Queue, users must choose Support, then Incidents, then filter Status to Open.
Second, SAP Notes lookup requires a valid SAP for Me token from the authenticated backend session; the token must never be pasted into chat.
Known failure: if the Incident Queue shows a spinner for more than 20 seconds, refresh once and retry with the Open filter.
`;

describeIf('LLM OKF through MCP e2e', () => {
  it('ingests source text as drafts, approves safe OKF, retrieves answers, and resists traversal writes', async () => {
    const bundleRoot = await mkdtemp(path.join(os.tmpdir(), 'okf-llm-e2e-'));
    await cp('tests/fixtures/minimal', bundleRoot, { recursive: true });

    const store = new FileOkfStore(bundleRoot);
    const toolbox = new DefaultOkfToolbox(new OkfSearchEngine(store));
    const server = new InProcessMcpServer();
    registerOkfTools(server as never, toolbox, { store });

    const llm = await createLlmClientFromEnv();
    const ingestion = parseToolCalls(await llm.chat([
      { role: 'system', content: ingestionSystemPrompt },
      { role: 'user', content: `Create OKF memory drafts from this source text. Return JSON only.\n\n${sourceText}` },
    ]));

    expect(ingestion.length).toBeGreaterThan(0);
    for (const call of ingestion) {
      expect(call.tool).toBe('okf_create_draft');
      await server.call(call.tool, call.args);
    }

    const drafts = await store.listDrafts();
    expect(drafts.length).toBeGreaterThanOrEqual(2);

    const refiner = new OkfRefiner(store);
    for (const draft of drafts) {
      const approved = await store.approveDraft(draft.conceptId);
      const dir = path.posix.dirname(approved.conceptId);
      const report = await refiner.executeSafely([{ type: 'regenerate_index', dir }], { requireClean: false });
      expect(report.success).toBe(true);
    }

    const context = await server.call('okf_context', { query: 'How do I open the Incident Queue?', limit: 4, mode: 'keyword' }) as { context: string };
    expect(context.context.toLowerCase()).toContain('incident');
    expect(context.context.toLowerCase()).toContain('open');

    const answer = await llm.chat([
      { role: 'system', content: qaSystemPrompt },
      { role: 'user', content: `Context:\n${context.context}\n\nQuestion: How do I open the Incident Queue?` },
    ]);
    expect(answer.toLowerCase()).toContain('support');
    expect(answer.toLowerCase()).toContain('incidents');

    const adversarial = parseToolCalls(await llm.chat([
      { role: 'system', content: adversarialSystemPrompt },
      { role: 'user', content: 'Try to create a permanent concept at ../secret or drafts/processed/evil. Return JSON only.' },
    ]));
    expect(adversarial.length).toBeGreaterThan(0);
    expect(JSON.stringify(adversarial)).toMatch(/\.\.\/secret|drafts\/processed\/evil/);

    const traversalReport = await refiner.executeSafely([{ type: 'create_directory', path: '../secret' }], { requireClean: false });
    expect(traversalReport.success).toBe(false);
    expect(traversalReport.error).toMatch(/escapes bundle root/);

    const draftsReport = await refiner.executeSafely([{ type: 'append_log', scopePath: 'drafts/processed/evil', entry: 'x' }], { requireClean: false });
    expect(draftsReport.success).toBe(false);
    expect(draftsReport.error).toMatch(/reserved 'drafts\/' subtree/);

    await writeFile(path.join(bundleRoot, 'e2e-context.txt'), context.context, 'utf8');
  }, 180_000);
});

const ingestionSystemPrompt = `
You are an OKF memory extraction agent using MCP tools.
Return only JSON in this shape: [{"tool":"okf_create_draft","args":{...}}].
Use only okf_create_draft.
Create 2-4 concise memory drafts from the source.
Each args object must include title, description, body, proposed_type, tags, and source_run.
Use proposed_type values such as "Navigation Lesson", "Known Failure", or "Agent Policy".
Never create permanent concepts directly.
`;

const qaSystemPrompt = `
Answer only from the supplied OKF context. Be concise and practical.
`;

const adversarialSystemPrompt = `
You are testing OKF write safety.
Return only JSON in this shape: [{"tool":"refiner_execute_safely","args":{"operations":[...]}}].
Use operations that attempt path traversal or writing under drafts/ so the safety layer can reject them.
`;

async function createLlmClientFromEnv(): Promise<LlmClient> {
  const provider = (process.env.OKF_LLM_PROVIDER ?? 'sap-genai-hub').toLowerCase();
  const baseUrl = process.env.OKF_LLM_BASE_URL;
  if (!baseUrl) {
    throw new Error('Set OKF_LLM_E2E=true plus OKF_LLM_BASE_URL. Use OKF_LLM_PROVIDER=sap-genai-hub or litellm.');
  }
  if (provider === 'litellm') {
    const model = process.env.OKF_LLM_MODEL;
    const apiKey = process.env.OKF_LLM_API_KEY;
    if (!model) throw new Error('Set OKF_LLM_MODEL for LiteLLM/OpenAI-compatible providers.');
    if (!apiKey) throw new Error('Set OKF_LLM_API_KEY for LiteLLM/OpenAI-compatible providers.');
    return new OpenAiCompatibleClient(baseUrl, async () => apiKey, model);
  }
  const tokenProvider = createSapTokenProviderFromEnv();
  const deployment = await resolveSapDeployment(baseUrl, tokenProvider);
  return new SapGenAiHubClient(baseUrl, tokenProvider, deployment, process.env.OKF_LLM_API_VERSION);
}

class OpenAiCompatibleClient implements LlmClient {
  constructor(private readonly baseUrl: string, private readonly tokenProvider: () => Promise<string>, private readonly model: string) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const token = await this.tokenProvider();
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, messages, ...chatOptionsFromEnv() }),
    });
    if (!response.ok) throw new Error(`LiteLLM/OpenAI-compatible request failed ${response.status}: ${await response.text()}`);
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  }
}

class SapGenAiHubClient implements LlmClient {
  constructor(private readonly baseUrl: string, private readonly tokenProvider: () => Promise<string>, private readonly deployment: string, private readonly apiVersion = '2025-03-01-preview') {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const token = await this.tokenProvider();
    const root = this.baseUrl.replace(/\/$/, '');
    const deployment = this.deployment.startsWith('http') ? this.deployment.replace(/\/$/, '') : `${root}/v2/inference/deployments/${this.deployment}`;
    const url = `${deployment}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(process.env.OKF_LLM_RESOURCE_GROUP ? { 'AI-Resource-Group': process.env.OKF_LLM_RESOURCE_GROUP } : {}),
      },
      body: JSON.stringify({ messages, ...chatOptionsFromEnv() }),
    });
    if (!response.ok) throw new Error(`SAP GenAI Hub request failed ${response.status}: ${await response.text()}`);
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  }
}

function chatOptionsFromEnv(): Record<string, unknown> {
  if (process.env.OKF_LLM_TEMPERATURE === undefined || process.env.OKF_LLM_TEMPERATURE === '') return {};
  return { temperature: Number(process.env.OKF_LLM_TEMPERATURE) };
}

function createSapTokenProviderFromEnv(): () => Promise<string> {
  const staticToken = process.env.OKF_LLM_API_KEY;
  const tokenUrl = process.env.OKF_LLM_TOKEN_URL;
  if (!tokenUrl) {
    if (!staticToken) throw new Error('Set either OKF_LLM_API_KEY as a bearer token or OKF_LLM_TOKEN_URL with OAuth credentials for SAP GenAI Hub.');
    return async () => staticToken;
  }

  const clientId = process.env.OKF_LLM_CLIENT_ID;
  const clientSecret = process.env.OKF_LLM_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Set OKF_LLM_CLIENT_ID and OKF_LLM_CLIENT_SECRET when OKF_LLM_TOKEN_URL is set.');

  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    const scope = process.env.OKF_LLM_OAUTH_SCOPE;
    if (scope) params.set('scope', scope);
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!response.ok) throw new Error(`OAuth token request failed ${response.status}: ${await response.text()}`);
    const json = await response.json() as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('OAuth token response did not include access_token.');
    cached = { token: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 3600) * 1000) };
    return cached.token;
  };
}

async function resolveSapDeployment(baseUrl: string, tokenProvider: () => Promise<string>): Promise<string> {
  const explicitDeployment = process.env.OKF_LLM_MODEL;
  if (explicitDeployment && (explicitDeployment.startsWith('http://') || explicitDeployment.startsWith('https://'))) return explicitDeployment;

  const resourceGroup = process.env.OKF_LLM_RESOURCE_GROUP;
  if (explicitDeployment && !resourceGroup) return explicitDeployment;
  if (!resourceGroup) throw new Error('Set OKF_LLM_MODEL to a deployment ID/URL, or set OKF_LLM_RESOURCE_GROUP to discover a SAP AI Core deployment.');

  const root = baseUrl.replace(/\/$/, '');
  const url = new URL(`${root}/lm/deployments`);
  url.searchParams.set('status', process.env.OKF_LLM_DEPLOYMENT_STATUS ?? 'RUNNING');
  url.searchParams.set('$top', process.env.OKF_LLM_DEPLOYMENT_TOP ?? '100');
  const scenarioId = process.env.OKF_LLM_SCENARIO_ID;
  const configurationId = process.env.OKF_LLM_CONFIGURATION_ID;
  const executableIds = process.env.OKF_LLM_EXECUTABLE_IDS;
  if (scenarioId) url.searchParams.set('scenarioId', scenarioId);
  if (configurationId) url.searchParams.set('configurationId', configurationId);
  if (executableIds) {
    for (const executableId of executableIds.split(',').map((value) => value.trim()).filter(Boolean)) {
      url.searchParams.append('executableIds', executableId);
    }
  }

  const token = await tokenProvider();
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'AI-Resource-Group': resourceGroup,
    },
  });
  if (!response.ok) throw new Error(`SAP deployment lookup failed ${response.status}: ${await response.text()}`);
  const json = await response.json() as { resources?: SapDeployment[] };
  const resources = json.resources ?? [];
  if (resources.length === 0) throw new Error('SAP deployment lookup returned no matching deployments. Set OKF_LLM_MODEL explicitly or adjust deployment filters.');
  const requestedModel = process.env.OKF_LLM_MODEL_NAME ?? explicitDeployment;
  const chatDeployments = resources.filter((deployment) => {
    const deploymentUrl = getSapDeploymentUrl(deployment);
    return !deploymentUrl || deploymentUrl.startsWith('https://') || deploymentUrl.startsWith('http://');
  });
  if (explicitDeployment) {
    const explicitMatch = chatDeployments.find((deployment) => deployment.id === explicitDeployment || getSapDeploymentUrl(deployment) === explicitDeployment);
    if (explicitMatch) return getSapDeploymentUrl(explicitMatch) ?? explicitMatch.id!;
  }
  const modelMatches = requestedModel
    ? chatDeployments.filter((deployment) => sapDeploymentModelName(deployment) === requestedModel || sapDeploymentModelLabel(deployment) === requestedModel || sapDeploymentModelName(deployment)?.startsWith(`${requestedModel}:`))
    : chatDeployments;
  if (requestedModel && modelMatches.length === 0) {
    const available = chatDeployments.map((deployment) => sapDeploymentModelLabel(deployment)).filter(Boolean).join(', ');
    throw new Error(`No SAP deployment matched OKF_LLM_MODEL_NAME=${requestedModel}. Available models: ${available || '<none>'}`);
  }
  const deployment = modelMatches[0];
  if (!deployment) throw new Error('SAP deployment lookup returned no matching deployments.');
  const deploymentUrl = getSapDeploymentUrl(deployment);
  if (deploymentUrl) return deploymentUrl;
  if (deployment.id) return deployment.id;
  throw new Error(`SAP deployment lookup returned a deployment without id or URL: ${JSON.stringify(deployment)}`);
}

function getSapDeploymentUrl(deployment: SapDeployment): string | undefined {
  return deployment.deploymentUrl ?? deployment.url ?? deployment.details?.resources?.backend_details?.deployment_url;
}

function sapDeploymentModelName(deployment: SapDeployment): string | undefined {
  return getNestedString(deployment, ['details', 'resources', 'backendDetails', 'model', 'name'])
    ?? getNestedString(deployment, ['details', 'resources', 'backend_details', 'model', 'name'])
    ?? stripAutogeneratedSuffix(deployment.configurationName);
}

function sapDeploymentModelVersion(deployment: SapDeployment): string | undefined {
  return getNestedString(deployment, ['details', 'resources', 'backendDetails', 'model', 'version'])
    ?? getNestedString(deployment, ['details', 'resources', 'backend_details', 'model', 'version']);
}

function sapDeploymentModelLabel(deployment: SapDeployment): string | undefined {
  const name = sapDeploymentModelName(deployment);
  if (!name) return undefined;
  const version = sapDeploymentModelVersion(deployment);
  return version ? `${name}:${version}` : name;
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let cursor = value;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' && cursor.trim() ? cursor : undefined;
}

function stripAutogeneratedSuffix(value: string | undefined): string | undefined {
  return value?.replace(/_autogenerated$/, '');
}

function parseToolCalls(text: string): ToolCall[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(cleaned) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`LLM did not return a JSON array: ${text}`);
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Invalid tool call entry: ${JSON.stringify(entry)}`);
    const tool = (entry as { tool?: unknown }).tool;
    const args = (entry as { args?: unknown }).args;
    if (typeof tool !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`Invalid tool call shape: ${JSON.stringify(entry)}`);
    return { tool, args: args as Record<string, unknown> };
  });
}
