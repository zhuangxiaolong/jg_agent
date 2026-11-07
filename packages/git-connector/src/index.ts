import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat, open, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileDiff, GitState, Project } from '../../domain/src/index';

const MAX_FILES = 500;
const MAX_DIFF_BYTES = 512 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part.length > 0 && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** 仅对应用管理的 agent 分支开放变更；提交、拉取与推送由主进程人工确认后调用。 */
export class GitConnector {
  constructor(private readonly rootWorkspaces: string, private readonly gitExecutable = 'git') {}

  private run(cwd: string | undefined, args: string[], options: { maxBytes?: number; allowTruncate?: boolean; allowMissing?: boolean; strictText?: boolean } = {}): Promise<{ text: string; truncated: boolean; code: number }> {
    const fixedArgs = ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'diff.external=', '-c', `core.hooksPath=${resolve(this.rootWorkspaces, '.disabled-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'status.renames=false', '-c', 'protocol.ext.allow=never', ...args];
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^GIT_/i.test(key)) delete environment[key];
    environment.GIT_TERMINAL_PROMPT = '0';
    environment.GIT_PAGER = 'cat';
    return new Promise((resolveResult, reject) => {
      execFile(this.gitExecutable, fixedArgs, { cwd, encoding: 'buffer', windowsHide: true, timeout: 30000, maxBuffer: options.maxBytes ?? 8 * 1024 * 1024, env: environment }, (error, stdout) => {
        if (error) {
          if (options.allowTruncate && (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            resolveResult({ text: stdout.toString('utf8'), truncated: true, code: 0 });
          } else if (options.allowMissing && (error as { code?: unknown }).code === 1) {
            resolveResult({ text: '', truncated: false, code: 1 });
          } else {
            // 不转发包含远程地址、认证信息或仓库配置内容的 stderr。
            reject(new Error(`Git 操作失败（${args.find(value => !value.startsWith('-')) ?? '命令'}）；请检查 Git 安装、仓库状态、目录权限和可用空间。`));
          }
        } else {
          try {
            if (options.strictText && stdout.includes(0)) throw new Error('binary');
            const text = options.strictText ? new TextDecoder('utf-8', { fatal: true }).decode(stdout) : stdout.toString('utf8');
            resolveResult({ text, truncated: false, code: 0 });
          } catch { reject(new Error('当前提交规则仅支持 UTF-8 文本文件；二进制或编码不受支持的文件请人工审核后提交')); }
        }
      });
    });
  }

  async version(): Promise<string> { return (await this.run(undefined, ['--version'])).text.trim(); }

  private async filterOverrides(cwd: string): Promise<string[]> {
    const configured = (await this.run(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\.'], { allowMissing: true })).text;
    const names = new Set<string>();
    for (const key of configured.split('\0').filter(Boolean)) {
      const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
      if (!match) continue;
      if (!/^[a-zA-Z0-9_.-]+$/.test(match[1])) throw new Error('仓库 Git filter 名称含不支持的字符，请先由管理员审核配置。');
      names.add(match[1]);
    }
    return [...names].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
  }

  async register(path: string): Promise<Project> {
    const canonical = await realpath(path);
    if (!(await lstat(canonical)).isDirectory()) throw new Error('请选择 Git 仓库根目录。');
    const top = (await this.run(canonical, ['rev-parse', '--show-toplevel'])).text.trim();
    if (!samePath(canonical, await realpath(top))) throw new Error('请选择 Git 仓库根目录，不能选择仓库内的子目录。');
    await this.run(canonical, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const branch = (await this.run(canonical, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowMissing: true })).text.trim() || '(detached)';
    const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    return { id: createHash('sha256').update(identity).digest('hex').slice(0, 24), name: basename(canonical), path: canonical, branch };
  }

  async listBranches(projectPath: string): Promise<string[]> {
    const current = await this.register(projectPath);
    const raw = (await this.run(current.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).text;
    return raw.split(/\r?\n/).map(value => value.trim()).filter(value => value && value !== 'HEAD');
  }

  async createWorkspace(project: Project, sessionId: string, baseBranch?: string): Promise<{ path: string; branch: string; baseBranch?: string }> {
    if (!SAFE_ID.test(sessionId)) throw new Error('无效的工作区标识。');
    const current = await this.register(project.path);
    if (current.id !== project.id) throw new Error('仓库位置已变化，请重新选择。');
    await mkdir(this.rootWorkspaces, { recursive: true });
    const root = await realpath(this.rootWorkspaces);
    const path = resolve(root, sessionId);
    if (!inside(root, path)) throw new Error('工作区路径超出应用目录。');
    const branch = `agent/${sessionId}`;
    const selectedBase = baseBranch?.trim() || current.branch;
    let base: string;
    if (!selectedBase || selectedBase === '(detached)') {
      base = (await this.run(current.path, ['rev-parse', '--verify', 'HEAD^{commit}'])).text.trim();
    } else {
      // 先由 Git 校验分支名，再只解析本地 refs/heads，避免把远程或任意修订表达式当成基准。
      await this.run(current.path, ['check-ref-format', '--branch', selectedBase]);
      base = (await this.run(current.path, ['rev-parse', '--verify', `refs/heads/${selectedBase}^{commit}`])).text.trim();
    }
    const hookDirectory = resolve(root, '.disabled-hooks');
    await mkdir(hookDirectory, { recursive: true });
    const overrides = ['-c', `core.hooksPath=${hookDirectory}`, ...await this.filterOverrides(current.path)];
    await this.run(current.path, [...overrides, 'worktree', 'add', '--no-track', '-b', branch, path, base]);
    return { path: await realpath(path), branch, ...(selectedBase && selectedBase !== '(detached)' ? { baseBranch: selectedBase } : {}) };
  }

  async switchWorkspaceBaseBranch(workspacePath: string, baseBranch: string): Promise<{ branch: string; baseBranch: string }> {
    const workspace = await this.workspace(workspacePath);
    const selectedBase = baseBranch.trim();
    if (!selectedBase || selectedBase === '(detached)') throw new Error('请选择有效的本地基准分支。');
    await this.run(workspace, ['check-ref-format', '--branch', selectedBase]);
    const base = (await this.run(workspace, ['rev-parse', '--verify', `refs/heads/${selectedBase}^{commit}`])).text.trim();
    const state = await this.state(workspace);
    if (state.dirty) throw new Error('当前工作区有未提交变更，请先在 Git 面板处理后再切换分支。');
    await this.run(workspace, ['reset', '--hard', base]);
    return { branch: state.branch, baseBranch: selectedBase };
  }

  private async workspace(path: string): Promise<string> {
    for (const candidate of [resolve(this.rootWorkspaces), resolve(path)]) {
      let ancestor = candidate;
      while (true) {
        if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('工作区及祖先目录不允许目录联接或符号链接');
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    const root = await realpath(this.rootWorkspaces);
    // 受管目录中可能存在旧版本创建的 NTFS 工作目录链接；祖先链接已在上方
    // 拒绝，这里保留用户传入的受管目录路径，避免 realpath 把它还原到旧缓存根。
    const canonical = resolve(path);
    if (!inside(root, canonical) || !samePath(dirname(canonical), root) || !SAFE_ID.test(basename(canonical))) throw new Error('仅允许读取应用管理的隔离工作区。');
    const branch = (await this.run(canonical, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).text.trim();
    // 历史版本可能把同一份受管 Worktree 复制到新的应用目录，Git 的
    // worktree 元数据仍记录旧路径；只要目录本身在受管根目录、分支身份
    // 与会话 ID 一致，Git 的 diff/status 仍然针对当前工作目录读取。
    if (branch !== `agent/${basename(canonical)}`) throw new Error('工作区身份已变化，请检查后重新创建会话。');
    return canonical;
  }

  private async safeFile(workspace: string, file: string): Promise<string> {
    const path = resolve(workspace, file);
    if (!inside(workspace, path) || file.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error('文件路径超出工作区。');
    // 删除文件检查最近仍存在的父目录；不跟随指向工作区以外的目录链接。
    let ancestor = dirname(path);
    while (true) {
      try {
        const stat = await lstat(ancestor);
        if (stat.isSymbolicLink()) throw new Error('文件目录链接超出工作区。');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        ancestor = dirname(ancestor);
      }
    }
    return path;
  }

  async diff(workspacePath: string): Promise<FileDiff[]> {
    const workspace = await this.workspace(workspacePath);
    const overrides = await this.filterOverrides(workspace);
    const tracked = (await this.run(workspace, [...overrides, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', 'HEAD', '--'])).text.split('\0');
    const staged = new Set((await this.run(workspace, [...overrides, 'diff', '--cached', '--name-only', '-z', '--'])).text.split('\0').filter(Boolean));
    const files: { path: string; status: string; untracked: boolean; staged?: boolean }[] = [];
    for (let index = 0; index + 1 < tracked.length; index += 2) {
      if (tracked[index] && tracked[index + 1]) files.push({ path: tracked[index + 1], status: tracked[index][0], untracked: false, staged: staged.has(tracked[index + 1]) });
    }
    const untracked = (await this.run(workspace, ['ls-files', '--others', '--exclude-standard', '-z', '--'])).text.split('\0').filter(Boolean);
    files.push(...untracked.map(path => ({ path, status: 'A', untracked: true })));
    files.sort((a, b) => a.path.localeCompare(b.path));
    const result: FileDiff[] = [];
    for (const file of files.slice(0, MAX_FILES)) {
      const absolute = await this.safeFile(workspace, file.path);
      if (file.untracked) {
        const info = await lstat(absolute);
        if (info.isSymbolicLink() || !info.isFile()) {
          result.push({ path: file.path, status: file.status, diff: '符号链接或特殊文件，不读取链接目标。', binary: true });
          continue;
        }
        const handle = await open(absolute, 'r');
        let bytes: Buffer;
        try {
          bytes = Buffer.alloc(Math.min(info.size, MAX_DIFF_BYTES));
          const read = await handle.read(bytes, 0, bytes.length, 0);
          bytes = bytes.subarray(0, read.bytesRead);
        } finally { await handle.close(); }
        let text: string;
        try {
          if (bytes.includes(0)) throw new Error('binary');
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          result.push({ path: file.path, status: file.status, diff: '新增二进制文件，内容不以内联文本展示。', binary: true, truncated: info.size > MAX_DIFF_BYTES });
          continue;
        }
        const lines = text.split('\n');
        if (lines.at(-1) === '') lines.pop();
        const header = `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n`;
        const body = lines.length ? `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n${text.endsWith('\n') ? '' : '\\ No newline at end of file\n'}` : '';
        result.push({ path: file.path, status: file.status, diff: header + body, truncated: info.size > MAX_DIFF_BYTES, staged: false });
      } else {
        const patch = await this.run(workspace, [...overrides, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', file.path], { maxBytes: MAX_DIFF_BYTES, allowTruncate: true });
        result.push({ path: file.path, status: file.status, diff: patch.text, binary: /(?:^|\n)Binary files .+ differ(?:\n|$)/.test(patch.text), truncated: patch.truncated, staged: file.staged });
      }
    }
    if (files.length > MAX_FILES) result.push({ path: '（其余变更未展开）', status: '!', diff: `共有 ${files.length} 个变更文件，当前展示前 ${MAX_FILES} 个。`, truncated: true });
    return result;
  }

  private async changedFile(workspacePath: string, file: string): Promise<{ workspace: string; path: string; tracked: boolean; inHead: boolean }> {
    const workspace = await this.workspace(workspacePath);
    if (!file || /[\x00-\x1f\x7f]/.test(file) || isAbsolute(file) || file.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('文件路径无效');
    const actual = (await this.diff(workspace)).find(item => item.path === file);
    if (!actual) throw new Error('所选文件已不在当前变更中，请刷新 Git 状态');
    const target = await this.safeFile(workspace, file);
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (info.isSymbolicLink() || (info.isFile() && info.nlink > 1) || !info.isFile())) throw new Error('不能操作符号链接、目录联接、硬链接或特殊文件');
    const tracked = (await this.run(workspace, ['ls-files', '--error-unmatch', '--', file], { allowMissing: true })).code === 0;
    const inHead = (await this.run(workspace, ['ls-tree', '-r', '--name-only', 'HEAD', '--', file], { allowMissing: true })).text.trim() === file;
    return { workspace, path: file, tracked, inHead };
  }

  /** 返回指定文件当前相对 HEAD 的完整 Diff，供右键“对比”使用。 */
  async fileDiff(workspacePath: string, file: string): Promise<FileDiff> {
    const target = await this.changedFile(workspacePath, file);
    const result = (await this.diff(target.workspace)).find(item => item.path === target.path);
    if (!result) throw new Error('所选文件已不在当前变更中，请刷新 Git 状态');
    return result;
  }

  /** 返回当前变更文件的受控绝对路径，供主进程交给系统编辑器打开。 */
  async filePath(workspacePath: string, file: string): Promise<string> {
    const target = await this.changedFile(workspacePath, file);
    return this.safeFile(target.workspace, target.path);
  }

  /** 将单个变更文件加入 Git 暂存区。 */
  async stage(workspacePath: string, file: string): Promise<void> {
    const target = await this.changedFile(workspacePath, file);
    await this.validateCommitPath(target.workspace, target.path);
    await this.run(target.workspace, [...await this.mutationOverrides(target.workspace), 'add', '--', target.path]);
  }

  /** 从 Git 暂存区移除单个文件，但保留工作区内容。 */
  async unstage(workspacePath: string, file: string): Promise<void> {
    const target = await this.changedFile(workspacePath, file);
    await this.validateCommitPath(target.workspace, target.path);
    const staged = (await this.run(target.workspace, ['diff', '--cached', '--name-only', '-z', '--', target.path])).text.split('\0').filter(Boolean);
    if (!staged.includes(target.path)) throw new Error('所选文件当前未暂存');
    await this.run(target.workspace, [...await this.mutationOverrides(target.workspace), 'restore', '--staged', '--', target.path]);
  }

  /** 丢弃单个文件相对 HEAD 的全部修改；未跟踪文件会被删除。 */
  async discard(workspacePath: string, file: string): Promise<void> {
    const target = await this.changedFile(workspacePath, file);
    if (target.inHead) {
      await this.validateCommitPath(target.workspace, target.path);
      await this.run(target.workspace, [...await this.mutationOverrides(target.workspace), 'restore', '--source=HEAD', '--staged', '--worktree', '--', target.path]);
      return;
    }
    if (target.tracked) await this.run(target.workspace, [...await this.mutationOverrides(target.workspace), 'reset', 'HEAD', '--', target.path]);
    const info = await lstat(resolve(target.workspace, target.path));
    if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1) || !info.isFile()) throw new Error('不能删除符号链接、目录联接、硬链接或特殊文件');
    await unlink(resolve(target.workspace, target.path));
  }

  async state(workspacePath: string): Promise<GitState> {
    const workspace = await this.workspace(workspacePath);
    const branch = (await this.run(workspace, ['branch', '--show-current'])).text.trim();
    const raw = (await this.run(workspace, ['log', '-50', '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00'])).text;
    const fields = raw.split('\0');
    const commits: GitState['commits'] = [];
    for (let index = 0; index + 4 < fields.length; index += 5) {
      const hash = fields[index].trim();
      if (/^[a-f0-9]{40,64}$/.test(hash)) commits.push({ hash, shortHash: fields[index + 1], author: fields[index + 2], date: fields[index + 3], message: fields[index + 4] });
    }
    const remotes = (await this.run(workspace, ['remote'])).text.split(/\r?\n/).filter(Boolean);
    const dirty = Boolean((await this.run(workspace, [...await this.filterOverrides(workspace), 'status', '--porcelain=v1', '-z', '--untracked-files=all'])).text);
    return { branch, commits, remotes, dirty };
  }

  async removeWorkspace(workspacePath: string): Promise<void> {
    const workspace = await this.workspace(workspacePath);
    const current = await this.state(workspace);
    if (current.dirty) throw new Error('会话工作区有未提交改动，请先提交或导出后再删除会话');
    const commonDirValue = (await this.run(workspace, ['rev-parse', '--git-common-dir'])).text.trim();
    const commonDir = resolve(workspace, commonDirValue);
    await this.run(dirname(commonDir), ['worktree', 'remove', workspace]);
  }

  async generateCommitMessage(workspacePath: string): Promise<string> {
    const diffs = await this.diff(workspacePath);
    const actual = diffs.filter((item) => item.status !== '!');
    if (!actual.length) throw new Error('当前隔离工作区没有可提交变更');
    const counts = { A: 0, D: 0, M: 0 };
    for (const item of actual) counts[item.status === 'A' ? 'A' : item.status === 'D' ? 'D' : 'M']++;
    const names = actual.slice(0, 3).map((item) => basename(item.path)).join('、');
    return `更新${names}${actual.length > 3 ? '等文件' : ''}（新增${counts.A}、修改${counts.M}、删除${counts.D}）`;
  }

  private async mutationOverrides(workspace: string): Promise<string[]> {
    const hookDirectory = resolve(this.rootWorkspaces, '.disabled-hooks');
    await mkdir(hookDirectory, { recursive: true });
    if ((await lstat(hookDirectory)).isSymbolicLink() || (await readdir(hookDirectory)).length) throw new Error('安全 Hook 目录状态异常，操作已拒绝');
    return ['-c', `core.hooksPath=${hookDirectory}`, '-c', 'commit.gpgsign=false', ...await this.filterOverrides(workspace)];
  }

  private async validateCommitPath(workspace: string, file: string): Promise<void> {
    if (!file || isAbsolute(file) || /[:\x00-\x1f]/.test(file)) throw new Error('提交文件路径无效');
    const segments = file.split(/[\\/]/);
    if (segments.some((part) => !part || part === '.' || part === '..' || /^\.(?:git|codex|ssh|aws|azure)(?:$|[.])|^\.env(?:\.|$)|^(?:\.npmrc|\.pypirc|web\.config|appsettings(?:\..*)?\.json)$|(?:^|[._-])(?:secrets?|credentials?|passwords?|tokens?)(?:[._-]|$)|\.(?:pem|pfx|p12|key|keystore|jks|kdbx)$/i.test(part))) throw new Error('提交包含敏感文件或元数据路径，已拒绝');
    let current = workspace;
    for (const part of segments) {
      current = resolve(current, part);
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) break;
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error('提交包含符号链接、目录联接或硬链接，已拒绝');
      if (current === resolve(workspace, file) && !info.isFile()) throw new Error('提交目标必须为普通文件，禁止子模块或特殊文件');
    }
    await this.safeFile(workspace, file);
  }

  async commit(workspacePath: string, input: { message: string; authorName?: string; authorEmail?: string; files?: string[]; beforeCommit?: (files: Map<string, string | null>) => Promise<void> }): Promise<string> {
    const workspace = await this.workspace(workspacePath);
    if (!input.message?.trim() || input.message.length > 4000 || /\x00/.test(input.message)) throw new Error('提交说明为空或超过长度限制');
    const overrides = await this.mutationOverrides(workspace);
    const raw = (await this.run(workspace, [...overrides, 'status', '--porcelain=v1', '-z', '--untracked-files=all'])).text;
    const entries = raw.split('\0').filter(Boolean);
    if (entries.some((item) => /[U]/.test(item.slice(0, 2)))) throw new Error('请先处理工作区合并冲突');
    const changed = entries.map((item) => item.slice(3));
    const files = input.files ?? changed;
    if (!files.length || files.length > MAX_FILES || new Set(files).size !== files.length || files.some((file) => !changed.includes(file))) throw new Error('提交文件清单为空、超限或与实际变更不一致');
    for (const file of files) await this.validateCommitPath(workspace, file);
    const stagedBefore = (await this.run(workspace, ['diff', '--cached', '--name-only', '-z', '--'])).text.split('\0').filter(Boolean);
    if (stagedBefore.some((file) => !files.includes(file))) throw new Error('暂存区包含本次文件清单以外的变更，请先人工处理');
    const author = [];
    if (input.authorName !== undefined || input.authorEmail !== undefined) {
      if (!input.authorName?.trim() || !input.authorEmail?.trim() || /[\x00-\x1f<>]/.test(input.authorName) || !/^[^\s<>@]+@[^\s<>@]+$/.test(input.authorEmail)) throw new Error('提交人姓名或邮箱格式无效');
      author.push('-c', `user.name=${input.authorName.trim()}`, '-c', `user.email=${input.authorEmail.trim()}`);
    }
    await this.run(workspace, [...overrides, 'add', '--all', '--', ...files]);
    const branch = `refs/heads/agent/${basename(workspace)}`;
    const oldHead = (await this.run(workspace, ['rev-parse', '--verify', `${branch}^{commit}`])).text.trim();
    const tree = (await this.run(workspace, [...overrides, 'write-tree'])).text.trim();
    const stagedAfter = (await this.run(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', oldHead, tree, '--'])).text.split('\0').filter(Boolean);
    if (!stagedAfter.length) throw new Error('当前文件清单没有可提交变更');
    if (stagedAfter.some((file) => !files.includes(file))) throw new Error('暂存区发生并发变化，已停止提交');
    for (const file of stagedAfter) await this.validateCommitPath(workspace, file);
    const stagedContent = new Map<string, string | null>();
    for (const file of stagedAfter) {
      const entry = (await this.run(workspace, ['ls-tree', '-z', tree, '--', file])).text;
      if (!entry) { stagedContent.set(file, null); continue; }
      const metadata = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(entry);
      if (!metadata) throw new Error('提交快照包含链接、子模块或特殊文件，已拒绝');
      const size = Number((await this.run(workspace, ['cat-file', '-s', metadata[2]])).text.trim());
      if (!Number.isSafeInteger(size) || size > MAX_DIFF_BYTES) throw new Error('提交规则校验的单个文本文件不能超过 512 KiB；尚未创建提交');
      stagedContent.set(file, (await this.run(workspace, ['cat-file', 'blob', metadata[2]], { maxBytes: MAX_DIFF_BYTES + 1, strictText: true })).text);
    }
    await input.beforeCommit?.(stagedContent);
    if ((await this.run(workspace, [...overrides, 'write-tree'])).text.trim() !== tree) throw new Error('规则检查期间暂存区发生并发变化，已停止提交');
    await this.workspace(workspace);
    // 固定 tree 创建对象，再以旧提交 SHA 为条件原子更新指定 agent 分支。
    const hash = (await this.run(workspace, [...overrides, ...author, 'commit-tree', tree, '-p', oldHead, '-m', input.message.trim()])).text.trim();
    await this.run(workspace, [...overrides, 'update-ref', '--create-reflog', '-m', '精工 Agent 提交', branch, hash, oldHead]);
    return hash;
  }

  private async remoteTarget(workspace: string, remote: string, remotes: string[], operation: '推送' | '拉取'): Promise<{ url: string; transport: string[] }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(remote)) throw new Error('远程仓库名称无效');
    if (!remotes.includes(remote)) throw new Error('所选远程仓库不存在');
    const rewrites = (await this.run(workspace, ['config', '--name-only', '--get-regexp', '^url\.'], { allowMissing: true })).text;
    if (rewrites.trim()) throw new Error(`Git 配置含 URL 重写规则，${operation}前需由管理员移除或审核`);
    const pushUrls = operation === '推送' ? (await this.run(workspace, ['config', '--get-all', `remote.${remote}.pushurl`], { allowMissing: true })).text.trim() : '';
    const configured = pushUrls || (await this.run(workspace, ['config', '--get-all', `remote.${remote}.url`], { allowMissing: true })).text.trim();
    const urls = configured.split(/\r?\n/).filter(Boolean);
    if (urls.length !== 1 || /[\x00-\x20]/.test(urls[0].replaceAll(' ', '')) || urls[0].startsWith('-')) throw new Error('远程仓库必须配置单一受支持地址');
    const url = urls[0];
    let local = false;
    if (isAbsolute(url) && !/^[/\\]{2}/.test(url)) {
      const target = await realpath(url);
      if ((await lstat(url)).isSymbolicLink() || (await this.run(target, ['rev-parse', '--is-bare-repository'])).text.trim() !== 'true') throw new Error(`本地${operation}目标必须为真实 Bare 仓库`);
      local = true;
    } else if (/^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s]+$/.test(url)) {
      // Git 标准 SSH scp 地址，协议固定为 SSH。
    } else {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('仅支持 HTTPS、SSH 或本地 Bare 仓库'); }
      if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.password || (parsed.protocol === 'https:' && parsed.username) || parsed.search || parsed.hash) throw new Error('远程地址协议不受支持或包含凭据');
    }
    return { url, transport: ['-c', 'core.sshCommand=ssh', '-c', 'core.askPass=', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', `protocol.file.allow=${local ? 'always' : 'never'}`] };
  }

  async push(workspacePath: string, remote: string): Promise<void> {
    const workspace = await this.workspace(workspacePath);
    const current = await this.state(workspace);
    if (current.dirty) throw new Error('请先提交或处理未提交变更，再推送当前 agent 分支');
    const { url, transport } = await this.remoteTarget(workspace, remote, current.remotes, '推送');
    const overrides = await this.mutationOverrides(workspace);
    await this.workspace(workspace);
    try {
      await this.run(workspace, [...overrides, ...transport, 'push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', url, `refs/heads/${current.branch}:refs/heads/${current.branch}`]);
    } catch (error) {
      if (/^https:/i.test(url)) throw new Error('HTTPS 推送失败。当前版本未接入 HTTPS 凭据认证，请改用已配置 SSH Agent 的 SSH 远程仓库，或由人工使用 Git Credential Manager 完成推送。');
      throw error;
    }
  }

  async pull(workspacePath: string, remote: string): Promise<void> {
    const workspace = await this.workspace(workspacePath);
    const current = await this.state(workspace);
    if (current.dirty) throw new Error('请先提交或处理未提交变更，再拉取当前 agent 分支');
    const { url, transport } = await this.remoteTarget(workspace, remote, current.remotes, '拉取');
    const overrides = [...await this.mutationOverrides(workspace), '-c', 'submodule.recurse=false', '-c', 'merge.verifySignatures=false', '-c', 'gc.auto=0'];
    const branch = `refs/heads/${current.branch}`;
    const oldHead = (await this.run(workspace, ['rev-parse', '--verify', `${branch}^{commit}`])).text.trim();
    const temporary = `refs/jinggong-pull/${randomUUID()}`;
    const network = async (args: string[]) => {
      try { return await this.run(workspace, [...overrides, ...transport, ...args]); }
      catch (error) {
        if (/^https:/i.test(url)) throw new Error('HTTPS 拉取失败。当前版本未接入 HTTPS 凭据认证，请改用已配置 SSH Agent 的 SSH 远程仓库，或由人工使用 Git Credential Manager 完成拉取。');
        throw error;
      }
    };
    const advertised = (await network(['ls-remote', '--heads', url, branch])).text.trim();
    if (!advertised) throw new Error('远程仓库不存在与当前 agent 分支同名的分支，请先推送该分支或由人工确认');
    if (!new RegExp(`^[a-f0-9]{40,64}\\t${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(advertised)) throw new Error('远程同名分支响应异常，已停止拉取');
    try {
      // 显式 URL 与独立临时 ref 避免应用仓库自定义 fetch refspec 或改动其他分支。
      await network(['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--refmap=', url, `${branch}:${temporary}`]);
      const target = (await this.run(workspace, ['rev-parse', '--verify', `${temporary}^{commit}`])).text.trim();
      if (target === oldHead) return;
      if ((await this.run(workspace, ['merge-base', '--is-ancestor', oldHead, target], { allowMissing: true })).code !== 0) {
        if ((await this.run(workspace, ['merge-base', '--is-ancestor', target, oldHead], { allowMissing: true })).code === 0) return;
        throw new Error('远程同名 agent 分支与本地已分叉，无法仅快进拉取；请人工处理，未合并或覆盖本地提交');
      }
      const changed = (await this.run(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', oldHead, target, '--'])).text.split('\0').filter(Boolean);
      for (const file of changed) {
        await this.safeFile(workspace, file);
        let candidate = workspace;
        for (const segment of file.split('/')) {
          candidate = resolve(candidate, segment);
          const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
          if (!info) break;
          if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error('拉取涉及符号链接、目录联接或硬链接，已拒绝覆盖');
        }
        const entry = (await this.run(workspace, ['ls-tree', '-z', target, '--', file])).text;
        if (entry && !/^(100644|100755) blob [a-f0-9]{40,64}\t/.test(entry)) throw new Error('远程变更包含链接、子模块或特殊文件，请人工审核后拉取');
      }
      await this.workspace(workspace);
      const latest = await this.state(workspace);
      if (latest.dirty || latest.commits[0]?.hash !== oldHead) throw new Error('拉取检查期间工作区或 HEAD 已变化，请确认后重试');
      // Git 自身仅快进更新工作树、索引与 HEAD；禁止合并提交和自动暂存。
      try {
        await this.run(workspace, [...overrides, 'merge', '--ff-only', '--no-edit', '--no-autostash', '--no-gpg-sign', '--no-overwrite-ignore', '--no-stat', '--quiet', target]);
      } catch {
        throw new Error('无法完成快进拉取，请检查本地未提交或被忽略文件、工作区锁与目录权限；请人工确认后重试');
      }
    } finally {
      await this.run(workspace, ['update-ref', '-d', temporary]);
    }
  }
}
