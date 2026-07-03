import { describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileOkfStore } from '../src/fs/index.js';
import { OkfRefiner } from '../src/refiner/index.js';

async function tempNested() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'okf-refiner-'));
  await cp('tests/fixtures/nested', dir, { recursive: true });
  return dir;
}

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
});
