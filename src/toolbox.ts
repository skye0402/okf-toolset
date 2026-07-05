import type { OkfConcept, OkfSearchResult, OkfToolbox, OkfValidationError, SearchOptions, ValidationOptions } from './core/types.js';
import { isDraftPath, normalizeConceptId } from './core/paths.js';
import { OkfSearchEngine } from './search/index.js';

export class DefaultOkfToolbox implements OkfToolbox {
  constructor(readonly searchEngine: OkfSearchEngine) {}

  search(query: string, options?: SearchOptions): Promise<OkfSearchResult[]> {
    return this.searchEngine.search(query, options);
  }

  context(query: string, options?: SearchOptions): Promise<{ context: string; concepts: OkfSearchResult[] }> {
    return this.searchEngine.context(query, options);
  }

  get(conceptId: string): Promise<OkfConcept | null> {
    const normalized = normalizeConceptId(conceptId);
    if (isDraftPath(normalized)) return Promise.resolve(null);
    return this.searchEngine.store.getConcept(normalized);
  }

  validate(options?: ValidationOptions): Promise<OkfValidationError[]> {
    const maybeValidate = this.searchEngine.store as { validate?: (options?: ValidationOptions) => Promise<OkfValidationError[]> };
    return maybeValidate.validate?.(options) ?? Promise.resolve([]);
  }
}
