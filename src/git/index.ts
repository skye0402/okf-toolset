import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { OkfGitError } from '../core/errors.js';
import { pathForConceptId } from '../core/paths.js';

const execFileAsync = promisify(execFile);

export interface OkfConceptRevision {
  ref: string;
  commit: string;
  author?: string;
  date?: string;
  subject?: string;
  path: string;
}

export interface OkfConceptDiff {
  conceptId: string;
  fromRef: string;
  toRef: string;
  diff: string;
}

export interface OkfBlameLine {
  line: number;
  commit: string;
  author?: string;
  text: string;
}

export interface WorkingTreeStatus {
  branch?: string;
  clean: boolean;
  files: Array<{ status: string; path: string }>;
}

export class OkfGitHelper {
  constructor(readonly bundleRoot: string) {}

  async getCurrentRef(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  async getWorkingTreeStatus(): Promise<WorkingTreeStatus> {
    const branch = (await this.git(['branch', '--show-current']).catch(() => '')).trim() || undefined;
    const porcelain = await this.git(['status', '--porcelain']);
    const files = porcelain.split('\n').filter(Boolean).map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
    return { ...(branch ? { branch } : {}), clean: files.length === 0, files };
  }

  async getConceptHistory(conceptId: string, options: { limit?: number } = {}): Promise<OkfConceptRevision[]> {
    const relative = this.relativeConceptPath(conceptId);
    const args = ['log', `--max-count=${options.limit ?? 50}`, '--format=%H%x1f%an%x1f%aI%x1f%s', '--', relative];
    const output = await this.git(args);
    return output.split('\n').filter(Boolean).map((line) => {
      const [commit = '', author, date, subject] = line.split('\x1f');
      return { ref: commit, commit, ...(author ? { author } : {}), ...(date ? { date } : {}), ...(subject ? { subject } : {}), path: relative };
    });
  }

  async diffConcept(conceptId: string, fromRef: string, toRef: string): Promise<OkfConceptDiff> {
    const relative = this.relativeConceptPath(conceptId);
    const diff = await this.git(['diff', fromRef, toRef, '--', relative]);
    return { conceptId, fromRef, toRef, diff };
  }

  async blameConcept(conceptId: string, ref = 'HEAD'): Promise<OkfBlameLine[]> {
    const relative = this.relativeConceptPath(conceptId);
    const output = await this.git(['blame', '--line-porcelain', ref, '--', relative]);
    const lines: OkfBlameLine[] = [];
    let currentCommit = '';
    let currentAuthor: string | undefined;
    let currentLine = 0;
    for (const line of output.split('\n')) {
      if (/^[0-9a-f]{40}\s/.test(line)) {
        currentCommit = line.split(' ')[0] ?? '';
        currentLine += 1;
      } else if (line.startsWith('author ')) {
        currentAuthor = line.slice('author '.length);
      } else if (line.startsWith('\t')) {
        lines.push({ line: currentLine, commit: currentCommit, ...(currentAuthor ? { author: currentAuthor } : {}), text: line.slice(1) });
      }
    }
    return lines;
  }

  suggestCommitMessage(summary: string): string {
    return `Update OKF bundle: ${summary}`;
  }

  async listChangedOkfFiles(): Promise<string[]> {
    const status = await this.getWorkingTreeStatus();
    return status.files.map((file) => file.path).filter((file) => file.endsWith('.md'));
  }

  async createCommit(message: string, files: string[]): Promise<string> {
    if (!files.length) throw new OkfGitError('no files provided for commit');
    await this.git(['add', '--', ...files]);
    await this.git(['commit', '-m', message]);
    return this.getCurrentRef();
  }

  private relativeConceptPath(conceptId: string): string {
    return path.relative(this.bundleRoot, pathForConceptId(conceptId, this.bundleRoot));
  }

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', this.bundleRoot, ...args], { encoding: 'utf8' });
      return stdout;
    } catch (error) {
      throw new OkfGitError(`git command failed: git ${args.join(' ')}`, error);
    }
  }
}
