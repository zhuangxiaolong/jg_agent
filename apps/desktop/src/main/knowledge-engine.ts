import { createHash, randomUUID } from 'node:crypto';
import type { CodeIndexSymbol, KnowledgeApi, KnowledgeDocument, KnowledgeIndexJob, KnowledgeSearchHit, KnowledgeSource, Project, ProjectKnowledgeItem } from '../../../../packages/domain/src';
import { chunkKnowledgeText, scanCodeRepository, tokenizeKnowledge } from '../../../../packages/knowledge/src';
import type { LocalStore } from '../../../../packages/storage/src';
import type { GitConnector } from '../../../../packages/git-connector/src';
import { detectProductSystem } from '../../../../packages/system-detection/src';
import type { OperationManualLibrary } from './operation-manual-library';
import type { ManualProductType } from '../../../../packages/operation-manuals/src';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function scoreText(text: string, terms: string[]): number { const haystack = text.toLowerCase(); return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0); }

export class KnowledgeEngine implements KnowledgeApi {
  constructor(private readonly store: LocalStore, private readonly git: GitConnector, private readonly manuals: () => OperationManualLibrary | undefined) {}

  async listSources(): Promise<KnowledgeSource[]> {
    const sources = this.store.listKnowledgeSources();
    const now = new Date().toISOString();
    const manuals = this.manuals()?.list() ?? [];
    for (const manual of manuals) {
      const id = `manual:${manual.id}`;
      const system = ['MES5', 'MES6', 'WMS'].includes(manual.productType) ? manual.productType as 'MES5' | 'MES6' | 'WMS' : '通用';
      if (!sources.some(source => source.id === id)) sources.push({ id, kind: 'operation_manual', name: manual.name, system, status: manual.status === 'ready' ? 'active' : 'indexing', trust: 'untrusted_project_data', version: manual.manualVersion ?? manual.productVersion, contentHash: manual.sha256, createdAt: manual.createdAt, updatedAt: manual.updatedAt, lastIndexedAt: manual.updatedAt });
    }
    for (const document of this.store.listDocuments()) {
      const id = `document:${document.id}`;
      if (!sources.some(source => source.id === id)) sources.push({ id, kind: 'managed_document', name: document.name, system: document.system, status: document.enabled ? 'active' : 'disabled', trust: 'user_confirmed', contentHash: document.digest, createdAt: document.createdAt, updatedAt: document.createdAt });
    }
    return sources.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async indexProject(input: { projectId: string; sourceId?: string }): Promise<KnowledgeIndexJob> {
    const project = this.store.listProjects().find(item => item.id === input.projectId);
    if (!project) throw new Error('项目未授权，请重新选择');
    const sourceId = input.sourceId ?? `code:${project.id}`;
    const now = new Date().toISOString();
    const initial: KnowledgeIndexJob = { id: randomUUID(), sourceId, status: 'running', scannedFiles: 0, indexedFiles: 0, startedAt: now, updatedAt: now };
    this.store.saveKnowledgeIndexJob(initial);
    try {
      const state = await this.git.projectState(project);
      const result = await scanCodeRepository(project.path, project.id, sourceId, state.commits[0]?.hash);
      const detected = await detectProductSystem(project.path);
      const source: KnowledgeSource = { id: sourceId, kind: 'code_index', name: `${project.name} 代码索引`, projectId: project.id, rootPath: project.path, status: 'active', trust: 'untrusted_project_data', system: detected.system, contentHash: hash(result.files.map(file => `${file.relativePath}:${file.contentHash}`).join('\n')), createdAt: now, updatedAt: now, lastIndexedAt: now };
      this.store.saveKnowledgeSource(source);
      const documents: KnowledgeDocument[] = result.files.map(file => ({ id: `${sourceId}:${file.relativePath}`, sourceId, kind: 'code', title: file.relativePath, locator: file.relativePath, contentHash: file.contentHash, projectId: project.id, system: detected.system, updatedAt: now, metadata: { language: file.language } }));
      this.store.replaceKnowledgeDocuments(sourceId, documents);
      for (const file of result.files) this.store.replaceKnowledgeChunks(`${sourceId}:${file.relativePath}`, sourceId, project.id, chunkKnowledgeText(`${sourceId}:${file.relativePath}`, file.relativePath, file.content));
      this.store.replaceKnowledgeSymbols(project.id, sourceId, result.symbols);
      const job: KnowledgeIndexJob = { ...initial, status: 'completed', scannedFiles: result.files.length + result.skipped.length + result.errors.length, indexedFiles: result.files.length, finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(result.errors.length ? { error: `${result.errors.length} 个文件读取失败，已保留其余索引` } : {}) };
      this.store.saveKnowledgeIndexJob(job);
      return job;
    } catch (error) {
      const failed: KnowledgeIndexJob = { ...initial, status: 'failed', finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
      this.store.saveKnowledgeIndexJob(failed);
      throw error;
    }
  }

  async search(input: { query: string; system?: import('../../../../packages/domain/src').ProductSystem; projectId?: string; limit?: number }): Promise<{ hits: KnowledgeSearchHit[]; semanticSearchConfigured: boolean }> {
    const terms = tokenizeKnowledge(input.query);
    if (!terms.length) return { hits: [], semanticSearchConfigured: false };
    const limit = Math.min(input.limit ?? 20, 100);
    const hits: KnowledgeSearchHit[] = [];
    const manualTypes: ManualProductType[] = input.system && ['MES5', 'MES6', 'WMS'].includes(input.system) ? [input.system as 'MES5' | 'MES6' | 'WMS'] : ['MES5', 'MES6', 'WMS', 'SRM', 'JMOM', 'PDA', 'COMMON'];
    for (const hit of this.manuals()?.search(manualTypes, input.query, Math.min(input.limit ?? 20, 20)) ?? []) {
      const system = ['MES5', 'MES6', 'WMS'].includes(hit.manual.productType) ? hit.manual.productType as 'MES5' | 'MES6' | 'WMS' : '通用';
      hits.push({ id: `manual:${hit.manual.id}:${hit.chunk.id}`, sourceId: `manual:${hit.manual.id}`, title: hit.manual.name, text: hit.chunk.content, locator: hit.citation, score: hit.score, trust: 'user_confirmed', system, version: hit.manual.manualVersion ?? hit.manual.productVersion, reasons: ['产品操作手册关键词索引命中'] });
    }
    const documents = this.store.listKnowledgeDocuments();
    const documentById = new Map(documents.map(document => [document.id, document]));
    for (const chunk of this.store.listKnowledgeChunks({ projectId: input.projectId })) {
      const document = documentById.get(chunk.documentId);
      if (!document || input.system && document.system && document.system !== input.system) continue;
      const score = scoreText(`${document.title} ${chunk.text}`, terms);
      if (score > 0) hits.push({ id: chunk.id, sourceId: document.sourceId, documentId: document.id, title: document.title, text: chunk.text, locator: chunk.locator, score, trust: document.kind === 'code' ? 'untrusted_project_data' : 'user_confirmed', system: document.system, projectId: document.projectId, version: document.version, reasons: ['本地关键词索引命中'] });
    }
    for (const document of this.store.listDocuments().filter(item => item.enabled && (!input.system || item.system === input.system))) {
      const score = scoreText(`${document.name} ${document.content}`, terms);
      if (!score) continue;
      hits.push({ id: `document:${document.id}`, sourceId: `document:${document.id}`, title: document.name, text: document.content.slice(0, 1600), locator: document.name, score, trust: 'user_confirmed', system: document.system, reasons: ['已导入资料关键词命中'] });
    }
    return { hits: hits.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title)).slice(0, limit), semanticSearchConfigured: false };
  }

  listProjectKnowledge(projectId: string): Promise<ProjectKnowledgeItem[]> { return Promise.resolve(this.store.listProjectKnowledge(projectId)); }
  saveProjectKnowledge(item: Omit<ProjectKnowledgeItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<ProjectKnowledgeItem> {
    if (!item.confirmed || item.source !== 'user_confirmed') throw new Error('项目知识必须由用户确认后保存');
    if (!this.store.listProjects().some(project => project.id === item.projectId)) throw new Error('项目未授权');
    if (!item.title.trim() || !item.content.trim() || item.title.length > 200 || item.content.length > 20000) throw new Error('项目知识标题或内容无效');
    const now = new Date().toISOString(); const current: ProjectKnowledgeItem = { ...item, id: randomUUID(), createdAt: now, updatedAt: now };
    this.store.saveProjectKnowledge(current); return Promise.resolve(current);
  }
}

export type KnowledgeProjectResolver = (id: string) => Project;
