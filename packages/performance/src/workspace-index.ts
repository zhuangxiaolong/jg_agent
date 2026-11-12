import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContextFragment } from './types';

export interface WorkspaceIndexIdentity { workspaceId: string; repositoryId: string; worktreeId: string; root: string }
export interface WorkspaceIndexStatus {
  state: 'unavailable' | 'indexing' | 'ready' | 'failed'; version: number; fileCount: number; parsedFiles: number; reusedFiles: number;
  deletedFiles: number; skippedFiles: number; failures: number; updatedAt?: string; error?: string; watcher: 'off' | 'active' | 'unavailable';
}
interface IndexedFile { path: string; size: number; mtimeMs: number; ctimeMs: number; hash: string; text: string; symbols: string[]; searchBloom: string }
interface IndexEntry { identity: WorkspaceIndexIdentity; files: Map<string, IndexedFile>; status: WorkspaceIndexStatus; updating?: Promise<WorkspaceIndexStatus>; watcher?: FSWatcher; timer?: ReturnType<typeof setTimeout>; exclude: string[] }
const IGNORED = new Set(['.git', 'node_modules', 'vendor', 'bin', 'obj', 'dist', 'build', 'release', '.next', '.nuxt', '.cache', 'coverage', 'target', '.vs', '.idea', '.codex', '.ssh', '.aws', '.azure', '.gnupg']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.cs', '.csproj', '.sln', '.sql', '.vue', '.html', '.css', '.scss', '.md', '.txt', '.xml', '.yaml', '.yml', '.toml', '.props', '.targets', '.rs', '.go', '.py', '.java', '.h', '.c', '.cpp']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 20000;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const BLOOM_BYTES = 512;
function bloomPositions(text: string): [number, number] {
  let value = 2166136261; for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return [value >>> 0 & (BLOOM_BYTES * 8 - 1), (Math.imul(value ^ value >>> 16, 2246822519) >>> 0) & (BLOOM_BYTES * 8 - 1)];
}
function searchBloom(text: string): string {
  const bits = Buffer.alloc(BLOOM_BYTES); const lower = text.toLowerCase();
  const add = (gram: string) => { for (const position of bloomPositions(gram)) bits[position >>> 3] |= 1 << (position & 7); };
  for (let index = 0; index < lower.length; index++) {
    if (index + 2 < lower.length) add(lower.slice(index, index + 3));
    // 中文检索词允许两个字符，同时保留其二元候选位。
    if (index + 1 < lower.length && /[\u4e00-\u9fff]/.test(lower[index]) && /[\u4e00-\u9fff]/.test(lower[index + 1])) add(lower.slice(index, index + 2));
  }
  return bits.toString('base64');
}
function bloomMayMatch(encoded: string, term: string): boolean {
  const bits = Buffer.from(encoded, 'base64'); if (bits.length !== BLOOM_BYTES) return true;
  const width = term.length === 2 ? 2 : 3;
  for (let index = 0; index + width <= term.length; index++) {
    for (const position of bloomPositions(term.slice(index, index + width))) if (!(bits[position >>> 3] & 1 << (position & 7))) return false;
  }
  return true;
}
function inside(root: string, filename: string): boolean { const relative = path.relative(root, filename); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
export function indexablePath(filename: string, exclude: string[] = []): boolean {
  const normalized = filename.replaceAll('\\', '/'); const segments = normalized.split('/');
  if (!normalized || path.isAbsolute(filename) || /[:\x00-\x1f]/.test(filename) || segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
  if (segments.some(segment => IGNORED.has(segment.toLowerCase()) || /^\.env(?:\.|$)/i.test(segment) || /^(?:\.npmrc|\.pypirc|\.netrc|web\.config|appsettings(?:\..*)?\.json)$/i.test(segment) || /(?:^|[._-])(?:secrets?|credentials?|auth|tokens?|passwords?)(?:[._-]|$)/i.test(segment))) return false;
  if (exclude.some(rule => { const prefix = rule.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/\*\*$/, '').replace(/\/$/, ''); return prefix && (normalized === prefix || normalized.startsWith(prefix + '/')); })) return false;
  return EXTENSIONS.has(path.extname(normalized).toLowerCase()) || /(?:^|\/)(?:Dockerfile|Makefile|LICENSE|NOTICE)$/i.test(normalized);
}
async function checkedRoot(requested: string): Promise<string> {
  if (!path.isAbsolute(requested) || path.parse(requested).root === path.resolve(requested)) throw new Error('索引必须限定在已授权项目根目录');
  let cursor = path.resolve(requested);
  while (true) {
    const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('索引根目录及祖先不能是符号链接或目录联接');
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return realpath(requested);
}
async function checkedFile(root: string, relative: string): Promise<IndexedFile | undefined> {
  const absolute = path.join(root, relative); if (!inside(root, absolute)) return;
  let cursor = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]); const info = await lstat(cursor);
    if (info.isSymbolicLink() || i < parts.length - 1 && !info.isDirectory()) return;
  }
  if (!inside(root, await realpath(absolute))) return;
  const before = await lstat(absolute); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) return;
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat(); if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || !info.isFile() || info.nlink !== 1) return;
    const bytes = Buffer.alloc(info.size + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); const after = await handle.stat();
    if (bytesRead > MAX_FILE_BYTES || bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return;
    const buffer = bytes.subarray(0, bytesRead); if (buffer.includes(0)) return;
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return; }
    // 与凭据文件名过滤一起防止普通源码误提交的密钥进入检索缓存。
    if (/\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|access[_-]?token)\s*[:=]\s*["'][^"']{8,}["']/i.test(text)) return;
    const symbols = [...text.matchAll(/\b(?:class|interface|function|enum|type|def|struct|namespace|const|let|var|public|private|protected)\s+([A-Za-z_$][\w$]{1,100})/g)].slice(0, 200).map(match => match[1]);
    return { path: relative, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, hash: createHash('sha256').update(buffer).digest('hex'), text, symbols, searchBloom: searchBloom(text) };
  } finally { await handle.close(); }
}
async function gitFiles(root: string): Promise<string[]> {
  // Git 原生实现处理嵌套 .gitignore、否定规则和仓库 exclude；不自行猜测忽略语义。
  return new Promise((resolve, reject) => execFile('git', ['-c', 'core.fsmonitor=false', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => {
    if (error) reject(new Error('Git 文件清单不可用，保持原有文件工具搜索')); else resolve([...new Set(stdout.split('\0').filter(Boolean))]);
  }));
}
function blank(): WorkspaceIndexStatus { return { state: 'unavailable', version: 0, fileCount: 0, parsedFiles: 0, reusedFiles: 0, deletedFiles: 0, skippedFiles: 0, failures: 0, watcher: 'off' }; }

/** 按 workspace/repository/worktree/root 隔离；索引仅保存在本地进程内，移除工作区即可清理。 */
export class WorkspaceIndexService {
  private readonly indexes = new Map<string, IndexEntry>();
  constructor(private readonly options: { cacheRoot?: string } = {}) {}
  private key(input: WorkspaceIndexIdentity): string { return JSON.stringify([input.workspaceId, input.repositoryId, input.worktreeId, path.resolve(input.root)]); }
  status(input: WorkspaceIndexIdentity): WorkspaceIndexStatus { return { ...(this.indexes.get(this.key(input))?.status ?? blank()) }; }
  ensureFresh(input: WorkspaceIndexIdentity, options: { force?: boolean; exclude?: string[] } = {}): Promise<WorkspaceIndexStatus> {
    const key = this.key(input); let entry = this.indexes.get(key);
    if (!entry) { entry = { identity: { ...input }, files: new Map(), status: blank(), exclude: options.exclude ?? [] }; this.indexes.set(key, entry); }
    if (entry.updating) return entry.updating;
    entry.exclude = options.exclude ?? entry.exclude;
    const current = entry;
    current.updating = this.update(current, options.force === true).finally(() => { current.updating = undefined; }); return current.updating;
  }
  private async update(entry: IndexEntry, force: boolean): Promise<WorkspaceIndexStatus> {
    entry.status.state = 'indexing';
    try {
      const root = await checkedRoot(entry.identity.root);
      if (!entry.files.size && !force) await this.loadMetadata(entry);
      const filenames = await gitFiles(root); const next = new Map<string, IndexedFile>();
      let parsedFiles = 0, reusedFiles = 0, skippedFiles = 0, failures = 0, totalBytes = 0;
      for (const filename of filenames) {
        const relative = filename.replaceAll('\\', '/');
        if (next.size >= MAX_FILES || !indexablePath(relative, entry.exclude)) { skippedFiles++; continue; }
        try {
          const absolute = path.join(root, relative); if (!inside(root, absolute)) { skippedFiles++; continue; }
          const info = await lstat(absolute); const previous = entry.files.get(relative);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_FILE_BYTES || totalBytes + info.size > MAX_TOTAL_BYTES) { skippedFiles++; continue; }
          // 重用之前仍检查每一层祖先，避免目录被替换成链接后读到旧缓存。
          let cursor = root, safe = true;
          for (const part of relative.split('/')) { cursor = path.join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) { safe = false; break; } }
          if (!safe || !inside(root, await realpath(absolute))) { skippedFiles++; continue; }
          if (!force && previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs && previous.ctimeMs === info.ctimeMs) { next.set(relative, previous); reusedFiles++; totalBytes += previous.size; continue; }
          const file = await checkedFile(root, relative); if (!file) { skippedFiles++; continue; }
          next.set(relative, file); parsedFiles++; totalBytes += file.size;
        } catch { failures++; }
      }
      const deletedFiles = [...entry.files.keys()].filter(filename => !next.has(filename)).length;
      const changed = force || parsedFiles > 0 || deletedFiles > 0 || entry.status.version === 0;
      entry.files = next; entry.status = { state: 'ready', version: entry.status.version + (changed ? 1 : 0), fileCount: next.size, parsedFiles, reusedFiles, deletedFiles, skippedFiles, failures,
        updatedAt: new Date().toISOString(), watcher: entry.status.watcher };
      await this.saveMetadata(entry);
    } catch (error) { entry.files.clear(); entry.status = { ...entry.status, state: 'failed', fileCount: 0, error: error instanceof Error ? error.message : '索引不可用' }; }
    return { ...entry.status };
  }
  async search(input: WorkspaceIndexIdentity, query: string, options: { limit?: number; contextLines?: number } = {}): Promise<ContextFragment[]> {
    const entry = this.indexes.get(this.key(input)); if (!entry || entry.status.state !== 'ready') return [];
    const root = await checkedRoot(input.root); const terms = [...new Set((query.match(/[A-Za-z_$][\w.$-]{2,}|[\u4e00-\u9fff]{2,8}/g) ?? []).map(term => term.toLowerCase()))].slice(0, 24);
    if (!terms.length) return [];
    const limit = Math.max(1, Math.min(20, options.limit ?? 8)), radius = Math.max(1, Math.min(8, options.contextLines ?? 3));
    // 非明文全文候选位让重启后的注释/正文检索仍可用，只读取可能命中的文件。
    // 每次检索先作轻量 stat 校验，发生变化的文件即使旧候选位不命中也会重读。
    const scored: Array<{ file: IndexedFile; score: number }> = [];
    for (const file of entry.files.values()) {
      try {
        const info = await lstat(path.join(root, file.path));
        const changed = info.size !== file.size || info.mtimeMs !== file.mtimeMs || info.ctimeMs !== file.ctimeMs;
        const score = terms.reduce((sum, term) => sum + (file.path.toLowerCase().includes(term) ? 4 : 0) + (file.text.toLowerCase().includes(term) || file.symbols.some(symbol => symbol.toLowerCase().includes(term)) ? 1 : 0), 0);
        if (changed || score > 0 || !file.text && terms.some(term => bloomMayMatch(file.searchBloom, term))) scored.push({ file, score });
      } catch { entry.files.delete(file.path); }
    }
    scored.sort((a, b) => b.score - a.score);
    const fragments: ContextFragment[] = [];
    const allowedFiles = new Set((await gitFiles(root)).map(filename => filename.replaceAll('\\', '/')));
    for (const { file: cached } of scored) {
      try {
        if (!indexablePath(cached.path, entry.exclude) || !allowedFiles.has(cached.path)) { entry.files.delete(cached.path); continue; }
        const file = await checkedFile(root, cached.path); if (!file) { entry.files.delete(cached.path); continue; }
        entry.files.set(file.path, file); if (file.hash !== cached.hash) entry.status.version++;
        const score = terms.reduce((sum, term) => sum + (file.path.toLowerCase().includes(term) ? 4 : 0) + (file.text.toLowerCase().includes(term) ? 1 : 0), 0);
        if (!score) continue;
        const lines = file.text.split(/\r?\n/); const matched = lines.findIndex(line => terms.some(term => line.toLowerCase().includes(term)));
        const start = Math.max(0, matched < 0 ? 0 : matched - radius), end = Math.min(lines.length, (matched < 0 ? 0 : matched) + radius + 1);
        fragments.push({ workspaceId: input.workspaceId, repositoryId: input.repositoryId, worktreeId: input.worktreeId, path: file.path, hash: file.hash, indexVersion: entry.status.version, startLine: start + 1, endLine: end, text: lines.slice(start, end).join('\n'), score });
        if (fragments.length >= limit) break;
      } catch { entry.files.delete(cached.path); }
    }
    return fragments;
  }
  rebuild(input: WorkspaceIndexIdentity): Promise<WorkspaceIndexStatus> { return this.ensureFresh(input, { force: true }); }
  async watch(input: WorkspaceIndexIdentity, onChange?: (status: WorkspaceIndexStatus) => void): Promise<() => void> {
    const root = await checkedRoot(input.root); await this.ensureFresh(input); const entry = this.indexes.get(this.key(input))!;
    if (!entry.watcher) {
      try {
        entry.watcher = watch(root, { recursive: true }, (_event, filename) => {
          if (filename && !indexablePath(filename) && !/(?:^|[\\/])\.gitignore$/.test(filename)) return;
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = setTimeout(() => { entry.timer = undefined; void this.ensureFresh(input).then(status => onChange?.(status)); }, 700); entry.timer.unref();
        }); entry.watcher.on('error', () => { entry.status.watcher = 'unavailable'; entry.watcher?.close(); entry.watcher = undefined; }); entry.status.watcher = 'active';
      } catch { entry.status.watcher = 'unavailable'; }
    }
    return () => { entry.watcher?.close(); entry.watcher = undefined; if (entry.timer) clearTimeout(entry.timer); entry.status.watcher = 'off'; };
  }
  async clear(input: WorkspaceIndexIdentity): Promise<void> {
    const key = this.key(input); const entry = this.indexes.get(key); entry?.watcher?.close(); if (entry?.timer) clearTimeout(entry.timer); this.indexes.delete(key);
    // 等待本轮索引收尾后再删除，避免清理操作被尚在执行的写缓存覆盖。
    await entry?.updating;
    const filename = await this.cacheFile(input); if (!filename) return;
    const info = await lstat(filename).catch(() => undefined); if (info?.isFile() && !info.isSymbolicLink() && info.nlink === 1) await unlink(filename).catch(() => undefined);
  }
  close(): void {
    for (const entry of this.indexes.values()) { entry.watcher?.close(); if (entry.timer) clearTimeout(entry.timer); }
    this.indexes.clear();
  }
  private async cacheFile(identity: WorkspaceIndexIdentity): Promise<string | undefined> {
    if (!this.options.cacheRoot) return;
    const missing: string[] = []; let cursor = path.resolve(this.options.cacheRoot);
    while (true) {
      const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info) { if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('索引缓存目录不能是链接'); }
      else missing.push(cursor);
      const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    for (const directory of missing.reverse()) { await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; }); const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('索引缓存目录状态已变化'); }
    const root = await checkedRoot(this.options.cacheRoot);
    return path.join(root, createHash('sha256').update(this.key(identity)).digest('hex') + '.json');
  }
  private async loadMetadata(entry: IndexEntry): Promise<void> {
    try {
      const filename = await this.cacheFile(entry.identity); if (!filename) return;
      const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_CACHE_BYTES) return;
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let contents: string;
      try {
        const opened = await handle.stat(); if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) return;
        const buffer = Buffer.alloc(info.size + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead !== info.size) return; contents = buffer.subarray(0, bytesRead).toString('utf8');
      }
      finally { await handle.close(); }
      const parsed = JSON.parse(contents) as { format?: number; key?: string; version?: number; files?: Array<Omit<IndexedFile, 'text'>> };
      if (parsed.format !== 2 || parsed.key !== this.key(entry.identity) || !Array.isArray(parsed.files) || parsed.files.length > MAX_FILES) return;
      const valid = parsed.files.filter(file => indexablePath(file.path, entry.exclude) && /^[a-f0-9]{64}$/.test(file.hash) && Number.isFinite(file.size) && file.size >= 0 && file.size <= MAX_FILE_BYTES && Number.isFinite(file.mtimeMs) && Number.isFinite(file.ctimeMs) && Array.isArray(file.symbols) && file.symbols.length <= 200 && file.symbols.every(symbol => /^[A-Za-z_$][\w$]{1,100}$/.test(symbol)) && typeof file.searchBloom === 'string' && /^[A-Za-z0-9+/=]+$/.test(file.searchBloom) && Buffer.from(file.searchBloom, 'base64').length === BLOOM_BYTES);
      entry.files = new Map(valid.map(file => [file.path, { ...file, text: '' }]));
      entry.status.version = Number.isInteger(parsed.version) && parsed.version! > 0 ? parsed.version! : 0;
    } catch { /* 索引缓存损坏或不可读时重新扫描，不阻断任务。 */ }
  }
  private async saveMetadata(entry: IndexEntry): Promise<void> {
    let temporary: string | undefined;
    try {
      const filename = await this.cacheFile(entry.identity); if (!filename) return;
      const previous = await lstat(filename).catch(() => undefined); if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) return;
      temporary = `${filename}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      // 磁盘缓存只保留路径、stat/hash、基础符号与非明文全文候选位；不保存源码正文或片段。
      const files = [...entry.files.values()].map(({ text: _text, ...file }) => file);
      const serialized = JSON.stringify({ format: 2, key: this.key(entry.identity), version: entry.status.version, files }); if (Buffer.byteLength(serialized, 'utf8') > MAX_CACHE_BYTES) return;
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } catch { /* 缓存写入失败仍可使用进程内索引和原工具。 */ }
    finally { if (temporary) await unlink(temporary).catch(() => undefined); }
  }
}
