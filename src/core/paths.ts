import path from 'node:path';
import { OkfPathError } from './errors.js';

export const RESERVED_FILENAMES = new Set(['index.md', 'log.md']);

export function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

export function stripLinkDecorations(input: string): string {
  return input.split('#')[0]?.split('?')[0] ?? '';
}

export function normalizeConceptId(input: string): string {
  let normalized = normalizeSlashes(stripLinkDecorations(input.trim()));
  normalized = normalized.replace(/^\.\//, '');
  normalized = normalized.replace(/^\/+/, '');
  normalized = normalized.replace(/\/+$/, '');
  if (normalized.endsWith('.md')) normalized = normalized.slice(0, -3);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new OkfPathError(`invalid concept id contains traversal: ${input}`);
  }
  return segments.join('/');
}

export function conceptIdForPath(filePath: string, bundleRoot: string): string {
  const relative = path.relative(bundleRoot, filePath);
  return normalizeConceptId(relative);
}

export function pathForConceptId(conceptId: string, bundleRoot: string): string {
  const normalized = normalizeConceptId(conceptId);
  const target = path.resolve(bundleRoot, `${normalized}.md`);
  assertInsideRoot(target, bundleRoot);
  return target;
}

export function assertInsideRoot(targetPath: string, bundleRoot: string): void {
  const root = path.resolve(bundleRoot);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new OkfPathError(`path escapes bundle root: ${targetPath}`);
  }
}

export function isReservedMarkdownPath(filePath: string): boolean {
  return RESERVED_FILENAMES.has(path.basename(filePath));
}

export function isDraftPath(filePathOrConceptId: string): boolean {
  return normalizeSlashes(filePathOrConceptId).split('/').includes('drafts');
}
