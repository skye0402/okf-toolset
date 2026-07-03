import { z } from 'zod';
import type { DraftInput, OkfToolbox, SearchOptions } from '../core/types.js';
import type { FileOkfStore } from '../fs/index.js';

type ToolRegisteringServer = {
  tool(name: string, description: string, schema: Record<string, unknown>, handler: (args: any) => Promise<any> | any): unknown;
};

export interface RegisterOkfToolsOptions {
  store?: FileOkfStore;
  defaultLimit?: number;
}

export function registerOkfTools(server: ToolRegisteringServer, toolbox: OkfToolbox, options: RegisterOkfToolsOptions = {}): void {
  const defaultLimit = options.defaultLimit ?? 8;

  server.tool(
    'okf_search',
    'Search OKF concepts using keyword or hybrid search. Returns compact result metadata; call okf_get for full content.',
    { query: z.string(), limit: z.number().optional(), mode: z.enum(['keyword', 'embedding', 'hybrid']).optional() },
    async ({ query, limit, mode }: { query: string; limit?: number; mode?: SearchOptions['mode'] }) => {
      const searchOptions: SearchOptions = { limit: limit ?? defaultLimit };
      if (mode !== undefined) searchOptions.mode = mode;
      return { concepts: await toolbox.search(query, searchOptions) };
    },
  );

  server.tool(
    'okf_context',
    'Render relevant OKF concepts as compact markdown context.',
    { query: z.string(), limit: z.number().optional(), mode: z.enum(['keyword', 'embedding', 'hybrid']).optional() },
    async ({ query, limit, mode }: { query: string; limit?: number; mode?: SearchOptions['mode'] }) => {
      const searchOptions: SearchOptions = { limit: limit ?? defaultLimit };
      if (mode !== undefined) searchOptions.mode = mode;
      return toolbox.context(query, searchOptions);
    },
  );

  server.tool(
    'okf_get',
    'Read one OKF concept by concept ID or OKF markdown link target.',
    { concept_id: z.string() },
    async ({ concept_id }: { concept_id: string }) => toolbox.get(concept_id),
  );

  server.tool(
    'okf_validate',
    'Validate the OKF bundle. Strict mode checks optional structural conventions.',
    { strict: z.boolean().optional() },
    async ({ strict }: { strict?: boolean }) => ({ errors: await toolbox.validate(strict === undefined ? {} : { strict }) }),
  );

  if (!options.store) return;

  server.tool(
    'okf_create_draft',
    'Create a pending OKF memory draft for human approval.',
    {
      title: z.string(),
      description: z.string().optional(),
      body: z.string(),
      source_run: z.string().optional(),
      proposed_type: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args: { title: string; description?: string; body: string; source_run?: string; proposed_type?: string; tags?: string[] }) => {
      const input: DraftInput = {
        title: args.title,
        body: args.body,
        ...(args.description ? { description: args.description } : {}),
        ...(args.source_run ? { sourceRun: args.source_run } : {}),
        ...(args.proposed_type ? { proposedType: args.proposed_type } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
      };
      return options.store!.createDraft(input);
    },
  );

  server.tool('okf_list_drafts', 'List pending OKF memory drafts.', {}, async () => ({ drafts: await options.store!.listDrafts() }));
  server.tool('okf_approve_draft', 'Approve a pending OKF memory draft.', { draft_name: z.string(), target_concept_id: z.string().optional() }, async ({ draft_name, target_concept_id }: { draft_name: string; target_concept_id?: string }) => options.store!.approveDraft(draft_name, target_concept_id));
  server.tool('okf_reject_draft', 'Reject a pending OKF memory draft.', { draft_name: z.string() }, async ({ draft_name }: { draft_name: string }) => options.store!.rejectDraft(draft_name));
}
