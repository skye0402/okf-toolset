import { describe, expect, it } from 'vitest';
import { cp, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileOkfStore } from '../src/fs/index.js';
import { OkfSearchEngine } from '../src/search/index.js';
import { DefaultOkfToolbox } from '../src/index.js';
import { registerOkfTools } from '../src/mcp/index.js';

class FakeServer {
  tools = new Map<string, any>();
  tool(name: string, _description: string, _schema: any, handler: any) {
    this.tools.set(name, handler);
  }
}

describe('MCP helper', () => {
  it('registers read and draft tools', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'okf-mcp-'));
    await cp('tests/fixtures/minimal', dir, { recursive: true });
    const store = new FileOkfStore(dir);
    const toolbox = new DefaultOkfToolbox(new OkfSearchEngine(store));
    const server = new FakeServer();
    registerOkfTools(server, toolbox, { store });
    expect([...server.tools.keys()]).toContain('okf_search');
    expect([...server.tools.keys()]).toContain('okf_create_draft');
    const result = await server.tools.get('okf_search')({ query: 'orders' });
    expect(result.concepts[0].conceptId).toBe('orders');
    expect((await server.tools.get('okf_context')({ query: 'orders' })).context).toContain('Orders');
    expect((await server.tools.get('okf_get')({ concept_id: '/orders.md#schema' })).conceptId).toBe('orders');
    expect((await server.tools.get('okf_validate')({ strict: true })).errors).toEqual([]);
    const draft = await server.tools.get('okf_create_draft')({ title: 'MCP Draft', body: 'Draft body' });
    expect(draft.conceptId).toContain('drafts/');
    expect(await server.tools.get('okf_get')({ concept_id: draft.conceptId })).toBeNull();
    expect((await server.tools.get('okf_list_drafts')({})).drafts.length).toBe(1);
    const rejected = await server.tools.get('okf_reject_draft')({ draft_name: draft.conceptId });
    expect(rejected.frontmatter.status).toBe('rejected');
  });
});
