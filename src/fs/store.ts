import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DraftInput, OkfConcept, OkfConceptFilter, OkfStore, OkfValidationError, RootIndexDocument, ValidationOptions, WriteOptions } from '../core/types.js';
import { OKF_VERSION_SUPPORTED } from '../core/types.js';
import { parseConcept, parseRootIndex, renderConceptMarkdown, splitOptionalFrontmatter } from '../core/markdown.js';
import { assertInsideRoot, isDraftPath, isReservedMarkdownPath, normalizeConceptId, pathForConceptId } from '../core/paths.js';
import { validateConcept, validateConceptMarkdown, validateIndexMarkdown, validateLogMarkdown } from '../core/validation.js';
import { atomicWriteFile } from './atomic.js';
import { mutexForKey } from '../utils/mutex.js';

export interface FileOkfStoreOptions {
  draftsDir?: string;
}

export class FileOkfStore implements OkfStore {
  readonly bundleRoot: string;
  readonly draftsDir: string;
  private readonly mutex;

  constructor(bundleRoot: string, options: FileOkfStoreOptions = {}) {
    this.bundleRoot = path.resolve(bundleRoot);
    this.draftsDir = normalizeConceptId(options.draftsDir ?? 'drafts');
    this.mutex = mutexForKey(this.bundleRoot);
  }

  async scanBundle(): Promise<OkfConcept[]> {
    const files = await this.findMarkdownFiles(this.bundleRoot);
    const concepts: OkfConcept[] = [];
    for (const file of files) {
      if (isReservedMarkdownPath(file)) continue;
      try {
        concepts.push(parseConcept(await readFile(file, 'utf8'), file, this.bundleRoot));
      } catch {
        // Permissive consumption: malformed concept files are surfaced by validate(), not scanBundle().
      }
    }
    return concepts.sort((a, b) => a.conceptId.localeCompare(b.conceptId));
  }

  async getConcept(conceptId: string): Promise<OkfConcept | null> {
    const filePath = pathForConceptId(conceptId, this.bundleRoot);
    try {
      return parseConcept(await readFile(filePath, 'utf8'), filePath, this.bundleRoot);
    } catch {
      return null;
    }
  }

  async listConcepts(filter: OkfConceptFilter = {}): Promise<OkfConcept[]> {
    const concepts = await this.scanBundle();
    return concepts.filter((concept) => matchesFilter(concept, filter));
  }

  async writeConcept(concept: OkfConcept, options: WriteOptions = {}): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const filePath = pathForConceptId(concept.conceptId, this.bundleRoot);
      if (!options.overwrite && await exists(filePath)) {
        throw new Error(`concept already exists: ${concept.conceptId}`);
      }
      await atomicWriteFile(filePath, renderConceptMarkdown({ ...concept, path: filePath }));
    });
  }

  async deleteConcept(conceptId: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const filePath = pathForConceptId(conceptId, this.bundleRoot);
      await rm(filePath, { force: true });
    });
  }

  async exists(conceptId: string): Promise<boolean> {
    return exists(pathForConceptId(conceptId, this.bundleRoot));
  }

  async readRootIndex(): Promise<RootIndexDocument | null> {
    const filePath = path.join(this.bundleRoot, 'index.md');
    try {
      return parseRootIndex(await readFile(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  async readIndex(dir = '.'): Promise<string | null> {
    const filePath = path.resolve(this.bundleRoot, dir, 'index.md');
    assertInsideRoot(filePath, this.bundleRoot);
    try {
      const parsed = splitOptionalFrontmatter(await readFile(filePath, 'utf8'));
      return parsed.body;
    } catch {
      return null;
    }
  }

  async appendLog(scopePath: string, entry: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const dir = path.resolve(this.bundleRoot, scopePath);
      assertInsideRoot(dir, this.bundleRoot);
      await mkdir(dir, { recursive: true });
      const logPath = path.join(dir, 'log.md');
      const today = new Date().toISOString().slice(0, 10);
      const current = await readFile(logPath, 'utf8').catch(() => '# Directory Update Log\n');
      const line = `* ${entry.trim()}\n`;
      const heading = `## ${today}`;
      let next: string;
      if (current.includes(heading)) {
        next = current.replace(heading, `${heading}\n${line}`);
      } else {
        const title = current.trim() ? current.trimEnd() : '# Directory Update Log';
        const firstHeading = title.search(/^##\s+\d{4}-\d{2}-\d{2}\s*$/m);
        if (firstHeading >= 0) {
          next = `${title.slice(0, firstHeading).trimEnd()}\n\n${heading}\n${line}${title.slice(firstHeading).trimStart()}`;
        } else {
          next = `${title}\n\n${heading}\n${line}`;
        }
      }
      await atomicWriteFile(logPath, next.endsWith('\n') ? next : `${next}\n`);
    });
  }

  async createDraft(input: DraftInput): Promise<OkfConcept> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('Z', '');
    const slug = slugify(input.title);
    const conceptId = `${this.draftsDir}/${stamp}-${slug}`;
    const filePath = pathForConceptId(conceptId, this.bundleRoot);
    const concept: OkfConcept = {
      conceptId,
      path: filePath,
      type: 'Memory Draft',
      title: input.title,
      description: input.description ?? '',
      tags: input.tags ?? ['okf', 'draft'],
      timestamp: new Date().toISOString(),
      frontmatter: {
        type: 'Memory Draft',
        title: input.title,
        description: input.description ?? '',
        tags: input.tags ?? ['okf', 'draft'],
        timestamp: new Date().toISOString(),
        status: 'pending',
        proposed_type: input.proposedType ?? 'Reference',
        ...(input.sourceRun ? { source_run: input.sourceRun } : {}),
      },
      body: input.body,
    };
    await this.writeConcept(concept);
    await this.appendLog('.', `**Creation**: Proposed memory draft [${input.title}](/${conceptId}.md).`);
    return concept;
  }

  async listDrafts(): Promise<OkfConcept[]> {
    return (await this.scanBundle()).filter((concept) => concept.conceptId.startsWith(`${this.draftsDir}/`) && concept.frontmatter.status === 'pending');
  }

  async approveDraft(draftName: string, targetConceptId?: string): Promise<OkfConcept> {
    const draftId = draftName.includes('/') ? normalizeConceptId(draftName) : `${this.draftsDir}/${normalizeConceptId(draftName)}`;
    const draft = await this.getConcept(draftId);
    if (!draft) throw new Error(`draft not found: ${draftName}`);
    const targetId = targetConceptId ? normalizeConceptId(targetConceptId) : defaultTargetConceptId(draft);
    const targetPath = pathForConceptId(targetId, this.bundleRoot);
    if (await exists(targetPath)) throw new Error(`target concept already exists: ${targetId}`);
    const approved: OkfConcept = {
      ...draft,
      conceptId: targetId,
      path: targetPath,
      type: String(draft.frontmatter.proposed_type ?? 'Reference'),
      frontmatter: {
        ...draft.frontmatter,
        type: String(draft.frontmatter.proposed_type ?? 'Reference'),
        status: 'approved',
      },
    };
    await this.writeConcept(approved);
    await rm(pathForConceptId(draftId, this.bundleRoot), { force: true });
    await this.appendLog('.', `**Approval**: Approved draft [${draft.title ?? draftId}](/${targetId}.md).`);
    return approved;
  }

  async rejectDraft(draftName: string): Promise<OkfConcept> {
    const draftId = draftName.includes('/') ? normalizeConceptId(draftName) : `${this.draftsDir}/${normalizeConceptId(draftName)}`;
    const draft = await this.getConcept(draftId);
    if (!draft) throw new Error(`draft not found: ${draftName}`);
    const rejectedId = `${this.draftsDir}/rejected/${path.posix.basename(draft.conceptId)}`;
    const rejectedPath = pathForConceptId(rejectedId, this.bundleRoot);
    const rejected: OkfConcept = { ...draft, conceptId: rejectedId, path: rejectedPath, frontmatter: { ...draft.frontmatter, status: 'rejected' } };
    await this.writeConcept(rejected);
    await rm(pathForConceptId(draftId, this.bundleRoot), { force: true });
    await this.appendLog('.', `**Rejection**: Rejected draft ${draft.title ?? draftId}.`);
    return rejected;
  }

  async validate(options: ValidationOptions = {}): Promise<OkfValidationError[]> {
    const files = await this.findMarkdownFiles(this.bundleRoot);
    const errors: OkfValidationError[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const name = path.basename(file);
      if (name === 'index.md') errors.push(...validateIndexMarkdown(text, file, this.bundleRoot, options));
      else if (name === 'log.md') errors.push(...validateLogMarkdown(text, file, options));
      else errors.push(...validateConceptMarkdown(text, file));
    }
    const rootIndex = await this.readRootIndex();
    if (rootIndex?.okfVersion && rootIndex.okfVersion > OKF_VERSION_SUPPORTED) {
      errors.push({
        path: path.join(this.bundleRoot, 'index.md'),
        severity: 'warning',
        code: 'unsupported_okf_version',
        message: `Bundle declares OKF ${rootIndex.okfVersion}; this library supports ${OKF_VERSION_SUPPORTED} and will consume best-effort.`,
      });
    }
    for (const concept of await this.scanBundle()) errors.push(...validateConcept(concept));
    return errors;
  }

  private async findMarkdownFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.okf-cache') continue;
      if (entry.isDirectory()) files.push(...await this.findMarkdownFiles(fullPath));
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath);
    }
    return files.sort();
  }
}

export function matchesFilter(concept: OkfConcept, filter: OkfConceptFilter): boolean {
  if (!filter.includeDrafts && isDraftPath(concept.conceptId)) return false;
  if (filter.type) {
    const allowed = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!allowed.includes(concept.type)) return false;
  }
  if (filter.tags?.length && !filter.tags.every((tag) => concept.tags.includes(tag))) return false;
  if (filter.pathPrefix && !concept.conceptId.startsWith(normalizeConceptId(filter.pathPrefix))) return false;
  if (filter.status && concept.frontmatter.status !== filter.status) return false;
  return true;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'draft';
}

function defaultTargetConceptId(draft: OkfConcept): string {
  const proposedType = String(draft.frontmatter.proposed_type ?? 'Reference');
  const folderByType: Record<string, string> = {
    'Task Playbook': 'playbooks',
    'Navigation Lesson': 'navigation',
    'Known Failure': 'failures',
    'Agent Policy': 'policies',
    Application: 'apps',
    Reference: 'references',
  };
  return normalizeConceptId(`${folderByType[proposedType] ?? slugify(proposedType)}/${slugify(draft.title ?? path.posix.basename(draft.conceptId))}`);
}
