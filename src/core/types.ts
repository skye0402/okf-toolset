export const OKF_VERSION_SUPPORTED = '0.1' as const;

export type OkfSeverity = 'error' | 'warning';

export interface OkfConcept {
  conceptId: string;
  path: string;
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags: string[];
  timestamp?: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface OkfBundleInfo {
  bundleRoot: string;
  okfVersion?: string;
  concepts: OkfConcept[];
  warnings: OkfValidationError[];
}

export interface OkfValidationError {
  path: string;
  severity: OkfSeverity;
  code: string;
  message: string;
}

export interface ValidationOptions {
  strict?: boolean;
}

export interface OkfConceptFilter {
  type?: string | string[];
  tags?: string[];
  pathPrefix?: string;
  includeDrafts?: boolean;
  status?: string;
}

export interface WriteOptions {
  overwrite?: boolean;
}

export interface SearchOptions {
  limit?: number;
  type?: string | string[];
  tags?: string[];
  pathPrefix?: string;
  includeDrafts?: boolean;
  mode?: 'keyword' | 'embedding' | 'hybrid';
  weights?: Partial<SearchWeights>;
}

export interface SearchWeights {
  embedding: number;
  keyword: number;
  boost: number;
}

export interface OkfSearchResult {
  conceptId: string;
  path: string;
  type: string;
  title?: string;
  snippet?: string;
  mode: 'keyword' | 'embedding' | 'hybrid';
  scores: {
    keyword?: number;
    embedding?: number;
    combined: number;
  };
  citations?: OkfCitation[];
  links?: OkfLink[];
}

export interface OkfToolbox {
  search(query: string, options?: SearchOptions): Promise<OkfSearchResult[]>;
  context(query: string, options?: SearchOptions): Promise<{ context: string; concepts: OkfSearchResult[] }>;
  get(conceptId: string): Promise<OkfConcept | null>;
  validate(options?: ValidationOptions): Promise<OkfValidationError[]>;
}

export interface OkfStore {
  scanBundle(): Promise<OkfConcept[]>;
  getConcept(conceptId: string): Promise<OkfConcept | null>;
  listConcepts(filter?: OkfConceptFilter): Promise<OkfConcept[]>;
  writeConcept(concept: OkfConcept, options?: WriteOptions): Promise<void>;
}

export interface RootIndexDocument {
  frontmatter: Record<string, unknown>;
  body: string;
  okfVersion?: string;
}

export interface OkfLink {
  raw: string;
  text: string;
  target: string;
  conceptId?: string;
  external: boolean;
}

export interface OkfCitation {
  number: number;
  text: string;
  target: string;
}

export interface DraftInput {
  title: string;
  description?: string;
  body: string;
  sourceRun?: string;
  proposedType?: string;
  tags?: string[];
}
