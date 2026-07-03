import YAML from 'yaml';
import type { OkfConcept, RootIndexDocument } from './types.js';
import { conceptIdForPath } from './paths.js';

export function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('missing YAML frontmatter');
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new Error('unterminated YAML frontmatter');
  }
  const rawFrontmatter = normalized.slice(4, end);
  const parsed = YAML.parse(rawFrontmatter) ?? {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter must be a mapping');
  }
  return {
    frontmatter: parsed as Record<string, unknown>,
    body: normalized.slice(end + '\n---\n'.length).replace(/^\n+/, ''),
  };
}

export function splitOptionalFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string; hasFrontmatter: boolean } {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, body: normalized, hasFrontmatter: false };
  }
  const parsed = splitFrontmatter(normalized);
  return { ...parsed, hasFrontmatter: true };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function parseConcept(markdown: string, path: string, bundleRoot: string): OkfConcept {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const type = asString(frontmatter.type);
  if (!type) {
    throw new Error(`${path} missing required OKF type`);
  }
  const concept: OkfConcept = {
    conceptId: conceptIdForPath(path, bundleRoot),
    path,
    type,
    tags: asTags(frontmatter.tags),
    frontmatter,
    body,
  };
  const title = asString(frontmatter.title);
  const description = asString(frontmatter.description);
  const resource = asString(frontmatter.resource);
  const timestamp = asString(frontmatter.timestamp);
  if (title) concept.title = title;
  if (description) concept.description = description;
  if (resource) concept.resource = resource;
  if (timestamp) concept.timestamp = timestamp;
  return concept;
}

export function parseRootIndex(markdown: string): RootIndexDocument {
  const parsed = splitOptionalFrontmatter(markdown);
  const okfVersion = typeof parsed.frontmatter.okf_version === 'string' ? parsed.frontmatter.okf_version : undefined;
  const result: RootIndexDocument = {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  };
  if (okfVersion) result.okfVersion = okfVersion;
  return result;
}

export function renderConceptMarkdown(concept: OkfConcept): string {
  const frontmatter: Record<string, unknown> = { ...concept.frontmatter, type: concept.type };
  if (concept.title !== undefined) frontmatter.title = concept.title;
  if (concept.description !== undefined) frontmatter.description = concept.description;
  if (concept.resource !== undefined) frontmatter.resource = concept.resource;
  if (concept.tags.length > 0) frontmatter.tags = concept.tags;
  if (concept.timestamp !== undefined) frontmatter.timestamp = concept.timestamp;
  const yaml = YAML.stringify(frontmatter).trimEnd();
  return `---\n${yaml}\n---\n${concept.body.trim()}\n`;
}
