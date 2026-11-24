import type { ProductSystem } from './index';

export type KnowledgeSourceKind = 'operation_manual' | 'managed_document' | 'project_file' | 'code_index' | 'project_memory' | 'expert';
export type KnowledgeTrust = 'system' | 'user_confirmed' | 'untrusted_project_data' | 'inferred';
export type KnowledgeSourceStatus = 'active' | 'disabled' | 'error' | 'indexing';
export type KnowledgeDocumentKind = 'manual' | 'requirement' | 'dictionary' | 'code' | 'memory' | 'expert';

export interface KnowledgeSource {
  id: string;
  kind: KnowledgeSourceKind;
  name: string;
  system?: ProductSystem;
  projectId?: string;
  rootPath?: string;
  status: KnowledgeSourceStatus;
  trust: KnowledgeTrust;
  version?: string;
  contentHash?: string;
  createdAt: string;
  updatedAt: string;
  lastIndexedAt?: string;
  error?: string;
}

export interface KnowledgeDocument {
  id: string;
  sourceId: string;
  kind: KnowledgeDocumentKind;
  title: string;
  locator: string;
  contentHash: string;
  version?: string;
  system?: ProductSystem;
  projectId?: string;
  updatedAt: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  contentHash: string;
  locator: string;
  tokenTerms: string[];
}

export interface KnowledgeSearchHit {
  id: string;
  sourceId: string;
  documentId?: string;
  title: string;
  text: string;
  locator: string;
  score: number;
  trust: KnowledgeTrust;
  system?: ProductSystem;
  projectId?: string;
  version?: string;
  reasons: string[];
}

export interface CodeIndexSymbol {
  id: string;
  sourceId: string;
  projectId: string;
  filePath: string;
  language: string;
  kind: 'class' | 'interface' | 'struct' | 'enum' | 'function' | 'method' | 'sql-table' | 'sql-view' | 'unknown';
  name: string;
  line: number;
  signature?: string;
  contentHash: string;
  commitHash?: string;
}

export interface KnowledgeRelation {
  id: string;
  fromId: string;
  toId: string;
  relation: 'calls' | 'references' | 'maps-to' | 'belongs-to' | 'derived-from';
  trust: KnowledgeTrust;
  evidence?: string;
  createdAt: string;
}

export interface ProjectKnowledgeItem {
  id: string;
  projectId: string;
  title: string;
  content: string;
  source: 'user_confirmed' | 'session_extract';
  confirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeIndexJob {
  id: string;
  sourceId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  scannedFiles: number;
  indexedFiles: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface KnowledgeApi {
  listSources(): Promise<KnowledgeSource[]>;
  search(input: { query: string; system?: ProductSystem; projectId?: string; limit?: number }): Promise<{ hits: KnowledgeSearchHit[]; semanticSearchConfigured: boolean }>;
  indexProject(input: { projectId: string; sourceId?: string }): Promise<KnowledgeIndexJob>;
  listProjectKnowledge(projectId: string): Promise<ProjectKnowledgeItem[]>;
  saveProjectKnowledge(item: Omit<ProjectKnowledgeItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<ProjectKnowledgeItem>;
}
