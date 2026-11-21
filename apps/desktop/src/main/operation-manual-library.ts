import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { stageManualIndex } from './manual-index-stage';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { LocalStore } from '../../../../packages/storage/src';
import { formatManualCitation, tokenizeManualQuery, type ManualImportJob, type ManualImportResult, type ManualProductType, type OperationManual, type ParsedManualDocument } from '../../../../packages/operation-manuals/src';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILES_PER_IMPORT = 20;
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.md', '.txt', '.html', '.htm']);

export interface ManualMetadataInput {
  productType: ManualProductType;
  productVersion?: string;
  manualVersion?: string;
  effectiveDate?: string;
  scopeNote?: string;
}

export interface BundledManualInput extends ManualMetadataInput {
  id: string;
  name: string;
  filename: string;
}

export class OperationManualLibrary {
  private readonly queue: string[] = [];
  private readonly activeWorkers = new Map<string, Worker>();
  private readonly digestLocks = new Map<string, Promise<void>>();
  private processing?: Promise<void>;
  private closed = false;
  private readonly originalsRoot: string;

  constructor(private readonly store: LocalStore, private readonly dataRoot: string, private readonly workerPath: string) {
    this.originalsRoot = path.resolve(dataRoot, 'knowledge', 'manuals', 'originals');
    this.recoverInterruptedJobs();
    this.startQueue(true);
  }

  list(): OperationManual[] { return this.store.listOperationManuals(); }

  async ensureBundledManuals(entries: BundledManualInput[]): Promise<{ installed: number; skipped: number }> {
    let installed = 0;
    for (const entry of entries) {
      const existing = this.store.getOperationManual(entry.id);
      if (existing) {
        if (!existing.bundled) throw new Error(`内置手册标识冲突：${entry.id}`);
        installed += 0;
        continue;
      }
      const imported = await this.importFile(entry.filename, entry, { id: entry.id, bundled: true, name: entry.name });
      if ('manual' in imported) installed += 1;
    }
    return { installed, skipped: entries.length - installed };
  }

  get(id: string): { manual: OperationManual; chunks: ReturnType<LocalStore['listOperationManualChunks']>; jobs: ManualImportJob[] } | undefined {
    const manual = this.store.getOperationManual(id);
    return manual ? { manual, chunks: this.store.listOperationManualChunks(id, 20), jobs: this.store.listOperationManualJobs(id) } : undefined;
  }

  async importFiles(files: string[], metadata: ManualMetadataInput): Promise<ManualImportResult>;
  async importFiles(files: Array<{ filename: string; metadata: ManualMetadataInput }>): Promise<ManualImportResult>;
  async importFiles(files: string[] | Array<{ filename: string; metadata: ManualMetadataInput }>, sharedMetadata?: ManualMetadataInput): Promise<ManualImportResult> {
    const entries = files.length && typeof files[0] === 'string'
      ? (files as string[]).map(filename => ({ filename, metadata: sharedMetadata }))
      : files as Array<{ filename: string; metadata: ManualMetadataInput }>;
    if (!entries.length || entries.length > MAX_FILES_PER_IMPORT || entries.some(item => !item.metadata)) throw new Error(`每次可导入 1 至 ${MAX_FILES_PER_IMPORT} 份手册，并为每份手册指定产品分类。`);
    const result: ManualImportResult = { imported: [], duplicates: [], errors: [] };
    for (const { filename, metadata } of entries) {
      try {
        const imported = await this.importFile(filename, metadata!);
        if ('duplicate' in imported) result.duplicates.push(imported.duplicate);
        else result.imported.push(imported.manual);
      } catch (error) {
        result.errors.push({ fileName: path.basename(filename), message: error instanceof Error ? error.message : '导入失败。' });
      }
    }
    return result;
  }

  async replaceFile(id: string, filename: string): Promise<ManualImportJob> {
    const manual = this.store.getOperationManual(id);
    if (!manual) throw new Error('手册不存在。');
    if (this.store.listOperationManualJobs(id).some(job => job.status === 'queued' || job.status === 'running')) throw new Error('该手册正在处理，请等待当前任务结束后再替换。');
    const sourceStat = await lstat(filename);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('只允许选择普通文件。');
    if (sourceStat.size < 1 || sourceStat.size > MAX_FILE_BYTES) throw new Error(`文件大小必须不超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB。`);
    const extension = path.extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error('仅支持 PDF、DOCX、XLSX、PPTX、MD、TXT、HTML。旧版 DOC、XLS、PPT 请另存为新格式。');
    const canonicalPath = await realpath(filename);
    const sourceBefore = await stat(canonicalPath);
    if (!sourceBefore.isFile() || sourceBefore.size !== sourceStat.size || sourceBefore.mtimeMs !== sourceStat.mtimeMs) throw new Error('源文件在选择期间发生变化，请重新选择。');
    const sha256 = await this.hashFile(canonicalPath);
    if (sha256 === manual.sha256) throw new Error('所选文件与当前手册内容相同，无需替换。');
    const duplicate = this.store.findOperationManualByDigest(manual.productType, sha256);
    if (duplicate && duplicate.id !== manual.id) throw new Error(`该文件已存在于手册“${duplicate.name}”中。`);
    const now = new Date().toISOString();
    const jobId = randomUUID();
    const originalName = path.basename(filename);
    const directory = path.join(this.originalsRoot, manual.id);
    await mkdir(directory, { recursive: true });
    const storedFile = path.join(directory, `replacement-${jobId}${extension}`);
    try {
      await copyFile(canonicalPath, storedFile);
      const sourceAfter = await stat(canonicalPath);
      if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs || sourceBefore.ino !== sourceAfter.ino) throw new Error('复制过程中源文件发生变化，替换未提交。');
      const storedStat = await stat(storedFile);
      if (storedStat.size !== sourceBefore.size || await this.hashFile(storedFile) !== sha256) throw new Error('复制后的原始文件校验失败，替换未提交。');
      const replacement = {
        originalName,
        originalStorageKey: path.relative(this.dataRoot, storedFile).split(path.sep).join('/'),
        fileExtension: extension,
        fileSize: storedStat.size,
        sha256,
      };
      const job: ManualImportJob = { id: jobId, manualId: manual.id, status: 'queued', stage: 'copy', progress: 5, updatedAt: now };
      this.store.beginOperationManualReplacement({ ...manual, pendingReplacement: replacement, updatedAt: now }, job);
      this.queue.push(job.id);
      this.startQueue();
      return job;
    } catch (error) {
      await rm(storedFile, { force: true });
      throw error;
    }
  }

  private async importFile(filename: string, metadata: ManualMetadataInput, options: { id?: string; bundled?: boolean; name?: string } = {}): Promise<{ manual: OperationManual } | { duplicate: OperationManual }> {
    const sourceStat = await lstat(filename);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('只允许选择普通文件。');
    if (sourceStat.size < 1 || sourceStat.size > MAX_FILE_BYTES) throw new Error(`文件大小必须不超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB。`);
    const extension = path.extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error('仅支持 PDF、DOCX、XLSX、PPTX、MD、TXT、HTML。旧版 DOC、XLS、PPT 请另存为新格式。');
    const canonicalPath = await realpath(filename);
    const sourceBefore = await stat(canonicalPath);
    if (!sourceBefore.isFile() || sourceBefore.size !== sourceStat.size || sourceBefore.mtimeMs !== sourceStat.mtimeMs) throw new Error('源文件在选择期间发生变化，请重新选择。');
    const sha256 = await this.hashFile(canonicalPath);
    const previousLock = this.digestLocks.get(`${metadata.productType}:${sha256}`);
    if (previousLock) await previousLock;
    const lockKey = `${metadata.productType}:${sha256}`;
    let releaseLock!: () => void;
    const lock = new Promise<void>(resolve => { releaseLock = resolve; });
    this.digestLocks.set(lockKey, lock);
    try {
      const duplicate = this.store.findOperationManualByDigest(metadata.productType, sha256);
      if (duplicate) return { duplicate };
      const id = options.id ?? randomUUID();
      const now = new Date().toISOString();
      const originalName = path.basename(filename);
      const safeName = originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 160) || `手册${extension}`;
      const directory = path.join(this.originalsRoot, id);
      await mkdir(directory, { recursive: true });
      const storedFile = path.join(directory, safeName);
      try {
        await copyFile(canonicalPath, storedFile);
        const sourceAfter = await stat(canonicalPath);
        if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs || sourceBefore.ino !== sourceAfter.ino) throw new Error('复制过程中源文件发生变化，未完成导入。');
        const storedStat = await stat(storedFile);
        if (storedStat.size !== sourceBefore.size) throw new Error('原始文件复制不完整。');
        if (await this.hashFile(storedFile) !== sha256) throw new Error('复制后的原始文件与已校验内容不一致，未完成导入。');
        const storageKey = path.relative(this.dataRoot, storedFile).split(path.sep).join('/');
        const manual: OperationManual = {
          id, name: options.name ?? (originalName.replace(/\.[^.]+$/, '').slice(0, 200) || originalName),
          productType: metadata.productType, ...(metadata.productVersion ? { productVersion: metadata.productVersion } : {}),
          ...(metadata.manualVersion ? { manualVersion: metadata.manualVersion } : {}), ...(metadata.effectiveDate ? { effectiveDate: metadata.effectiveDate } : {}),
          ...(metadata.scopeNote ? { scopeNote: metadata.scopeNote } : {}), originalName, originalStorageKey: storageKey,
          fileExtension: extension, fileSize: storedStat.size, sha256, status: 'pending', ...(options.bundled ? { bundled: true } : {}), extractedChars: 0, chunkCount: 0, createdAt: now, updatedAt: now,
        };
        this.store.saveOperationManual(manual);
        const job: ManualImportJob = { id: randomUUID(), manualId: id, status: 'queued', stage: 'validate', progress: 0, updatedAt: now };
        this.store.saveOperationManualJob(job);
        this.queue.push(job.id);
        this.startQueue();
        return { manual };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    } finally {
      releaseLock();
      if (this.digestLocks.get(lockKey) === lock) this.digestLocks.delete(lockKey);
    }
  }

  async update(id: string, patch: Partial<Pick<OperationManual, 'name' | 'productType' | 'productVersion' | 'manualVersion' | 'effectiveDate' | 'scopeNote'>>): Promise<OperationManual> {
    const current = this.store.getOperationManual(id);
    if (!current) throw new Error('手册不存在。');
    const updated: OperationManual = { ...current, ...patch, name: patch.name?.trim() || current.name, updatedAt: new Date().toISOString() };
    if (patch.name !== undefined && (!patch.name.trim() || patch.name.trim().length > 200)) throw new Error('手册名称必须为 1 至 200 个字符。');
    this.store.saveOperationManual(updated);
    return updated;
  }

  setEnabled(id: string, enabled: boolean): OperationManual {
    const current = this.store.getOperationManual(id);
    if (!current) throw new Error('手册不存在。');
    const status = enabled ? (current.resumeStatus ?? (current.chunkCount ? 'ready' : current.errorSummary ? 'failed' : 'pending')) : 'disabled';
    const updated: OperationManual = {
      ...current, status, updatedAt: new Date().toISOString(),
      ...(enabled ? { resumeStatus: undefined } : { resumeStatus: current.status === 'disabled' ? current.resumeStatus : current.status === 'processing' ? (current.chunkCount ? 'ready' : 'pending') : current.status }),
    };
    this.store.saveOperationManual(updated);
    if (enabled && !current.chunkCount) this.reparse(id);
    return updated;
  }

  reparse(id: string): ManualImportJob {
    const manual = this.store.getOperationManual(id);
    if (!manual) throw new Error('手册不存在。');
    const existing = this.store.listOperationManualJobs(id).find(job => job.status === 'queued' || job.status === 'running');
    if (existing) return existing;
    const job: ManualImportJob = { id: randomUUID(), manualId: id, status: 'queued', stage: 'validate', progress: 0, updatedAt: new Date().toISOString() };
    if (!manual.chunkCount) this.store.saveOperationManual({ ...manual, status: 'pending', updatedAt: job.updatedAt });
    this.store.saveOperationManualJob(job);
    this.queue.push(job.id);
    this.startQueue();
    return job;
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.store.getOperationManualJob(jobId);
    if (!job || !['queued', 'running'].includes(job.status)) return false;
    const worker = this.activeWorkers.get(job.id);
    if (worker) await worker.terminate();
    const now = new Date().toISOString();
    this.store.saveOperationManualJob({ ...job, status: 'cancelled', stage: 'finalize', progress: job.progress, errorMessage: '用户已取消。', finishedAt: now, updatedAt: now });
    const manual = this.store.getOperationManual(job.manualId);
    if (manual?.pendingReplacement) {
      await rm(this.resolveStoredFile(manual.pendingReplacement.originalStorageKey), { force: true });
      this.store.saveOperationManual({
        ...manual, pendingReplacement: undefined,
        status: manual.status === 'disabled' ? 'disabled' : manual.chunkCount ? (manual.status === 'partial' ? 'partial' : 'ready') : 'pending',
        updatedAt: now,
      });
    } else if (manual && !manual.chunkCount && manual.status !== 'disabled') this.store.saveOperationManual({ ...manual, status: 'pending', updatedAt: now });
    this.startQueue();
    return true;
  }

  async delete(id: string): Promise<void> {
    const manual = this.store.getOperationManual(id);
    if (!manual) return;
    if (manual.bundled) throw new Error('安装包内置手册不能删除，可停用或重新上传替换。');
    for (const job of this.store.listOperationManualJobs(id).filter(item => item.status === 'queued' || item.status === 'running')) await this.cancel(job.id);
    const sourcePath = this.resolveStoredFile(manual.originalStorageKey);
    const directory = path.dirname(sourcePath);
    const quarantineRoot = path.resolve(this.dataRoot, 'knowledge', 'manuals', 'deleted');
    const quarantine = path.join(quarantineRoot, id);
    await mkdir(quarantineRoot, { recursive: true });
    let moved = false;
    try {
      await rename(directory, quarantine);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      this.store.deleteOperationManual(id);
      if (moved) await rm(quarantine, { recursive: true, force: true });
    } catch (error) {
      if (moved) await rename(quarantine, directory).catch(() => undefined);
      throw error;
    }
  }

  search(productTypes: ManualProductType[], query: string, limit = 20) {
    const terms = tokenizeManualQuery(query);
    const selected = this.store.searchOperationManualChunks(productTypes, terms, Math.max(1, Math.min(100, limit * 4)));
    const unique = new Set<string>();
    return selected
      .sort((left, right) => right.score - left.score || Number(right.manual.productType !== 'COMMON') - Number(left.manual.productType !== 'COMMON') || (right.manual.effectiveDate ?? '').localeCompare(left.manual.effectiveDate ?? '') || right.manual.updatedAt.localeCompare(left.manual.updatedAt))
      .filter(item => {
        const identity = `${item.manual.productType}:${item.chunk.contentHash}`;
        if (unique.has(identity)) return false;
        unique.add(identity);
        return true;
      })
      .slice(0, Math.max(1, Math.min(20, limit)))
      .map(item => ({ ...item, citation: formatManualCitation(item.manual, item.chunk) }));
  }

  private resolveStoredFile(storageKey: string): string {
    const file = path.resolve(this.dataRoot, ...storageKey.split('/'));
    const relative = path.relative(this.originalsRoot, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('手册文件存储位置无效。');
    return file;
  }

  private async hashFile(filename: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filename);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return hash.digest('hex');
  }

  private recoverInterruptedJobs(): void {
    const now = new Date().toISOString();
    for (const job of this.store.listOperationManualJobs().filter(item => item.status === 'running' || item.status === 'queued')) {
      this.store.saveOperationManualJob({ ...job, status: 'failed', stage: 'finalize', errorMessage: '应用关闭时解析尚未完成，请重新解析。', finishedAt: now, updatedAt: now });
      const manual = this.store.getOperationManual(job.manualId);
      if (manual?.pendingReplacement) {
        void rm(this.resolveStoredFile(manual.pendingReplacement.originalStorageKey), { force: true }).catch(() => undefined);
        this.store.saveOperationManual({
          ...manual, pendingReplacement: undefined,
          status: manual.status === 'disabled' ? 'disabled' : manual.chunkCount ? (manual.status === 'partial' ? 'partial' : 'ready') : 'failed',
          ...(!manual.chunkCount && manual.status !== 'disabled' ? { errorSummary: '替换期间应用关闭，原手册内容已保留，请重新替换。' } : {}),
          updatedAt: now,
        });
      } else if (manual && !manual.chunkCount && manual.status !== 'disabled') this.store.saveOperationManual({ ...manual, status: 'failed', errorSummary: '应用关闭时解析尚未完成，请重新解析。', updatedAt: now });
    }
    for (const manual of this.store.listOperationManuals().filter(item => item.pendingReplacement)) {
      if (this.store.listOperationManualJobs(manual.id).some(job => job.status === 'queued' || job.status === 'running')) continue;
      const pending = manual.pendingReplacement!;
      void rm(this.resolveStoredFile(pending.originalStorageKey), { force: true }).catch(() => undefined);
      this.store.saveOperationManual({
        ...manual, pendingReplacement: undefined,
        status: manual.status === 'disabled' ? 'disabled' : manual.chunkCount ? (manual.status === 'partial' ? 'partial' : 'ready') : 'failed',
        ...(!manual.chunkCount && manual.status !== 'disabled' ? { errorSummary: '替换未完成，原手册内容已保留，请重新替换。' } : {}),
        updatedAt: now,
      });
    }
    for (const manual of this.store.listOperationManuals().filter(item => item.status === 'processing')) {
      this.store.saveOperationManual({ ...manual, status: manual.chunkCount ? 'ready' : 'failed', errorSummary: manual.chunkCount ? manual.errorSummary : '应用关闭时解析尚未完成，请重新解析。', updatedAt: now });
    }
  }

  private startQueue(cleanup = false): void {
    if (this.closed || this.processing) return;
    const jobId = this.queue.shift();
    if (!jobId && !cleanup) return;
    this.processing = (async () => {
      if (jobId) await this.process(jobId);
      await this.store.cleanInactiveManualIndexes(() => this.closed);
    })().catch(() => console.warn('[operation-manuals] 手册任务或旧索引清理失败')).finally(() => {
      this.processing = undefined;
      this.startQueue();
    });
  }

  private async process(jobId: string): Promise<void> {
    const job = this.store.getOperationManualJob(jobId);
    const manual = job ? this.store.getOperationManual(job.manualId) : undefined;
    if (!job || !manual || job.status !== 'queued') return;
    const now = new Date().toISOString();
    const current = { ...job, status: 'running' as const, stage: 'parse' as const, progress: 20, startedAt: now, updatedAt: now };
    this.store.saveOperationManualJob(current);
    const wasDisabled = manual.status === 'disabled';
    if (!manual.chunkCount && !wasDisabled) this.store.saveOperationManual({ ...manual, status: 'processing', updatedAt: now });
    let stageDirectory: string | undefined;
    try {
      const inputPath = this.resolveStoredFile(manual.pendingReplacement?.originalStorageKey ?? manual.originalStorageKey);
      stageDirectory = await mkdtemp(path.join(tmpdir(), 'jinggong-manual-index-'));
      if (this.closed || this.store.getOperationManualJob(job.id)?.status !== 'running') return;
      const stagePath = path.join(stageDirectory, 'index.db');
      const { document, chunkCount } = await this.parseInWorker(inputPath, job.id, manual, stagePath);
      const latestJob = this.store.getOperationManualJob(job.id);
      if (!latestJob || latestJob.status === 'cancelled' || this.closed) return;
      const parseComplete = { ...latestJob, stage: 'chunk' as const, progress: 65, updatedAt: new Date().toISOString() };
      this.store.saveOperationManualJob(parseComplete);
      if (!chunkCount) throw new Error('解析结果未生成有效知识片段。');
      if (!await this.store.copyManualIndex(manual, stagePath, job.id, () => !this.closed && this.store.getOperationManualJob(job.id)?.status === 'running')) return;
      const latestManual = this.store.getOperationManual(manual.id)!;
      const finishedAt = new Date().toISOString();
      const isDisabled = wasDisabled || latestManual.status === 'disabled';
      const oldStorageKey = latestManual.originalStorageKey;
      const pendingReplacement = latestManual.pendingReplacement;
      const indexedManual: OperationManual = {
        ...latestManual, status: isDisabled ? 'disabled' : document.warnings.length ? 'partial' : 'ready',
        ...(isDisabled ? { resumeStatus: document.warnings.length ? 'partial' : 'ready' } : { resumeStatus: undefined }),
        ...(pendingReplacement ? {
          originalName: pendingReplacement.originalName,
          originalStorageKey: pendingReplacement.originalStorageKey,
          fileExtension: pendingReplacement.fileExtension,
          fileSize: pendingReplacement.fileSize,
          sha256: pendingReplacement.sha256,
          pendingReplacement: undefined,
        } : {}),
        parserVersion: document.parserVersion, ...(document.pageCount ? { pageCount: document.pageCount } : {}),
        ...(document.sheetCount ? { sheetCount: document.sheetCount } : {}), ...(document.slideCount ? { slideCount: document.slideCount } : {}),
        extractedChars: document.extractedChars, chunkCount, errorSummary: document.warnings.length ? document.warnings.join('；').slice(0, 800) : undefined, updatedAt: finishedAt,
      };
      this.store.publishOperationManualIndex(indexedManual, { ...parseComplete, status: 'completed', stage: 'finalize', progress: 100, finishedAt, updatedAt: finishedAt });
      if (pendingReplacement) await rm(this.resolveStoredFile(oldStorageKey), { force: true }).catch(() => undefined);
    } catch (error) {
      if (this.closed) return;
      const latestJob = this.store.getOperationManualJob(job.id);
      if (!latestJob || latestJob.status !== 'running') return;
      const message = error instanceof Error ? error.message : '手册解析失败。';
      const finishedAt = new Date().toISOString();
      const latestManual = this.store.getOperationManual(manual.id);
      if (latestManual?.pendingReplacement) await rm(this.resolveStoredFile(latestManual.pendingReplacement.originalStorageKey), { force: true }).catch(() => undefined);
      if (latestManual) this.store.saveOperationManual({
        ...latestManual,
        pendingReplacement: undefined,
        status: latestManual.chunkCount
          ? (wasDisabled || latestManual.status === 'disabled' ? 'disabled' : latestManual.status === 'partial' ? 'partial' : 'ready')
          : (wasDisabled || latestManual.status === 'disabled' ? 'disabled' : 'failed'),
        ...(wasDisabled && !latestManual.chunkCount ? { resumeStatus: 'failed' } : {}),
        errorSummary: message.slice(0, 800), updatedAt: finishedAt,
      });
      this.store.saveOperationManualJob({ ...(latestJob ?? current), status: 'failed', stage: 'finalize', errorMessage: message.slice(0, 1000), finishedAt, updatedAt: finishedAt });
    } finally {
      if (stageDirectory) await rm(stageDirectory, { recursive: true, force: true, maxRetries: 4 });
    }
  }

  private parseInWorker(filename: string, jobId: string, manual: OperationManual, stagePath: string): Promise<{ document: ParsedManualDocument; chunkCount: number }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, { workerData: { filename, manual, stagePath } });
      this.activeWorkers.set(jobId, worker);
      worker.once('message', (message: { ok: boolean; document?: ParsedManualDocument; chunkCount?: number; error?: string }) => {
        if (message.ok && message.document) {
          try { resolve({ document: message.document, chunkCount: message.chunkCount ?? stageManualIndex(stagePath, manual, message.document) }); }
          catch (error) { reject(error); }
        }
        else reject(new Error(message.error || '手册解析失败。'));
      });
      worker.once('error', reject);
      worker.once('exit', code => {
        this.activeWorkers.delete(jobId);
        reject(new Error(`手册解析 Worker 已退出（${code}）。`));
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.activeWorkers.values()].map(worker => worker.terminate().catch(() => 0)));
    await this.processing;
    this.activeWorkers.clear();
  }
}
