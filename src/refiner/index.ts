import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { OkfConcept, OkfValidationError, ValidationOptions } from '../core/types.js';
import { assertInsideRoot, isDraftPath, normalizeConceptId, pathForConceptId } from '../core/paths.js';
import { rewriteConceptLinks } from '../core/links.js';
import { renderConceptMarkdown } from '../core/markdown.js';
import { atomicWriteFile } from '../fs/atomic.js';
import { FileOkfStore } from '../fs/store.js';
import YAML from 'yaml';

const execFileAsync = promisify(execFile);
const REQUIRED_CONCEPT_FRONTMATTER = ['type', 'description', 'tags'] as const;

export type RefinerOperation =
  | { type: 'create_directory'; path: string }
  | { type: 'create_concept'; concept: OkfConcept }
  | { type: 'update_concept'; conceptId: string; frontmatter?: Record<string, unknown>; body?: string }
  | { type: 'move_concept'; fromConceptId: string; toConceptId: string }
  | { type: 'delete_concept'; conceptId: string }
  | { type: 'append_log'; scopePath: string; entry: string }
  | { type: 'regenerate_index'; dir?: string }
  | { type: 'rewrite_index'; dir: string; body: string; frontmatter?: Record<string, unknown> | null };

export interface RefinerResult {
  changedFiles: string[];
  warnings: string[];
  validationErrors: OkfValidationError[];
}

export interface ExecutionReport {
  success: boolean;
  appliedOps: number;
  pathsTouched: string[];
  directoriesAffected: string[];
  filesWithRewrittenLinks: string[];
  moves: number;
  error?: string;
  rolledBack: boolean;
  validationErrors: OkfValidationError[];
}

export interface RefinerExecuteOptions {
  validation?: ValidationOptions;
}

export interface SafeExecuteOptions extends RefinerExecuteOptions {
  reorgCap?: number;
  requireClean?: boolean;
}

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorError';
  }
}

export class OkfRefiner {
  constructor(readonly store: FileOkfStore) {}

  async execute(operations: RefinerOperation[], options: RefinerExecuteOptions = {}): Promise<RefinerResult> {
    const changedFiles: string[] = [];
    const warnings: string[] = [];
    const moves = new Map<string, string>();

    await this.preflight(operations);

    for (const operation of operations) {
      if (operation.type === 'move_concept') {
        moves.set(normalizeConceptId(operation.fromConceptId), normalizeConceptId(operation.toConceptId));
      }
    }

    for (const operation of operations) {
      switch (operation.type) {
        case 'create_directory': {
          const dir = path.resolve(this.store.bundleRoot, operation.path);
          assertInsideRoot(dir, this.store.bundleRoot);
          await mkdir(dir, { recursive: true });
          changedFiles.push(dir);
          break;
        }
        case 'create_concept': {
          await this.store.writeConcept(operation.concept);
          changedFiles.push(pathForConceptId(operation.concept.conceptId, this.store.bundleRoot));
          break;
        }
        case 'update_concept': {
          const concept = await this.store.getConcept(operation.conceptId);
          if (!concept) throw new Error(`concept not found: ${operation.conceptId}`);
          const updated = mergeConceptUpdate(concept, operation.frontmatter, operation.body);
          await this.store.writeConcept(updated, { overwrite: true });
          changedFiles.push(updated.path);
          break;
        }
        case 'move_concept': {
          const source = await this.store.getConcept(operation.fromConceptId);
          if (!source) throw new Error(`concept not found: ${operation.fromConceptId}`);
          const toConceptId = normalizeConceptId(operation.toConceptId);
          const targetPath = pathForConceptId(toConceptId, this.store.bundleRoot);
          const moved: OkfConcept = { ...source, conceptId: toConceptId, path: targetPath };
          await this.store.writeConcept(moved);
          await this.store.deleteConcept(source.conceptId);
          changedFiles.push(source.path, targetPath);
          break;
        }
        case 'delete_concept': {
          const filePath = pathForConceptId(operation.conceptId, this.store.bundleRoot);
          await rm(filePath, { force: true });
          changedFiles.push(filePath);
          break;
        }
        case 'append_log': {
          await this.store.appendLog(operation.scopePath, operation.entry);
          changedFiles.push(path.resolve(this.store.bundleRoot, operation.scopePath, 'log.md'));
          break;
        }
        case 'regenerate_index': {
          const filePath = await regenerateIndex(this.store, operation.dir ?? '.');
          changedFiles.push(filePath);
          break;
        }
        case 'rewrite_index': {
          const filePath = await rewriteIndex(this.store, operation.dir, operation.body, operation.frontmatter ?? null);
          changedFiles.push(filePath);
          break;
        }
      }
    }

    if (moves.size > 0) {
      const rewritten = await rewriteInboundLinks(this.store, moves);
      changedFiles.push(...rewritten);
    }

    const validationErrors = await this.store.validate(options.validation ?? {});
    return { changedFiles: [...new Set(changedFiles)], warnings, validationErrors };
  }

  async executeSafely(operations: RefinerOperation[], options: SafeExecuteOptions = {}): Promise<ExecutionReport> {
    return applyRefinerBatch(this.store, operations, options);
  }

  private async preflight(operations: RefinerOperation[]): Promise<void> {
    const targets = new Set<string>();
    for (const operation of operations) {
      if (operation.type === 'create_concept') {
        const target = normalizeConceptId(operation.concept.conceptId);
        if (targets.has(target) || await this.store.exists(target)) throw new Error(`target concept already exists: ${target}`);
        targets.add(target);
      }
      if (operation.type === 'move_concept') {
        const source = normalizeConceptId(operation.fromConceptId);
        const target = normalizeConceptId(operation.toConceptId);
        if (source === target) throw new Error(`move source and target are identical: ${source}`);
        if (targets.has(target) || await this.store.exists(target)) throw new Error(`target concept already exists: ${target}`);
        const sourceConcept = await this.store.getConcept(source);
        if (!sourceConcept) throw new Error(`concept not found: ${source}`);
        targets.add(target);
      }
    }
  }
}

export async function applyRefinerBatch(store: FileOkfStore, operations: RefinerOperation[], options: SafeExecuteOptions = {}): Promise<ExecutionReport> {
  const reorgCap = options.reorgCap ?? 3;
  const requireClean = options.requireClean ?? true;
  const bundleRoot = store.bundleRoot;

  if (requireClean && !await bundleIsClean(bundleRoot)) {
    return emptyReport({ error: `bundle root ${bundleRoot} is not clean (uncommitted changes to tracked files); refusing to run` });
  }

  const untrackedAtStart = requireClean ? await snapshotUntracked(bundleRoot) : new Set<string>();

  try {
    await validateRefinerBatch(store, operations, { reorgCap });
  } catch (error) {
    return emptyReport({ error: error instanceof Error ? error.message : String(error) });
  }

  const pathsTouched: string[] = [];
  const directoriesAffected: string[] = [];
  const filesWithRewrittenLinks: string[] = [];
  let appliedOps = 0;

  try {
    for (const operation of operations) {
      const applied = await applyOne(store, operation);
      appliedOps += 1;
      pathsTouched.push(...applied.pathsTouched);
      directoriesAffected.push(...applied.directoriesAffected);
      filesWithRewrittenLinks.push(...applied.filesWithRewrittenLinks);
    }

    const predicted = await predictedChildSetChanges(store, operations);
    const rewritten = rewrittenIndexDirs(store, operations);
    const missing = [...predicted].filter((dir) => !rewritten.has(dir)).sort();
    if (missing.length > 0) {
      throw new ExecutorError(`post-apply coverage check failed (state drifted): ${missing.map((dir) => relativeDir(store, dir)).join(', ')}`);
    }

    const validationErrors = await store.validate(options.validation ?? {});
    return {
      success: true,
      appliedOps,
      pathsTouched: unique(pathsTouched),
      directoriesAffected: unique(directoriesAffected),
      filesWithRewrittenLinks: unique(filesWithRewrittenLinks),
      moves: countMoves(operations),
      rolledBack: false,
      validationErrors,
    };
  } catch (error) {
    if (requireClean) await rollbackBundle(bundleRoot, untrackedAtStart);
    return {
      success: false,
      appliedOps,
      pathsTouched: unique(pathsTouched),
      directoriesAffected: unique(directoriesAffected),
      filesWithRewrittenLinks: unique(filesWithRewrittenLinks),
      moves: countMoves(operations),
      error: error instanceof Error ? error.message : String(error),
      rolledBack: requireClean,
      validationErrors: [],
    };
  }
}

export async function validateRefinerBatch(store: FileOkfStore, operations: RefinerOperation[], options: { reorgCap?: number } = {}): Promise<void> {
  const reorgCap = options.reorgCap ?? 3;
  if (operations.length === 0) throw new ExecutorError('empty operation batch');

  let moveCount = 0;
  for (const [index, operation] of operations.entries()) {
    const where = `op[${index}] ${operation.type}`;
    switch (operation.type) {
      case 'create_concept': {
        checkConceptId(operation.concept.conceptId, where);
        validateConceptFrontmatter(operation.concept, where);
        break;
      }
      case 'update_concept': {
        checkConceptId(operation.conceptId, where);
        const existing = await store.getConcept(operation.conceptId);
        if (!existing) throw new ExecutorError(`${where}: concept not found: ${operation.conceptId}`);
        validateConceptFrontmatter(mergeConceptUpdate(existing, operation.frontmatter, operation.body), where);
        break;
      }
      case 'move_concept': {
        moveCount += 1;
        if (moveCount > reorgCap) throw new ExecutorError(`reorg cap (${reorgCap}) exceeded -- batch attempts ${moveCount} moves`);
        const source = checkConceptId(operation.fromConceptId, `${where} (src)`);
        const target = checkConceptId(operation.toConceptId, `${where} (dst)`);
        if (source === target) throw new ExecutorError(`${where}: src and dst are the same concept`);
        break;
      }
      case 'delete_concept': {
        checkConceptId(operation.conceptId, where);
        break;
      }
      case 'create_directory': {
        checkDirectoryPath(store, operation.path, where);
        break;
      }
      case 'append_log': {
        checkDirectoryPath(store, operation.scopePath, where);
        if (!operation.entry.trim()) throw new ExecutorError(`${where}: entry may not be empty`);
        break;
      }
      case 'regenerate_index': {
        checkDirectoryPath(store, operation.dir ?? '.', where);
        break;
      }
      case 'rewrite_index': {
        const target = checkDirectoryPath(store, operation.dir, where);
        const isRoot = path.resolve(target) === path.resolve(store.bundleRoot);
        if (isRoot) {
          if (!operation.frontmatter) throw new ExecutorError(`${where}: bundle-root index requires frontmatter`);
          if (!operation.frontmatter.okf_version) throw new ExecutorError(`${where}: bundle-root index must declare okf_version`);
        } else if (operation.frontmatter !== undefined && operation.frontmatter !== null) {
          throw new ExecutorError(`${where}: non-root index must not carry frontmatter (spec section 6)`);
        }
        break;
      }
    }
  }

  const predicted = await predictedChildSetChanges(store, operations);
  const rewritten = rewrittenIndexDirs(store, operations);
  const missing = [...predicted].filter((dir) => !rewritten.has(dir)).sort();
  if (missing.length > 0) {
    throw new ExecutorError(`missing RewriteIndex for affected directories: ${missing.map((dir) => relativeDir(store, dir)).join(', ')}`);
  }
}

export async function rewriteInboundLinks(store: FileOkfStore, moves: Map<string, string>): Promise<string[]> {
  const changed: string[] = [];
  for (const concept of await store.scanBundle()) {
    if (isDraftPath(concept.conceptId)) continue;
    const rewritten = rewriteConceptLinks(concept.body, concept.conceptId, moves);
    if (rewritten !== concept.body) {
      const updated = { ...concept, body: rewritten };
      await store.writeConcept(updated, { overwrite: true });
      changed.push(concept.path);
    }
  }
  return changed;
}

export async function regenerateIndex(store: FileOkfStore, dir = '.'): Promise<string> {
  const normalizedDir = dir === '.' ? '' : normalizeConceptId(dir);
  const prefix = normalizedDir ? `${normalizedDir}/` : '';
  const concepts = (await store.listConcepts({ includeDrafts: false })).filter((concept) => {
    const rest = concept.conceptId.startsWith(prefix) ? concept.conceptId.slice(prefix.length) : undefined;
    return rest !== undefined && rest.length > 0 && !rest.includes('/');
  });
  const lines = ['# Index', ''];
  for (const concept of concepts.sort((a, b) => a.conceptId.localeCompare(b.conceptId))) {
    const title = concept.title ?? path.posix.basename(concept.conceptId);
    const description = concept.description ? ` - ${concept.description}` : '';
    lines.push(`* [${title}](${path.posix.basename(concept.conceptId)}.md)${description}`);
  }
  const indexPath = path.resolve(store.bundleRoot, normalizedDir, 'index.md');
  assertInsideRoot(indexPath, store.bundleRoot);
  await atomicWriteFile(indexPath, `${lines.join('\n')}\n`);
  return indexPath;
}

export async function rewriteIndex(store: FileOkfStore, dir: string, body: string, frontmatter: Record<string, unknown> | null = null): Promise<string> {
  const directory = path.resolve(store.bundleRoot, dir);
  assertInsideRoot(directory, store.bundleRoot);
  const isRoot = directory === path.resolve(store.bundleRoot);
  const indexPath = path.join(directory, 'index.md');
  let rendered: string;
  if (isRoot) {
    if (!frontmatter?.okf_version) throw new Error('bundle-root index.md frontmatter must declare okf_version');
    rendered = `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body.replace(/^\n+/, '')}`;
    if (!rendered.endsWith('\n')) rendered += '\n';
  } else {
    if (frontmatter) throw new Error('non-root index.md must not carry frontmatter');
    rendered = body.replace(/^\n+/, '');
    if (!rendered.endsWith('\n')) rendered += '\n';
  }
  await atomicWriteFile(indexPath, rendered);
  return indexPath;
}

export function summarizeRefinerResult(result: RefinerResult): string {
  const count = result.changedFiles.length;
  return `OKF update: ${count} file${count === 1 ? '' : 's'} changed`;
}

async function applyOne(store: FileOkfStore, operation: RefinerOperation): Promise<{ pathsTouched: string[]; directoriesAffected: string[]; filesWithRewrittenLinks: string[] }> {
  const pathsTouched: string[] = [];
  const directoriesAffected: string[] = [];
  const filesWithRewrittenLinks: string[] = [];
  switch (operation.type) {
    case 'create_directory': {
      const dir = path.resolve(store.bundleRoot, operation.path);
      await mkdir(dir, { recursive: true });
      pathsTouched.push(dir);
      directoriesAffected.push(dir, path.dirname(dir));
      break;
    }
    case 'create_concept': {
      await store.writeConcept(operation.concept);
      const filePath = pathForConceptId(operation.concept.conceptId, store.bundleRoot);
      pathsTouched.push(filePath);
      directoriesAffected.push(path.dirname(filePath));
      break;
    }
    case 'update_concept': {
      const concept = await store.getConcept(operation.conceptId);
      if (!concept) throw new Error(`concept not found: ${operation.conceptId}`);
      const updated = mergeConceptUpdate(concept, operation.frontmatter, operation.body);
      await store.writeConcept(updated, { overwrite: true });
      pathsTouched.push(updated.path);
      break;
    }
    case 'move_concept': {
      const source = await store.getConcept(operation.fromConceptId);
      if (!source) throw new Error(`cannot move missing concept: ${operation.fromConceptId}`);
      const targetId = normalizeConceptId(operation.toConceptId);
      const targetPath = pathForConceptId(targetId, store.bundleRoot);
      if (await exists(targetPath)) throw new Error(`destination already exists: ${operation.toConceptId}`);
      const moved: OkfConcept = { ...source, conceptId: targetId, path: targetPath };
      await store.writeConcept(moved);
      await store.deleteConcept(source.conceptId);
      pathsTouched.push(targetPath);
      directoriesAffected.push(path.dirname(source.path), path.dirname(targetPath));
      const rewritten = await rewriteInboundLinks(store, new Map([[source.conceptId, targetId]]));
      pathsTouched.push(...rewritten);
      filesWithRewrittenLinks.push(...rewritten);
      if (await directoryHasNoConcepts(path.dirname(source.path))) {
        const relDir = relativeDir(store, path.dirname(source.path));
        await store.appendLog(relDir, `**Move**: \`${path.relative(store.bundleRoot, source.path)}\` -> \`${path.relative(store.bundleRoot, targetPath)}\` (directory now empty of concepts).`);
        pathsTouched.push(path.join(path.dirname(source.path), 'log.md'));
      }
      break;
    }
    case 'delete_concept': {
      const filePath = pathForConceptId(operation.conceptId, store.bundleRoot);
      await rm(filePath, { force: true });
      pathsTouched.push(filePath);
      directoriesAffected.push(path.dirname(filePath));
      break;
    }
    case 'append_log': {
      await store.appendLog(operation.scopePath, operation.entry);
      pathsTouched.push(path.resolve(store.bundleRoot, operation.scopePath, 'log.md'));
      break;
    }
    case 'regenerate_index': {
      pathsTouched.push(await regenerateIndex(store, operation.dir ?? '.'));
      break;
    }
    case 'rewrite_index': {
      pathsTouched.push(await rewriteIndex(store, operation.dir, operation.body, operation.frontmatter ?? null));
      break;
    }
  }
  return { pathsTouched: unique(pathsTouched), directoriesAffected: unique(directoriesAffected), filesWithRewrittenLinks: unique(filesWithRewrittenLinks) };
}

function mergeConceptUpdate(concept: OkfConcept, frontmatter?: Record<string, unknown>, body?: string): OkfConcept {
  const updated: OkfConcept = {
    ...concept,
    frontmatter: { ...concept.frontmatter, ...frontmatter },
    body: body ?? concept.body,
  };
  const maybeType = updated.frontmatter.type;
  if (typeof maybeType === 'string' && maybeType.trim()) updated.type = maybeType;
  if (typeof updated.frontmatter.title === 'string') updated.title = updated.frontmatter.title;
  if (typeof updated.frontmatter.description === 'string') updated.description = updated.frontmatter.description;
  if (typeof updated.frontmatter.resource === 'string') updated.resource = updated.frontmatter.resource;
  if (typeof updated.frontmatter.timestamp === 'string') updated.timestamp = updated.frontmatter.timestamp;
  if (Array.isArray(updated.frontmatter.tags)) updated.tags = updated.frontmatter.tags.map((tag) => String(tag));
  return updated;
}

function validateConceptFrontmatter(concept: OkfConcept, where: string): void {
  const frontmatter = { ...concept.frontmatter, type: concept.type, description: concept.description, tags: concept.tags };
  for (const key of REQUIRED_CONCEPT_FRONTMATTER) {
    const value = frontmatter[key];
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0)) {
      throw new ExecutorError(`${where}: missing or empty required frontmatter field '${key}'`);
    }
  }
  if (typeof frontmatter.type !== 'string' || !frontmatter.type.trim()) throw new ExecutorError(`${where}: 'type' must be a non-empty string`);
  if (!Array.isArray(frontmatter.tags) || !frontmatter.tags.every((tag) => typeof tag === 'string' && tag.trim())) {
    throw new ExecutorError(`${where}: 'tags' must be a non-empty list of non-empty strings`);
  }
}

function checkConceptId(input: string, where: string): string {
  let normalized: string;
  try {
    normalized = normalizeConceptId(input);
  } catch (error) {
    throw new ExecutorError(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!normalized) throw new ExecutorError(`${where}: path may not be empty`);
  if (isDraftPath(normalized)) throw new ExecutorError(`${where}: path '${input}' is inside reserved 'drafts/' subtree; the runner manages draft lifecycle. Fold lessons into permanent concept paths instead.`);
  return normalized;
}

function checkDirectoryPath(store: FileOkfStore, input: string, where: string): string {
  if (!input || !input.trim()) throw new ExecutorError(`${where}: path may not be empty`);
  const target = path.resolve(store.bundleRoot, input);
  try {
    assertInsideRoot(target, store.bundleRoot);
  } catch {
    throw new ExecutorError(`${where}: path '${input}' escapes bundle root`);
  }
  const relative = path.relative(store.bundleRoot, target).replace(/\\/g, '/');
  if (relative === 'drafts' || relative.startsWith('drafts/')) {
    throw new ExecutorError(`${where}: path '${input}' is inside reserved 'drafts/' subtree; the runner manages draft lifecycle. Fold lessons into permanent concept paths instead.`);
  }
  return target;
}

async function predictedChildSetChanges(store: FileOkfStore, operations: RefinerOperation[]): Promise<Set<string>> {
  const root = path.resolve(store.bundleRoot);
  const affected = new Set<string>();
  const existing = await existingDirectories(root);
  existing.add(root);

  for (const operation of operations) {
    if (operation.type === 'create_concept') {
      const conceptDir = path.dirname(pathForConceptId(operation.concept.conceptId, root));
      walkImplicitChain(conceptDir, root, existing, affected);
      affected.add(conceptDir);
    } else if (operation.type === 'delete_concept') {
      affected.add(path.dirname(pathForConceptId(operation.conceptId, root)));
    } else if (operation.type === 'move_concept') {
      const sourceDir = path.dirname(pathForConceptId(operation.fromConceptId, root));
      const targetDir = path.dirname(pathForConceptId(operation.toConceptId, root));
      walkImplicitChain(targetDir, root, existing, affected);
      affected.add(sourceDir);
      affected.add(targetDir);
    } else if (operation.type === 'create_directory') {
      const newDir = path.resolve(root, operation.path);
      walkImplicitChain(newDir, root, existing, affected);
      existing.add(newDir);
      affected.add(newDir);
      const parent = path.dirname(newDir);
      if (isInsideOrEqual(parent, root)) affected.add(parent);
    }
  }
  return affected;
}

function rewrittenIndexDirs(store: FileOkfStore, operations: RefinerOperation[]): Set<string> {
  const dirs = new Set<string>();
  for (const operation of operations) {
    if (operation.type === 'rewrite_index') dirs.add(path.resolve(store.bundleRoot, operation.dir));
    if (operation.type === 'regenerate_index') dirs.add(path.resolve(store.bundleRoot, operation.dir ?? '.'));
  }
  return dirs;
}

function walkImplicitChain(deepestDir: string, root: string, existing: Set<string>, affected: Set<string>): void {
  const chain: string[] = [];
  let cursor = path.resolve(deepestDir);
  while (!existing.has(cursor) && cursor !== path.dirname(cursor)) {
    chain.push(cursor);
    cursor = path.dirname(cursor);
  }
  for (const newDir of chain.reverse()) {
    existing.add(newDir);
    const parent = path.dirname(newDir);
    if (isInsideOrEqual(parent, root)) affected.add(parent);
  }
}

async function existingDirectories(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.add(fullPath);
      for (const nested of await existingDirectories(fullPath)) out.add(nested);
    }
  }
  return out;
}

async function bundleIsClean(bundleRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=no', '--', path.resolve(bundleRoot)], { cwd: bundleRoot });
    return stdout.trim() === '';
  } catch {
    return false;
  }
}

async function snapshotUntracked(bundleRoot: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '--', path.resolve(bundleRoot)], { cwd: bundleRoot });
    return new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => path.resolve(bundleRoot, line)));
  } catch {
    return new Set();
  }
}

async function rollbackBundle(bundleRoot: string, preserveUntracked: Set<string>): Promise<void> {
  await execFileAsync('git', ['checkout', '--', path.resolve(bundleRoot)], { cwd: bundleRoot }).catch(() => undefined);
  const currentUntracked = await snapshotUntracked(bundleRoot);
  for (const filePath of currentUntracked) {
    if (preserveUntracked.has(filePath)) continue;
    try {
      await rm(filePath, { recursive: true, force: true });
      await pruneEmptyParents(path.dirname(filePath), path.resolve(bundleRoot), preserveUntracked);
    } catch {
      // Best effort rollback; the next clean check will surface leftovers.
    }
  }
}

async function pruneEmptyParents(start: string, root: string, preserveUntracked: Set<string>): Promise<void> {
  let cursor = path.resolve(start);
  const preservedDirs = new Set([...preserveUntracked].map((filePath) => path.dirname(filePath)));
  while (cursor !== root && isInsideOrEqual(cursor, root) && !preservedDirs.has(cursor)) {
    try {
      await rm(cursor, { recursive: false });
      cursor = path.dirname(cursor);
    } catch {
      break;
    }
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryHasNoConcepts(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return !entries.some((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md' && entry.name !== 'log.md');
}

function relativeDir(store: FileOkfStore, dir: string): string {
  const relative = path.relative(store.bundleRoot, dir).replace(/\\/g, '/');
  return relative || '.';
}

function isInsideOrEqual(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function countMoves(operations: RefinerOperation[]): number {
  return operations.filter((operation) => operation.type === 'move_concept').length;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function emptyReport(values: { error?: string } = {}): ExecutionReport {
  return {
    success: false,
    appliedOps: 0,
    pathsTouched: [],
    directoriesAffected: [],
    filesWithRewrittenLinks: [],
    moves: 0,
    rolledBack: false,
    validationErrors: [],
    ...values,
  };
}
