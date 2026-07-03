import { describe, expect, it } from 'vitest';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileOkfStore } from '../src/fs/index.js';

async function tempBundle(source = 'tests/fixtures/minimal') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'okf-'));
  await cp(source, dir, { recursive: true });
  return dir;
}

describe('FileOkfStore', () => {
  it('scans nested concepts and validates external fixture', async () => {
    const store = new FileOkfStore(path.resolve('tests/fixtures/external'));
    expect(await store.validate()).toEqual([]);
    expect((await store.scanBundle()).map((c) => c.conceptId)).toEqual(['metrics/weekly-active-users']);
    expect(await new FileOkfStore(path.resolve('tests/fixtures/external-stashpad-style/knowledge')).validate()).toEqual([]);
  });

  it('creates approves and rejects drafts', async () => {
    const dir = await tempBundle();
    const store = new FileOkfStore(dir);
    const draft = await store.createDraft({ title: 'Remember SAP', body: 'SAP note.', proposedType: 'Reference' });
    expect((await store.listDrafts()).length).toBe(1);
    const approved = await store.approveDraft(draft.conceptId, 'references/remember-sap');
    expect(approved.conceptId).toBe('references/remember-sap');
    const second = await store.createDraft({ title: 'Reject Me', body: 'Nope.' });
    await store.rejectDraft(second.conceptId);
    expect(await store.getConcept(second.conceptId)).toBeNull();
    expect((await store.scanBundle()).some((concept) => concept.conceptId.includes('drafts/rejected') && concept.frontmatter.status === 'rejected')).toBe(true);
  });

  it('rejects accidental overwrites and exposes index/log helpers', async () => {
    const dir = await tempBundle();
    const store = new FileOkfStore(dir);
    const concept = await store.getConcept('orders');
    await expect(store.writeConcept(concept!)).rejects.toThrow(/already exists/);
    expect((await store.readRootIndex())?.okfVersion).toBe('0.1');
    expect(await store.readIndex('.')).toContain('Minimal OKF Bundle');
    await store.appendLog('.', '**Update**: Test log entry.');
    expect(await readFile(path.join(dir, 'log.md'), 'utf8')).toContain('Test log entry');
  });

  it('serializes concurrent overwrites through mutex', async () => {
    const dir = await tempBundle();
    const store = new FileOkfStore(dir);
    const concept = await store.getConcept('orders');
    expect(concept).toBeTruthy();
    await Promise.all(Array.from({ length: 5 }, (_, index) => store.writeConcept({ ...concept!, body: `body ${index}` }, { overwrite: true })));
    const final = await readFile(path.join(dir, 'orders.md'), 'utf8');
    expect(final).toMatch(/body [0-4]/);
  });
});
