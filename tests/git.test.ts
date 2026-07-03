import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OkfGitHelper } from '../src/git/index.js';

const execFileAsync = promisify(execFile);

describe('Git helper', () => {
  it('returns typed errors outside git repositories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'okf-git-'));
    const helper = new OkfGitHelper(dir);
    await expect(helper.getCurrentRef()).rejects.toMatchObject({ code: 'OKF_GIT_ERROR' });
  });

  it('reads concept history inside git repositories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'okf-git-'));
    await execFileAsync('git', ['-C', dir, 'init']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test User']);
    await writeFile(path.join(dir, 'alpha.md'), '---\ntype: Reference\ntitle: Alpha\n---\nAlpha\n');
    await execFileAsync('git', ['-C', dir, 'add', 'alpha.md']);
    await execFileAsync('git', ['-C', dir, 'commit', '-m', 'Add alpha']);
    const helper = new OkfGitHelper(dir);
    expect((await helper.getConceptHistory('alpha')).length).toBe(1);
    await writeFile(path.join(dir, 'alpha.md'), '---\ntype: Reference\ntitle: Alpha\n---\nAlpha updated\n');
    expect(await helper.listChangedOkfFiles()).toEqual(['alpha.md']);
    await execFileAsync('git', ['-C', dir, 'add', 'alpha.md']);
    await execFileAsync('git', ['-C', dir, 'commit', '-m', 'Update alpha']);
    expect((await helper.diffConcept('alpha', 'HEAD~1', 'HEAD')).diff).toContain('Alpha updated');
    expect((await helper.blameConcept('alpha')).length).toBeGreaterThan(0);
    expect(helper.suggestCommitMessage('test')).toContain('test');
    expect((await helper.getWorkingTreeStatus()).clean).toBe(true);
  });
});
