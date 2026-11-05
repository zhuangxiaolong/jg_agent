import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_FILE_BYTES = 128 * 1024;
const MAX_OUTPUT_CHARS = 48000;
const MAX_SERIALIZED_CHARS = 24000;
const IGNORED_DIRECTORIES = new Set(['.git', '.codex', '.ssh', '.aws', '.azure', '.gnupg', 'node_modules', 'bin', 'obj', 'dist', 'release', 'target', '.vs', '.idea']);
const ALLOWED_EXTENSIONS = new Set(['.cs', '.csproj', '.sln', '.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.xml', '.props', '.targets', '.html', '.css', '.scss', '.sql', '.ps1', '.cmd', '.bat', '.ini', '.toml', '.config', '.csv', '.h', '.cpp', '.c', '.rs', '.vue']);
const SAFE_EXTENSIONLESS = new Set(['dockerfile', 'makefile', 'license', 'notice']);

export const PROJECT_READ_TOOLS = [
  { type: 'function', name: 'list_project_files', description: '只读列出本次项目中的代码文件（相对路径）。不会返回凭据文件、构建产物、Git元数据或链接。', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '项目内相对目录，根目录用 .' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['path'], additionalProperties: false } },
  { type: 'function', name: 'read_project_file', description: '只读读取本次项目的单个 UTF-8 代码文件；禁止越界、链接、凭据文件和二进制。', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '项目内相对文件路径' } }, required: ['path'], additionalProperties: false } },
] as const;
export const PROJECT_WRITE_TOOLS = [
  { type: 'function', name: 'write_project_file', description: '在已授权隔离工作区写入 UTF-8 代码文件。修改已有文件必须传入 read_project_file 返回的 hash；新文件可以省略 expectedHash。写入前执行项目强制规则。', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['path', 'content'], additionalProperties: false } },
  { type: 'function', name: 'delete_project_file', description: '删除已授权隔离工作区中的普通代码文件，必须传入读取到的最新 SHA256 hash；删除前执行项目规则。', inputSchema: { type: 'object', properties: { path: { type: 'string' }, expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['path', 'expectedHash'], additionalProperties: false } },
] as const;
export interface ProjectBrokerOptions { mode?: 'read' | 'develop'; beforeWrite?: (relativePath: string, content: string | null) => Promise<void>; protectedValues?: readonly string[] }

function forbiddenName(name: string): boolean {
  const lower = name.toLowerCase();
  return IGNORED_DIRECTORIES.has(lower)
    || /^\.env(?:\.|$)/i.test(name)
    || /^(?:\.npmrc|\.pypirc|\.netrc|web\.config|appsettings(?:\..*)?\.json)$/i.test(name)
    || /(?:^|[._-])(?:secrets?|credentials?|auth|tokens?|passwords?)(?:[._-]|$)/i.test(name)
    || /\.(?:pem|pfx|p12|p8|key|keystore|jks|kdbx|db|sqlite|sqlite3|cer|crt)$/i.test(name);
}

function readableName(name: string): boolean {
  if (forbiddenName(name)) return false;
  return ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase()) || SAFE_EXTENSIONLESS.has(name.toLowerCase());
}

function relativeInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function verifyRootAncestors(directory: string): Promise<void> {
  let current = directory;
  while (true) {
    const stats = await lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('项目根目录及祖先目录不能是符号链接或目录联接');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function hasCredentialContent(content: string): boolean {
  // 保守阻止常见明文凭据；不声称这能识别所有项目自定义秘密。
  return /\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/.test(content)
    || /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(content)
    || /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i.test(content)
    || /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|connectionstring)["']?\s*[:=]\s*["'][^"'\r\n]{4,}["']/i.test(content);
}

export class ProjectReadBroker {
  private readonly mutations = new Map<string, Promise<unknown>>();
  private constructor(private readonly root: string, private readonly requestedRoot: string, private readonly options: ProjectBrokerOptions, private readonly rootIdentity: { dev: number; ino: number }) {}
  static async create(cwd: string, options: ProjectBrokerOptions = {}): Promise<ProjectReadBroker> {
    const requestedRoot = path.resolve(cwd);
    const stats = await lstat(requestedRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('项目目录无效');
    await verifyRootAncestors(requestedRoot);
    const root = await realpath(requestedRoot);
    if (options.mode === 'develop') {
      const marker = await lstat(path.join(root, '.git')).catch(() => null);
      if (!marker?.isFile() || marker.isSymbolicLink() || marker.nlink > 1) throw new Error('开发模式必须使用隔离 Git Worktree');
    }
    const identity = await lstat(root);
    return new ProjectReadBroker(root, requestedRoot, options, { dev: identity.dev, ino: identity.ino });
  }

  async call(tool: string, input: unknown): Promise<Record<string, unknown>> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('只读工具参数必须为对象');
    const args = input as Record<string, unknown>;
    const allowedKeys = tool === 'list_project_files' ? ['path', 'limit'] : tool === 'write_project_file' ? ['path', 'content', 'expectedHash'] : tool === 'delete_project_file' ? ['path', 'expectedHash'] : ['path'];
    if (Object.keys(args).some((key) => !allowedKeys.includes(key))) throw new Error('只读工具包含未知参数');
    if (typeof args.path !== 'string') throw new Error('只读工具需要相对路径');
    if (tool === 'list_project_files') return this.listFiles(args.path, args.limit);
    if (tool === 'read_project_file') return this.readFile(args.path);
    if (tool === 'write_project_file' || tool === 'delete_project_file') {
      if (this.options.mode !== 'develop') throw new Error('当前会话为只读模式，禁止修改文件');
      if (!this.options.beforeWrite) throw new Error('尚未绑定强制开发规则，禁止修改文件');
      const target = await this.checkedPath(args.path, true);
      const normalized = path.relative(this.root, target).replaceAll('\\', '/');
      const key = normalized.toLowerCase();
      const previous = this.mutations.get(key) ?? Promise.resolve();
      const mutation = previous.catch(() => undefined).then(() => this.mutateFile(tool, { ...args, path: normalized }));
      this.mutations.set(key, mutation);
      try { return await mutation; } finally { if (this.mutations.get(key) === mutation) this.mutations.delete(key); }
    }
    throw new Error('未授权的只读工具');
  }

  private async checkedPath(relative: string, allowMissing = false): Promise<string> {
    if (this.options.protectedValues?.some((value) => value && relative.includes(value))) throw new Error('路径包含已配置凭据，已拒绝');
    if (!relative || relative.length > 500 || path.isAbsolute(relative) || /[:<>|"*?\x00-\x1f]/.test(relative)) throw new Error('只允许项目内相对路径');
    const segments = relative.split(/[\\/]/).filter((segment) => segment !== '.');
    if (segments.some((segment) => !segment || segment === '..' || segment.endsWith('.') || segment.endsWith(' ') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) || forbiddenName(segment))) throw new Error('路径包含被禁止的目录、凭据文件或越界片段');
    let current = this.root;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      current = path.join(current, segment);
      const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (allowMissing && error.code === 'ENOENT') return null; throw error; });
      if (!stats) { current = path.resolve(current, ...segments.slice(index + 1)); break; }
      if (stats.isSymbolicLink()) throw new Error('不允许读取符号链接或目录联接');
      // Windows 的大小写及 8.3 短名必须归一为磁盘实际路径，规则和写入使用同一名称。
      current = await realpath(current);
      if (!relativeInside(this.root, current) || path.relative(this.root, current).split(path.sep).some(forbiddenName)) throw new Error('实际路径包含被禁止的目录、凭据文件或超出授权目录');
    }
    const resolved = allowMissing ? current : await realpath(current);
    const rootStats = await lstat(this.requestedRoot);
    await verifyRootAncestors(this.requestedRoot);
    if (!relativeInside(this.root, resolved) || rootStats.isSymbolicLink() || rootStats.dev !== this.rootIdentity.dev || rootStats.ino !== this.rootIdentity.ino || await realpath(this.requestedRoot) !== this.root || await realpath(this.root) !== this.root) throw new Error('项目路径已变化或超出授权目录');
    return resolved;
  }

  private async listFiles(relative: string, inputLimit: unknown): Promise<Record<string, unknown>> {
    const limit = inputLimit === undefined ? 200 : inputLimit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('文件数量限制必须为 1–500');
    const target = await this.checkedPath(relative);
    if (!(await lstat(target)).isDirectory()) throw new Error('文件列表需要目录路径');
    const files: string[] = [];
    let scanned = 0;
    let truncated = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 12 || scanned >= 5000 || files.length >= limit) { truncated = true; return; }
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        scanned += 1;
        if (scanned > 5000 || files.length >= limit) { truncated = true; return; }
        if (entry.isSymbolicLink() || forbiddenName(entry.name)) continue;
        const full = path.join(directory, entry.name);
        try {
          // 每次递归都复核真实路径，不跟随目录联接或符号链接。
          const safePath = await this.checkedPath(path.relative(this.root, full));
          const stats = await lstat(safePath);
          if (stats.isDirectory()) await walk(safePath, depth + 1);
          else if (stats.isFile() && stats.nlink <= 1 && readableName(entry.name) && stats.size <= MAX_FILE_BYTES) files.push(path.relative(this.root, safePath).replaceAll('\\', '/'));
        } catch { /* 扫描时忽略无权访问、变化中或不安全的条目。 */ }
      }
    };
    await walk(target, 0);
    const result = { files, truncated, scannedEntries: scanned, limits: { maxFiles: limit, maxEntries: 5000, maxDepth: 12, maxFileBytes: MAX_FILE_BYTES, maxSerializedChars: MAX_SERIALIZED_CHARS } };
    while (JSON.stringify(result).length > MAX_SERIALIZED_CHARS && result.files.length > 0) { result.files.pop(); result.truncated = true; }
    return result;
  }

  private async readFile(relative: string): Promise<Record<string, unknown>> {
    if (!readableName(path.basename(relative))) throw new Error('该文件类型或凭据文件不允许读取');
    const target = await this.checkedPath(relative);
    const before = await lstat(target);
    if (!before.isFile() || before.nlink > 1 || before.size > MAX_FILE_BYTES) throw new Error('仅允许读取不超过 128 KiB 的普通单链接文件');
    const handle = await open(target, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_FILE_BYTES) throw new Error('文件在读取前发生变化，已拒绝');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES || buffer.subarray(0, bytesRead).includes(0)) throw new Error('文件过大或不是文本文件');
      await this.checkedPath(relative);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      if (hasCredentialContent(content) || this.options.protectedValues?.some((value) => value && content.includes(value))) throw new Error('文件疑似包含明文凭据，已拒绝传给模型');
      const result = { path: path.relative(this.root, target).replaceAll('\\', '/'), content: content.slice(0, MAX_OUTPUT_CHARS), truncated: content.length > MAX_OUTPUT_CHARS, bytes: bytesRead, hash: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex') };
      if (JSON.stringify(result).length > MAX_SERIALIZED_CHARS) {
        result.truncated = true;
        let low = 0;
        let high = result.content.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (JSON.stringify({ ...result, content: result.content.slice(0, middle) }).length <= MAX_SERIALIZED_CHARS) low = middle;
          else high = middle - 1;
        }
        result.content = result.content.slice(0, low);
      }
      return result;
    } finally { await handle.close(); }
  }

  private async mutateFile(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relative = args.path as string;
    if (!readableName(path.basename(relative))) throw new Error('禁止修改该文件类型或凭据文件');
    const target = await this.checkedPath(relative, true);
    const normalized = path.relative(this.root, target).replaceAll('\\', '/');
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    const deleting = tool === 'delete_project_file';
    let previousHash: string | null = null;
    if (existing) previousHash = (await this.readFile(relative)).hash as string;
    if (deleting && !existing) throw new Error('要删除的文件不存在');
    if (existing && (typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash) || args.expectedHash !== previousHash)) throw new Error('文件 SHA256 已变化或未提供，请重新读取后再修改');
    if (!existing && args.expectedHash !== undefined) throw new Error('文件不存在，不能使用已有文件 hash');
    const content = deleting ? null : args.content;
    if (content !== null && (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES || hasCredentialContent(content) || this.options.protectedValues?.some((value) => value && content.includes(value)))) throw new Error('写入内容不是受支持的 UTF-8 文本、超过 128 KiB 或包含疑似凭据');
    await this.options.beforeWrite!(normalized, content as string | null);
    await this.checkedPath(relative, true);
    if (existing && (await this.readFile(relative)).hash !== previousHash) throw new Error('规则检查期间文件已变化，请重新读取');
    if (deleting) {
      await unlink(await this.checkedPath(relative));
      return { path: normalized, deleted: true, previousHash };
    }
    const parent = path.dirname(target);
    let current = this.root;
    for (const segment of path.relative(this.root, parent).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      await this.checkedPath(path.relative(this.root, current));
    }
    const temporary = path.join(parent, `.jinggong-write-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', existing?.mode ?? 0o600);
    try { await handle.writeFile(content as string, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try {
      await this.checkedPath(relative, true);
      if (existing) {
        if ((await this.readFile(relative)).hash !== previousHash) throw new Error('文件写入前已变化，请重新读取');
        await rename(temporary, target);
      } else { await link(temporary, target); await unlink(temporary); }
    } finally { await unlink(temporary).catch(() => undefined); }
    const hash = createHash('sha256').update(content as string, 'utf8').digest('hex');
    return { path: normalized, written: true, hash, bytes: Buffer.byteLength(content as string, 'utf8'), previousHash };
  }
}
