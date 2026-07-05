import { describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { FileOkfStore } from '../src/fs/index.js';
import { OkfRefiner, validateRefinerBatch } from '../src/refiner/index.js';

const execFileAsync = promisify(execFile);

async function tempNested() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'okf-refiner-'));
  await cp('tests/fixtures/nested', dir, { recursive: true });
  return dir;
}

async function gitBundle() {
  const dir = await tempNested();
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
  return dir;
}

const validConcept = {
  conceptId: 'apps/sap/new-thing',
  path: '',
  type: 'Application',
  title: 'New Thing',
  description: 'New thing description.',
  tags: ['sap'],
  frontmatter: { type: 'Application', title: 'New Thing', description: 'New thing description.', tags: ['sap'] },
  body: '# New Thing\n',
};

describe('OkfRefiner', () => {
  it('moves concepts and rewrites inbound links', async () => {
    const dir = await tempNested();
    const store = new FileOkfStore(dir);
    const refiner = new OkfRefiner(store);
    const result = await refiner.execute([{ type: 'move_concept', fromConceptId: 'apps/sap/value-help', toConceptId: 'apps/sap/fiori/value-help' }]);
    expect(result.changedFiles.length).toBeGreaterThan(0);
    const salesOrder = await readFile(path.join(dir, 'apps/sap/create-sales-order.md'), 'utf8');
    expect(salesOrder).toContain('/apps/sap/fiori/value-help.md');
  });

  it('updates concept type from frontmatter and regenerates indexes/logs', async () => {
    const dir = await tempNested();
    const store = new FileOkfStore(dir);
    const refiner = new OkfRefiner(store);
    const result = await refiner.execute([
      { type: 'update_concept', conceptId: 'apps/sap/value-help', frontmatter: { type: 'Reference', title: 'Value Help Updated' } },
      { type: 'regenerate_index', dir: 'apps/sap' },
      { type: 'append_log', scopePath: 'apps/sap', entry: '**Update**: Refiner test.' },
    ]);
    expect(result.validationErrors).toEqual([]);
    expect((await store.getConcept('apps/sap/value-help'))?.type).toBe('Reference');
    expect(await readFile(path.join(dir, 'apps/sap/index.md'), 'utf8')).toContain('Value Help Updated');
    expect(await readFile(path.join(dir, 'apps/sap/log.md'), 'utf8')).toContain('Refiner test');
  });

  it('preflights target collisions before moving', async () => {
    const dir = await tempNested();
    const refiner = new OkfRefiner(new FileOkfStore(dir));
    await expect(refiner.execute([{ type: 'move_concept', fromConceptId: 'apps/sap/value-help', toConceptId: 'apps/sap/create-sales-order' }])).rejects.toThrow(/already exists/);
  });

  it('safe executor rejects missing index coverage before touching disk', async () => {
    const dir = await tempNested();
    const store = new FileOkfStore(dir);
    await expect(validateRefinerBatch(store, [{ type: 'create_concept', concept: { ...validConcept, path: path.join(dir, 'apps/sap/new-thing.md') } }])).rejects.toThrow(/missing RewriteIndex/);
    expect(await store.getConcept('apps/sap/new-thing')).toBeNull();
  });

  it('safe executor blocks path traversal and reserved drafts subtree', async () => {
    const dir = await tempNested();
    const store = new FileOkfStore(dir);
    await expect(validateRefinerBatch(store, [{ type: 'create_directory', path: '../escape' }])).rejects.toThrow(/escapes bundle root/);
    await expect(validateRefinerBatch(store, [{ type: 'append_log', scopePath: 'drafts', entry: 'x' }])).rejects.toThrow(/reserved 'drafts\/' subtree/);
    await expect(validateRefinerBatch(store, [{ type: 'create_concept', concept: { ...validConcept, conceptId: 'drafts/new', path: path.join(dir, 'drafts/new.md') } }])).rejects.toThrow(/reserved 'drafts\/' subtree/);
  });

  it('safe executor applies covered moves and reports link rewrites', async () => {
    const dir = await tempNested();
    const store = new FileOkfStore(dir);
    const refiner = new OkfRefiner(store);
    const report = await refiner.executeSafely([
      { type: 'move_concept', fromConceptId: 'apps/sap/value-help', toConceptId: 'apps/sap/fiori/value-help' },
      { type: 'regenerate_index', dir: 'apps/sap' },
      { type: 'regenerate_index', dir: 'apps/sap/fiori' },
    ], { requireClean: false });
    expect(report.success).toBe(true);
    expect(report.filesWithRewrittenLinks.some((file) => file.endsWith('create-sales-order.md'))).toBe(true);
    expect(await store.getConcept('apps/sap/fiori/value-help')).toBeTruthy();
    expect(await readFile(path.join(dir, 'apps/sap/create-sales-order.md'), 'utf8')).toContain('/apps/sap/fiori/value-help.md');
  });

  it('safe executor rolls back apply failures in clean git bundles', async () => {
    const dir = await gitBundle();
    const store = new FileOkfStore(dir);
    const refiner = new OkfRefiner(store);
    const report = await refiner.executeSafely([
      { type: 'create_concept', concept: { ...validConcept, path: path.join(dir, 'apps/sap/new-thing.md') } },
      { type: 'move_concept', fromConceptId: 'apps/sap/missing', toConceptId: 'apps/sap/moved-missing' },
      { type: 'regenerate_index', dir: 'apps/sap' },
    ]);
    expect(report.success).toBe(false);
    expect(report.rolledBack).toBe(true);
    expect(await store.getConcept('apps/sap/new-thing')).toBeNull();
  });

  it('safe executor refuses dirty tracked bundles when rollback is required', async () => {
    const dir = await gitBundle();
    await writeFile(path.join(dir, 'apps/sap/value-help.md'), 'dirty tracked change', 'utf8');
    const report = await new OkfRefiner(new FileOkfStore(dir)).executeSafely([
      { type: 'regenerate_index', dir: 'apps/sap' },
    ]);
    expect(report.success).toBe(false);
    expect(report.error).toContain('not clean');
  });
});
