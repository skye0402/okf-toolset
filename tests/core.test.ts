import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { extractCitations, extractOkfLinks, normalizeConceptId, parseConcept, parseRootIndex, parseTimestamp, renderConceptMarkdown, rewriteConceptLinks, validateIndexMarkdown, validateLogMarkdown } from '../src/index.js';

const fixtureRoot = path.resolve('tests/fixtures/minimal');

describe('OKF core', () => {
  it('parses and renders concepts while preserving extension frontmatter', async () => {
    const filePath = path.join(fixtureRoot, 'orders.md');
    const concept = parseConcept(await readFile(filePath, 'utf8'), filePath, fixtureRoot);
    expect(concept.conceptId).toBe('orders');
    expect(concept.type).toBe('BigQuery Table');
    expect(concept.tags).toEqual(['sales', 'orders']);
    concept.frontmatter.producer = 'unit-test';
    expect(renderConceptMarkdown(concept)).toContain('producer: unit-test');
    expect(renderConceptMarkdown(concept)).toContain('type: BigQuery Table');
  });

  it('strips all leading body newlines after frontmatter', () => {
    const concept = parseConcept('---\ntype: Reference\n---\n\n\nBody\n', '/tmp/bundle/a.md', '/tmp/bundle');
    expect(concept.body).toBe('Body\n');
  });

  it('reads root index okf_version frontmatter', async () => {
    const parsed = parseRootIndex(await readFile(path.join(fixtureRoot, 'index.md'), 'utf8'));
    expect(parsed.okfVersion).toBe('0.1');
  });

  it('normalizes concept IDs safely', () => {
    expect(normalizeConceptId('/apps\\sap/foo.md#section')).toBe('apps/sap/foo');
    expect(() => normalizeConceptId('../secret.md')).toThrow(/traversal/);
  });

  it('extracts links and citations separately', async () => {
    const concept = parseConcept(await readFile(path.join(fixtureRoot, 'orders.md'), 'utf8'), path.join(fixtureRoot, 'orders.md'), fixtureRoot);
    expect(extractOkfLinks(concept.body, concept.conceptId).some((link) => link.conceptId === 'customers')).toBe(true);
    expect(extractCitations(concept.body)[0]?.target).toBe('https://example.com/orders-docs');
  });

  it('rewrites moved links without dropping fragments query strings or titles', () => {
    const moves = new Map([['apps/sap/value-help', 'apps/sap/fiori/value-help']]);
    const rewritten = rewriteConceptLinks('[X](/apps/sap/value-help.md?x=1#usage "title")', 'apps/sap/source', moves);
    expect(rewritten).toBe('[X](/apps/sap/fiori/value-help.md?x=1#usage "title")');
  });

  it('validates strict index/log conventions', () => {
    expect(validateIndexMarkdown('---\nx: y\n---\n# Bad', path.join(fixtureRoot, 'sub/index.md'), fixtureRoot, { strict: true })[0]?.code).toBe('non_root_index_frontmatter');
    expect(validateLogMarkdown('# Log\n## 2026-01-01\n* A\n## 2026-02-01\n* B\n', 'log.md', { strict: true })[0]?.code).toBe('log_not_newest_first');
  });

  it('keeps timestamp strings and exposes parser', () => {
    expect(parseTimestamp('2026-07-03T00:00:00Z')).toBeInstanceOf(Date);
    expect(parseTimestamp('2026-07-03T00:00:00+09:00')).toBeInstanceOf(Date);
    expect(parseTimestamp('2026-07-03')).toBeNull();
  });
});
