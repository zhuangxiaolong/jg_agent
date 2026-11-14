import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Session, GitState } from '../../../../packages/domain/src';
import { GitConnector, SessionGitConflictError, type SessionGitChange, type SessionGitPrepared } from '../../../../packages/git-connector/src';

interface SessionGitRecord {
  version: 1; workspace: string; branch: string; changes: SessionGitChange[]; commits: string[];
  active?: { before: string; key: string }; pendingCommit?: string;
}

/** 归属仅采集在本会话任务执行区间内产生的补丁；历史未采集修改不推断归属。 */
export class SessionGitService {
  private active = new Map<string, string>();
  private finishing = new Map<string, Promise<void>>();
  constructor(private git: GitConnector, private root: string) {}
  private key(session: Session): string { return path.resolve(session.workspacePath).toLowerCase(); }
  private filename(session: Session): string {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(session.id)) throw new Error('会话标识无效');
    return path.join(this.root, `${session.id}-${createHash('sha256').update(this.key(session)).digest('hex').slice(0, 16)}.json`);
  }
  private async load(session: Session): Promise<SessionGitRecord> {
    let record: SessionGitRecord;
    try { record = JSON.parse(await readFile(this.filename(session), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('会话 Git 归属记录无法读取，已停止处理');
      return { version: 1, workspace: session.workspacePath, branch: (await this.git.state(session.workspacePath)).branch, changes: [], commits: [] };
    }
    if (record.version !== 1 || path.resolve(record.workspace).toLowerCase() !== this.key(session) || !Array.isArray(record.changes) || !Array.isArray(record.commits)) throw new Error('会话项目已切换或归属记录异常，请新建会话后处理该项目');
    if (record.pendingCommit) {
      if (await this.git.containsSessionCommit(session.workspacePath, record.pendingCommit)) record.changes = [];
      record.pendingCommit = undefined;
      await this.save(session, record);
    }
    return record;
  }
  private async save(session: Session, record: SessionGitRecord): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const filename = this.filename(session), temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), 'utf8');
    await rename(temporary, filename);
  }
  async begin(session: Session): Promise<void> {
    if (!session.projectId) return;
    const key = this.key(session);
    if (this.active.has(key)) throw new Error('同一项目已有任务正在修改代码，请等待结束后发送，避免会话变更混入');
    this.active.set(key, session.id);
    try {
      const record = await this.load(session);
      if (record.active) throw new Error('上次任务异常退出，无法确定后续修改归属；请新建会话继续，原文件已保留');
      if ((await this.git.state(session.workspacePath)).branch !== record.branch) throw new Error('项目分支已切换，请新建会话后继续，避免混入其他分支修改');
      const token = randomUUID();
      const before = await this.git.sessionSnapshot(session.workspacePath, `refs/jinggong/sessions/${session.id}/${token}-before`);
      record.active = { before, key: token };
      await this.save(session, record);
    } catch (error) { this.active.delete(key); throw error; }
  }
  async finish(session: Session): Promise<void> {
    const pending = this.finishing.get(session.id);
    if (pending) return pending;
    if (!session.projectId || this.active.get(this.key(session)) !== session.id) return;
    const operation = (async () => { try {
      const record = await this.load(session);
      if (!record.active) return;
      const after = await this.git.sessionSnapshot(session.workspacePath, `refs/jinggong/sessions/${session.id}/${record.active.key}-after`);
      if (record.active.before !== after) {
        const previous = record.changes.at(-1);
        if (previous?.after === record.active.before && !previous.excluded?.length) previous.after = after;
        else record.changes.push({ before: record.active.before, after });
      }
      record.active = undefined;
      await this.save(session, record);
    } finally { this.active.delete(this.key(session)); this.finishing.delete(session.id); } })();
    this.finishing.set(session.id, operation);
    return operation;
  }
  private async changes(session: Session): Promise<SessionGitChange[]> {
    const record = await this.load(session);
    if ((await this.git.state(session.workspacePath)).branch !== record.branch) throw new Error('项目分支已切换，不能将其他分支差异当作本会话变更');
    const changes = [...record.changes];
    if (record.active) {
      if (this.active.get(this.key(session)) !== session.id) throw new Error('上次任务未完成归属核验，请新建会话继续，原修改已保留');
      const after = await this.git.sessionSnapshot(session.workspacePath, `refs/jinggong/sessions/${session.id}/live`);
      changes.push({ before: record.active.before, after });
    }
    return changes;
  }
  async prepare(session: Session): Promise<SessionGitPrepared> {
    return this.git.prepareSessionChanges(session.workspacePath, await this.changes(session));
  }
  async prepareCommit(session: Session): Promise<SessionGitPrepared> {
    const changes = await this.changes(session);
    try { return await this.git.prepareSessionChanges(session.workspacePath, changes); }
    catch (error) {
      if (!(error instanceof SessionGitConflictError)) throw error;
      return this.git.prepareSessionChanges(session.workspacePath, changes, true);
    }
  }
  async diff(session: Session) {
    return (await this.prepareCommit(session)).diffs;
  }
  async state(session: Session): Promise<GitState> {
    const diffs = await this.diff(session), record = await this.load(session);
    const state = await this.git.state(session.workspacePath);
    return { ...state, dirty: diffs.length > 0, changesBlockedReason: diffs.find(file => file.readOnlyReason)?.readOnlyReason, commits: state.commits.filter(commit => record.commits.includes(commit.hash)) };
  }
  async commit(session: Session, prepared: SessionGitPrepared, input: Parameters<GitConnector['commitSessionChanges']>[2]): Promise<string> {
    const record = await this.load(session);
    if (record.active) throw new Error('请等待本会话任务完成后提交');
    const hash = await this.git.commitSessionChanges(session.workspacePath, prepared, { ...input, onCommitCreated: async hash => {
      record.pendingCommit = hash; record.commits.push(hash); await this.save(session, record);
    } });
    record.pendingCommit = undefined; record.changes = [];
    await this.save(session, record);
    return hash;
  }
  async push(session: Session, remote: string): Promise<void> {
    const record = await this.load(session);
    if (record.active || (await this.prepare(session)).diffs.length) throw new Error('请先提交本会话修改，再推送本会话提交');
    await this.git.pushSessionCommits(session.workspacePath, remote, record.commits);
  }
  async assertFile(session: Session, file: string): Promise<void> {
    await this.git.assertSessionFile(session.workspacePath, await this.prepare(session), file);
  }
  async forgetFile(session: Session, file: string): Promise<void> {
    const record = await this.load(session);
    for (const change of record.changes) change.excluded = [...new Set([...(change.excluded ?? []), file])];
    await this.save(session, record);
  }
  async remove(session: Session, authorizedPaths: string[]): Promise<void> {
    this.filename(session);
    const allowed = await Promise.all(authorizedPaths.map(value => realpath(value).catch(() => path.resolve(value))));
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of names.filter(name => name.startsWith(`${session.id}-`) && /^[a-zA-Z0-9_-]+-[a-f0-9]{16}\.json$/.test(name))) {
      const filename = path.join(this.root, name), record = JSON.parse(await readFile(filename, 'utf8')) as SessionGitRecord;
      if (allowed.some(value => path.resolve(value).toLowerCase() === path.resolve(record.workspace).toLowerCase())) await this.git.removeSessionSnapshots(record.workspace, session.id);
      await unlink(filename);
    }
  }
}
