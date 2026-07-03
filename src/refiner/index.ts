import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { OkfConcept, OkfValidationError, ValidationOptions } from '../core/types.js';
import { normalizeConceptId, pathForConceptId } from '../core/paths.js';
import { extractOkfLinks, rewriteConceptLinks } from '../core/links.js';
import { renderConceptMarkdown } from '../core/markdown.js';
import { atomicWriteFile } from '../fs/atomic.js';
import { FileOkfStore } from '../fs/store.js';

export type RefinerOperation =
  | { type: 'create_directory'; path: string }
  | { type: 'create_concept'; concept: OkfConcept }
  | { type: 'update_concept'; conceptId: string; frontmatter?: Record<string, unknown>; body?: string }
  | { type: 'move_concept'; fromConceptId: string; toConceptId: string }
  | { type: 'delete_concept'; conceptId: string }
  | { type: 'append_log'; scopePath: string; entry: string }
  | { type: 'regenerate_index'; dir?: string };

export interface RefinerResult {
  changedFiles: string[];
  warnings: string[];
  validationErrors: OkfValidationError[];
}

export interface RefinerExecuteOptions {
  validation?: ValidationOptions;
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
          const updated: OkfConcept = {
            ...concept,
            frontmatter: { ...concept.frontmatter, ...operation.frontmatter },
            body: operation.body ?? concept.body,
          };
          const maybeType = updated.frontmatter.type;
          if (typeof maybeType === 'string' && maybeType.trim()) updated.type = maybeType;
          if (typeof updated.frontmatter.title === 'string') updated.title = updated.frontmatter.title;
          if (typeof updated.frontmatter.description === 'string') updated.description = updated.frontmatter.description;
          if (typeof updated.frontmatter.resource === 'string') updated.resource = updated.frontmatter.resource;
          if (typeof updated.frontmatter.timestamp === 'string') updated.timestamp = updated.frontmatter.timestamp;
          if (Array.isArray(updated.frontmatter.tags)) updated.tags = updated.frontmatter.tags.map((tag) => String(tag));
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
      }
    }

    if (moves.size > 0) {
      const rewritten = await rewriteInboundLinks(this.store, moves);
      changedFiles.push(...rewritten);
    }

    const validationErrors = await this.store.validate(options.validation ?? {});
    return { changedFiles: [...new Set(changedFiles)], warnings, validationErrors };
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

export async function rewriteInboundLinks(store: FileOkfStore, moves: Map<string, string>): Promise<string[]> {
  const changed: string[] = [];
  for (const concept of await store.scanBundle()) {
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
  await atomicWriteFile(indexPath, `${lines.join('\n')}\n`);
  return indexPath;
}

export function summarizeRefinerResult(result: RefinerResult): string {
  const count = result.changedFiles.length;
  return `OKF update: ${count} file${count === 1 ? '' : 's'} changed`;
}
