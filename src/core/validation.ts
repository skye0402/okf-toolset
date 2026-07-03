import path from 'node:path';
import { splitFrontmatter, splitOptionalFrontmatter } from './markdown.js';
import type { OkfConcept, OkfValidationError, ValidationOptions } from './types.js';

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;

export function parseTimestamp(value: string): Date | null {
  if (!ISO_TIMESTAMP_RE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function validateConcept(concept: OkfConcept): OkfValidationError[] {
  const errors: OkfValidationError[] = [];
  if (!concept.type.trim()) {
    errors.push({ path: concept.path, severity: 'error', code: 'missing_type', message: 'Concept frontmatter requires non-empty type.' });
  }
  if (concept.timestamp && !parseTimestamp(concept.timestamp)) {
    errors.push({ path: concept.path, severity: 'warning', code: 'invalid_timestamp', message: 'timestamp should be ISO 8601 UTC string.' });
  }
  return errors;
}

export function validateConceptMarkdown(markdown: string, filePath: string): OkfValidationError[] {
  try {
    const parsed = splitFrontmatter(markdown);
    if (typeof parsed.frontmatter.type !== 'string' || !parsed.frontmatter.type.trim()) {
      return [{ path: filePath, severity: 'error', code: 'missing_type', message: 'Concept frontmatter requires non-empty type.' }];
    }
    return [];
  } catch (error) {
    return [{ path: filePath, severity: 'error', code: 'invalid_frontmatter', message: error instanceof Error ? error.message : String(error) }];
  }
}

export function validateIndexMarkdown(markdown: string, filePath: string, bundleRoot: string, options: ValidationOptions = {}): OkfValidationError[] {
  const errors: OkfValidationError[] = [];
  const parsed = splitOptionalFrontmatter(markdown);
  const isRootIndex = path.resolve(filePath) === path.resolve(bundleRoot, 'index.md');
  if (options.strict && parsed.hasFrontmatter && !isRootIndex) {
    errors.push({ path: filePath, severity: 'error', code: 'non_root_index_frontmatter', message: 'Only bundle-root index.md may contain frontmatter.' });
  }
  return errors;
}

export function validateLogMarkdown(markdown: string, filePath: string, options: ValidationOptions = {}): OkfValidationError[] {
  if (!options.strict) return [];
  const errors: OkfValidationError[] = [];
  const dates: string[] = [];
  for (const match of markdown.matchAll(ISO_DATE_HEADING_RE)) {
    if (match[1]) dates.push(match[1]);
  }
  for (let index = 1; index < dates.length; index += 1) {
    const previous = dates[index - 1];
    const current = dates[index];
    if (previous && current && previous < current) {
      errors.push({ path: filePath, severity: 'error', code: 'log_not_newest_first', message: 'log.md date headings must be newest first.' });
      break;
    }
  }
  const badHeading = markdown.split('\n').find((line) => line.startsWith('## ') && !/^##\s+\d{4}-\d{2}-\d{2}\s*$/.test(line));
  if (badHeading) {
    errors.push({ path: filePath, severity: 'error', code: 'invalid_log_date_heading', message: 'log.md date headings must use YYYY-MM-DD.' });
  }
  return errors;
}
