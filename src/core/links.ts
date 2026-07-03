import path from 'node:path';
import type { OkfCitation, OkfLink } from './types.js';
import { normalizeConceptId, normalizeSlashes, stripLinkDecorations } from './paths.js';

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+?)(\s+"[^"]*")?\)/g;
const CITATIONS_HEADING_RE = /^#\s+Citations\s*$/im;
const CITATION_LINE_RE = /^\[(\d+)\]\s+\[([^\]]+)\]\(([^)]+)\)/gm;

export function resolveOkfLink(target: string, fromConceptId: string): string | undefined {
  const undecorated = stripLinkDecorations(target.trim());
  if (!undecorated || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(undecorated)) return undefined;
  if (undecorated.startsWith('/')) return normalizeConceptId(undecorated);
  const fromDir = path.posix.dirname(normalizeSlashes(fromConceptId));
  const resolved = path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, undecorated));
  try {
    return normalizeConceptId(resolved);
  } catch {
    return undefined;
  }
}

export function extractOkfLinks(body: string, fromConceptId: string): OkfLink[] {
  const links: OkfLink[] = [];
  for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
    const text = match[1] ?? '';
    const target = match[2] ?? '';
    const conceptId = resolveOkfLink(target, fromConceptId);
    links.push({ raw: match[0] ?? '', text, target, external: conceptId === undefined, ...(conceptId ? { conceptId } : {}) });
  }
  return links;
}

export function extractCitations(body: string): OkfCitation[] {
  const headingMatch = body.match(CITATIONS_HEADING_RE);
  if (!headingMatch || headingMatch.index === undefined) return [];
  const citationsBody = body.slice(headingMatch.index + headingMatch[0].length);
  const citations: OkfCitation[] = [];
  for (const match of citationsBody.matchAll(CITATION_LINE_RE)) {
    citations.push({ number: Number(match[1]), text: match[2] ?? '', target: match[3] ?? '' });
  }
  return citations;
}

export function rewriteConceptLinks(body: string, fromConceptId: string, moves: Map<string, string>): string {
  return body.replace(MARKDOWN_LINK_RE, (raw, text: string, target: string, titleSuffix = '') => {
    const resolved = resolveOkfLink(target, fromConceptId);
    if (!resolved) return raw;
    const replacement = moves.get(resolved);
    if (!replacement) return raw;
    return `[${text}](/${replacement}.md${linkSuffix(target)}${titleSuffix})`;
  });
}

function linkSuffix(target: string): string {
  const hashIndex = target.indexOf('#');
  const queryIndex = target.indexOf('?');
  const indices = [hashIndex, queryIndex].filter((index) => index >= 0).sort((a, b) => a - b);
  return indices.length ? target.slice(indices[0]!) : '';
}
