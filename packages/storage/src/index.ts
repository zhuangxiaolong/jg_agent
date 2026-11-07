import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import { existsSync, mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentEvent, JiraAttachment, JiraIssue, JiraSavedQuery, JiraSearchInput, JiraSearchPage, JiraSettings, LayoutPreferences, ManagedDocument, Memory, Preferences, Project, ProviderProfile, ProviderSettings, RequirementsSync, Session } from '../../domain/src/index';
import { assertDocumentTextSize } from '../../knowledge/src/limits';

const SCHEMA_VERSION = 2;
export const LEGACY_PROVIDER_ID = 'legacy-default';

function jiraText(value: string, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error(`Jira ${name}不是文本或超过 ${maximum} 字符，未保存任务快照。`);
  return value;
}

function jiraUrl(value: string, name: string): string {
  const text = jiraText(value, name, 2000);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`Jira ${name}无效，未保存任务快照。`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(key => /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth|authorization|password|signature|jwt)$/i.test(key))) throw new Error(`Jira ${name}必须是无授权凭据的 HTTP/HTTPS 地址，未保存任务快照。`);
  return text;
}

/** 只保存任务、附件来源与本机图片摘要；二进制独立存放，不保存凭据和请求头。 */
export function jiraSnapshot(issue: JiraIssue): JiraIssue {
  if (!issue || typeof issue !== 'object' || !Array.isArray(issue.attachments) || issue.attachments.length > 200) throw new Error('Jira 任务附件元数据超过 200 条或格式无效，未保存任务快照。');
  const value: JiraIssue = {
    id: jiraText(issue.id, '任务 ID', 200),
    key: jiraText(issue.key, '任务 Key', 100),
    summary: jiraText(issue.summary, '概要', 2000),
    description: jiraText(issue.description, '描述', 100000),
    status: jiraText(issue.status, '状态', 200),
    issueType: jiraText(issue.issueType, '任务类型', 200),
    url: jiraUrl(issue.url, '来源链接'),
    fetchedAt: jiraText(issue.fetchedAt, '获取时间', 100),
    attachments: issue.attachments.map((attachment): JiraAttachment => {
      if (!attachment || typeof attachment !== 'object' || !Number.isSafeInteger(attachment.size) || attachment.size < 0) throw new Error('Jira 附件大小元数据无效，未保存任务快照。');
      const value: JiraAttachment = { id: jiraText(attachment.id, '附件 ID', 200), name: jiraText(attachment.name, '附件名称', 1024), mimeType: jiraText(attachment.mimeType, '附件类型', 200), size: attachment.size, url: attachment.url === '' ? '' : jiraUrl(attachment.url, '附件来源链接') };
      if (attachment.localImage !== undefined) {
        const image = attachment.localImage;
        if (!image || !/^[a-f0-9]{64}$/.test(image.sha256) || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType) || !Number.isSafeInteger(image.size) || image.size < 1 || image.size > 8 * 1024 * 1024) throw new Error('Jira 本地图片摘要或格式无效');
        value.localImage = { sha256: image.sha256, mimeType: image.mimeType, size: image.size };
      }
      if (attachment.imageWarning !== undefined) value.imageWarning = jiraText(attachment.imageWarning, '图片提示', 500);
      return value;
    })
  };
  if (issue.priority !== undefined) value.priority = jiraText(issue.priority, '优先级', 200);
  if (issue.assignee !== undefined) value.assignee = jiraText(issue.assignee, '负责人', 500);
  if (issue.updated !== undefined) value.updated = jiraText(issue.updated, '更新时间', 100);
  return value;
}

function atomicWrite(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(handle, bytes, offset, bytes.length - offset);
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, path);
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** 主进程单实例持有；每次事务成功后将真实 SQLite 快照原子落盘。 */
export class LocalStore {
  private closed = false;

  private constructor(private db: Database, private readonly sql: SqlJsStatic, private readonly path: string) {}

  static async open(path: string, wasmPath?: string, options: { recoverUnfinished?: boolean } = {}): Promise<LocalStore> {
    const absolute = resolve(path);
    const sql = await initSqlJs(wasmPath ? { locateFile: () => wasmPath } : undefined);
    const bytes = existsSync(absolute) ? readFileSync(absolute) : undefined;
    if (bytes && (bytes.length < 16 || bytes.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0')) {
      throw new Error('本地数据库文件损坏或格式不受支持；已保留原文件，请先备份后修复。');
    }
    let db: Database | undefined;
    try {
      db = bytes ? new sql.Database(bytes) : new sql.Database();
      const integrity = db.exec('PRAGMA quick_check');
      if (integrity[0]?.values[0]?.[0] !== 'ok') throw new Error('本地数据库完整性检查失败；已保留原文件。');
      const version = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0]);
      if (version > SCHEMA_VERSION) throw new Error('数据库版本较新，请使用较新版本的精工 Agent；原文件未修改。');
      if (version === 0 && bytes) throw new Error('数据库缺少受支持的版本信息；原文件未修改。');
      const store = new LocalStore(db, sql, absolute);
      db.run('PRAGMA foreign_keys = ON');
      if (version === 0) {
        store.transaction(() => {
          db!.run(`
            CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
            CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), created_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), value TEXT NOT NULL);
            CREATE INDEX events_session ON events(session_id, seq);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA user_version = 1;
          `);
        });
      }
      if (version <= 1) {
        store.transaction(() => {
          store.db.run(`
            CREATE TABLE model_providers (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE memories (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, value TEXT NOT NULL);
            PRAGMA user_version = 2;
          `);
          const legacy = store.getProvider();
          if (legacy.baseUrl && legacy.model) {
            const profile: ProviderProfile = { id: LEGACY_PROVIDER_ID, name: '原有模型服务', baseUrl: legacy.baseUrl, models: [legacy.model], hasKey: legacy.hasKey };
            store.db.run('INSERT INTO model_providers(id, value) VALUES (?, ?)', [profile.id, JSON.stringify(profile)]);
          }
        });
      }
      const unfinished = options.recoverUnfinished === false ? [] : store.listSessions().filter(session => session.status === 'running' || session.status === 'waiting-approval');
      if (unfinished.length) {
        store.transaction(() => {
          for (const session of unfinished) {
            const recovered: Session = { ...session, status: 'interrupted' };
            db!.run('UPDATE sessions SET value = ? WHERE id = ?', [JSON.stringify(recovered), session.id]);
            const event: AgentEvent = { id: randomUUID(), sessionId: session.id, type: 'status', text: '上次运行因应用退出或中断而停止，尚未完成。', createdAt: new Date().toISOString() };
            db!.run('INSERT INTO events(id, session_id, value) VALUES (?, ?, ?)', [event.id, session.id, JSON.stringify(event)]);
          }
        });
      }
      return store;
    } catch (error) {
      db?.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('本地数据库已关闭。');
  }

  private rows<T>(query: string, params: SqlValue[] = []): T[] {
    this.assertOpen();
    const statement = this.db.prepare(query);
    try {
      statement.bind(params);
      const result: T[] = [];
      while (statement.step()) result.push(JSON.parse(String(statement.getAsObject().value)) as T);
      return result;
    } finally { statement.free(); }
  }

  private transaction(action: () => void): void {
    this.assertOpen();
    const previous = this.db.export();
    try {
      this.db.run('BEGIN IMMEDIATE');
      action();
      this.db.run('COMMIT');
      atomicWrite(this.path, this.db.export());
    } catch (error) {
      this.db.close();
      this.db = new this.sql.Database(previous);
      this.db.run('PRAGMA foreign_keys = ON');
      throw error;
    }
  }

  listProjects(): Project[] { return this.rows<Project>('SELECT value FROM projects ORDER BY rowid'); }

  saveProject(project: Project): void {
    const value: Project = { id: project.id, name: project.name, path: project.path, branch: project.branch };
    if (typeof project.collapsed === 'boolean') value.collapsed = project.collapsed;
    this.transaction(() => this.db.run('INSERT INTO projects(id, path, value) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET path=excluded.path, value=excluded.value', [value.id, value.path, JSON.stringify(value)]));
  }

  renameProject(id: string, name: string): Project {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('项目显示名称必须为1至100字，且不能包含控制字符');
    const current = this.listProjects().find(item => item.id === id);
    if (!current) throw new Error('本地项目不存在');
    const updated = { ...current, name: name.trim() };
    this.transaction(() => {
      this.db.run('UPDATE projects SET value = ? WHERE id = ?', [JSON.stringify(updated), id]);
      for (const session of this.listSessions().filter(item => item.projectId === id)) {
        const prefix = `${session.jiraIssue ? session.jiraIssue.key + ' · ' : ''}${current.name} · `;
        if (session.title === prefix + '只读分析' || session.title === prefix + '代码开发' || session.title === prefix + '隔离开发') {
          this.db.run('UPDATE sessions SET value = ? WHERE id = ?', [JSON.stringify({ ...session, title: `${session.jiraIssue ? session.jiraIssue.key + ' · ' : ''}${updated.name} · ${session.mode === 'develop' ? '隔离开发' : '只读分析'}` }), session.id]);
        }
      }
    });
    return updated;
  }

  setProjectCollapsed(id: string, collapsed: boolean): Project {
    const current = this.listProjects().find(item => item.id === id);
    if (!current) throw new Error('本地项目不存在');
    if (typeof collapsed !== 'boolean') throw new Error('项目收放状态无效');
    const next = { ...current, collapsed }; this.saveProject(next); return next;
  }

  deleteProject(id: string): void {
    if (!this.listProjects().some(item => item.id === id)) throw new Error('本地项目不存在');
    if (this.listSessions().some(item => item.projectId === id)) throw new Error('项目下仍有会话，请先删除会话后再删除项目');
    this.transaction(() => this.db.run('DELETE FROM projects WHERE id = ?', [id]));
  }

  listSessions(): Session[] { return this.rows<Session>('SELECT value FROM sessions ORDER BY created_at DESC, rowid DESC'); }

  getSession(id: string): Session | undefined { return this.rows<Session>('SELECT value FROM sessions WHERE id = ?', [id])[0]; }

  saveSession(session: Session): void {
    const value: Session = { id: session.id, projectId: session.projectId, title: session.title, workspacePath: session.workspacePath, branch: session.branch, status: session.status, createdAt: session.createdAt, model: session.model };
    if (session.baseBranch !== undefined) value.baseBranch = session.baseBranch;
    if (session.alias !== undefined) {
      if (typeof session.alias !== 'string' || !session.alias.trim() || session.alias.trim().length > 100 || /[\x00-\x1f\x7f]/.test(session.alias)) throw new Error('会话别名必须为1至100字，且不能包含控制字符');
      value.alias = session.alias.trim();
    }
    if (session.reasoningEffort !== undefined) {
      if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(session.reasoningEffort)) throw new Error('无效模型推理强度');
      value.reasoningEffort = session.reasoningEffort;
    }
    if (session.runtimeThreadId !== undefined) value.runtimeThreadId = session.runtimeThreadId;
    if (session.runtimeCapabilitiesVersion !== undefined) value.runtimeCapabilitiesVersion = session.runtimeCapabilitiesVersion;
    if (session.providerId !== undefined) value.providerId = session.providerId;
    if (session.mode !== undefined) value.mode = session.mode;
    if (session.system !== undefined) value.system = session.system;
    if (session.jiraIssue !== undefined) value.jiraIssue = jiraSnapshot(session.jiraIssue);
    if (session.unreadCompletionId !== undefined) value.unreadCompletionId = session.unreadCompletionId;
    if (session.imported) value.imported = true;
    this.transaction(() => this.db.run('INSERT INTO sessions(id, project_id, created_at, value) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, created_at=excluded.created_at, value=excluded.value', [value.id, value.projectId, value.createdAt, JSON.stringify(value)]));
  }

  events(sessionId: string): AgentEvent[] { return this.rows<AgentEvent>('SELECT value FROM events WHERE session_id = ? ORDER BY seq', [sessionId]); }

  renameSession(id: string, alias: string): Session {
    if (typeof alias !== 'string' || alias.trim().length > 100 || /[\x00-\x1f\x7f]/.test(alias)) throw new Error('会话别名最多100字，且不能包含控制字符');
    const current = this.getSession(id); if (!current) throw new Error('会话不存在');
    const value = { ...current, alias: alias.trim() || undefined };
    this.saveSession(value); return value;
  }

  deleteSession(id: string): void {
    if (!this.getSession(id)) throw new Error('会话不存在');
    this.transaction(() => { this.db.run('DELETE FROM events WHERE session_id = ?', [id]); this.db.run('DELETE FROM sessions WHERE id = ?', [id]); });
  }

  markSessionRead(id: string, completionId: string): void {
    const current = this.getSession(id);
    if (current?.unreadCompletionId === completionId) this.saveSession({ ...current, unreadCompletionId: undefined });
  }

  getUpdateUrl(): string | undefined { return this.rows<{ url: string }>('SELECT value FROM settings WHERE key = ?', ['update-url'])[0]?.url; }
  getRequirementsSync(): RequirementsSync {
    return this.rows<RequirementsSync>('SELECT value FROM settings WHERE key = ?', ['requirements-sync'])[0] ?? { url: 'https://github.com/zhuangxiaolong/jg_agent', automatic: true };
  }
  saveRequirementsSync(value: RequirementsSync): void {
    this.transaction(() => this.db.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['requirements-sync', JSON.stringify(value)]));
  }
  applyRequirementUpdate(documents: ManagedDocument[], state: RequirementsSync): void {
    for (const document of documents) assertDocumentTextSize(document.content, 'requirement');
    this.transaction(() => {
      for (const document of documents) this.db.run('INSERT INTO documents(id,kind,created_at,value) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', [document.id, document.kind, document.createdAt, JSON.stringify(document)]);
      this.db.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['requirements-sync', JSON.stringify(state)]);
    });
  }
  importSharedData(session: Session | undefined, events: AgentEvent[], memories: Memory[]): void {
    this.transaction(() => {
      if (session) this.db.run('INSERT INTO sessions(id,project_id,created_at,value) VALUES (?,?,?,?)', [session.id, session.projectId, session.createdAt, JSON.stringify(session)]);
      for (const event of events) this.db.run('INSERT INTO events(id,session_id,value) VALUES (?,?,?)', [event.id, event.sessionId, JSON.stringify(event)]);
      for (const memory of memories) this.db.run('INSERT INTO memories(id,created_at,value) VALUES (?,?,?)', [memory.id, memory.createdAt, JSON.stringify(memory)]);
    });
  }
  saveUpdateUrl(url: string): void {
    this.transaction(() => this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['update-url', JSON.stringify({ url })]));
  }

  appendEvent(event: AgentEvent): void {
    const value: AgentEvent = { id: event.id, sessionId: event.sessionId, type: event.type, text: event.text, createdAt: event.createdAt };
    if (event.requestId !== undefined) value.requestId = event.requestId;
    this.transaction(() => this.db.run('INSERT INTO events(id, session_id, value) VALUES (?, ?, ?)', [value.id, value.sessionId, JSON.stringify(value)]));
  }

  getProvider(): ProviderSettings {
    return this.rows<ProviderSettings>('SELECT value FROM settings WHERE key = ?', ['provider'])[0] ?? { baseUrl: '', model: '', hasKey: false };
  }

  saveProvider(provider: ProviderSettings): void {
    // 只挑选元数据字段，调用方意外传入的 apiKey 等附加属性不会入库。
    const value: ProviderSettings = { baseUrl: provider.baseUrl, model: provider.model, hasKey: provider.hasKey };
    this.transaction(() => {
      this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['provider', JSON.stringify(value)]);
      if (value.baseUrl && value.model) {
        const profile: ProviderProfile = { id: LEGACY_PROVIDER_ID, name: '原有模型服务', baseUrl: value.baseUrl, models: [value.model], hasKey: value.hasKey };
        this.db.run('INSERT INTO model_providers(id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', [profile.id, JSON.stringify(profile)]);
      }
    });
  }

  getPreferences(): Preferences {
    const value = this.rows<Partial<Preferences>>('SELECT value FROM settings WHERE key = ?', ['preferences'])[0];
    return { theme: value?.theme ?? 'dark', style: value?.style ?? 'jinggong', completionSound: value?.completionSound ?? 'chime', updateMode: value?.updateMode === 'manual' ? 'manual' : 'automatic' };
  }

  savePreferences(preferences: Preferences): void {
    const value: Preferences = { theme: preferences.theme, style: preferences.style, completionSound: preferences.completionSound ?? 'chime', updateMode: preferences.updateMode === 'manual' ? 'manual' : 'automatic' };
    this.transaction(() => this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['preferences', JSON.stringify(value)]));
  }

  getLayout(): LayoutPreferences {
    const value = this.rows<LayoutPreferences>('SELECT value FROM settings WHERE key = ?', ['layout'])[0];
    return {
      leftVisible: typeof value?.leftVisible === 'boolean' ? value.leftVisible : true,
      rightVisible: typeof value?.rightVisible === 'boolean' ? value.rightVisible : true,
      bottomVisible: typeof value?.bottomVisible === 'boolean' ? value.bottomVisible : true,
      leftWidth: Number.isInteger(value?.leftWidth) && value.leftWidth! >= 180 && value.leftWidth! <= 520 ? value.leftWidth : 244,
      rightWidth: Number.isInteger(value?.rightWidth) && value.rightWidth! >= 260 && value.rightWidth! <= 680 ? value.rightWidth : 420,
      bottomHeight: Number.isInteger(value?.bottomHeight) && value.bottomHeight! >= 100 && value.bottomHeight! <= 480 ? value.bottomHeight : 180,
      ...(Number.isInteger(value?.composerHeight) && value.composerHeight! >= 80 && value.composerHeight! <= 400 ? { composerHeight: value.composerHeight } : {})
    };
  }

  saveLayout(layout: LayoutPreferences): void {
    if (!layout || [layout.leftVisible, layout.rightVisible, layout.bottomVisible].some(value => typeof value !== 'boolean')) throw new Error('面板显示状态必须为布尔值');
    const leftWidth = layout.leftWidth ?? 244, rightWidth = layout.rightWidth ?? 420, bottomHeight = layout.bottomHeight ?? 180;
    if (!Number.isInteger(leftWidth) || leftWidth < 180 || leftWidth > 520 || !Number.isInteger(rightWidth) || rightWidth < 260 || rightWidth > 680 || !Number.isInteger(bottomHeight) || bottomHeight < 100 || bottomHeight > 480) throw new Error('面板尺寸超出允许范围');
    const value: LayoutPreferences = { leftVisible: layout.leftVisible, rightVisible: layout.rightVisible, bottomVisible: layout.bottomVisible, leftWidth, rightWidth, bottomHeight };
    if (layout.composerHeight !== undefined) {
      if (!Number.isInteger(layout.composerHeight) || layout.composerHeight < 80 || layout.composerHeight > 400) throw new Error('输入框尺寸超出允许范围');
      value.composerHeight = layout.composerHeight;
    }
    this.transaction(() => this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['layout', JSON.stringify(value)]));
  }

  listProviders(): ProviderProfile[] { return this.rows<ProviderProfile>('SELECT value FROM model_providers ORDER BY rowid'); }

  saveModelProvider(provider: ProviderProfile): void {
    const value: ProviderProfile = { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, models: [...provider.models], hasKey: provider.hasKey };
    this.transaction(() => {
      this.db.run('INSERT INTO model_providers(id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', [value.id, JSON.stringify(value)]);
      if (value.id === LEGACY_PROVIDER_ID) {
        const legacy: ProviderSettings = { baseUrl: value.baseUrl, model: value.models[0] ?? '', hasKey: value.hasKey };
        this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['provider', JSON.stringify(legacy)]);
      }
    });
  }

  deleteModelProvider(id: string): void {
    this.transaction(() => {
      this.db.run('DELETE FROM model_providers WHERE id = ?', [id]);
      if (id === LEGACY_PROVIDER_ID) this.db.run('DELETE FROM settings WHERE key = ?', ['provider']);
    });
  }

  getJira(): JiraSettings {
    return this.rows<JiraSettings>('SELECT value FROM settings WHERE key = ?', ['jira'])[0] ?? { baseUrl: '', account: '', hasPassword: false };
  }

  saveJira(jira: JiraSettings): void {
    const value: JiraSettings = { baseUrl: jira.baseUrl, account: jira.account, hasPassword: jira.hasPassword };
    if (jira.projectKey !== undefined) value.projectKey = jiraText(jira.projectKey, '项目 Key', 100);
    if (jira.dateFieldId !== undefined) value.dateFieldId = jiraText(jira.dateFieldId, '日期字段', 100);
    this.transaction(() => this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['jira', JSON.stringify(value)]));
  }

  private jiraScope(scope: string): void {
    if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('Jira 本地记录连接范围无效');
  }

  listJiraQueries(scope: string): JiraSavedQuery[] {
    this.jiraScope(scope);
    return this.rows<JiraSavedQuery>('SELECT value FROM settings WHERE key LIKE ?', [`jira-query:${scope}:%`]).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  private pruneJiraCache(scope: string): void {
    const queries = this.listJiraQueries(scope);
    for (const record of queries.slice(50)) this.db.run('DELETE FROM settings WHERE key = ?', [`jira-query:${scope}:${record.id}`]);
    const records = this.db.exec("SELECT key, value FROM settings WHERE key LIKE 'jira-query:%' OR key LIKE 'jira-detail:%'")[0]?.values.map(([key, value]) => ({ key: String(key), value: String(value) })) ?? [];
    records.sort((a, b) => String(JSON.parse(a.value).savedAt).localeCompare(String(JSON.parse(b.value).savedAt)));
    let bytes = records.reduce((sum, row) => sum + Buffer.byteLength(row.value), 0);
    let details = records.filter(item => item.key.startsWith('jira-detail:')).length;
    for (const row of records) {
      if (bytes <= 64 * 1024 * 1024 && details <= 200) break;
      if (bytes <= 64 * 1024 * 1024 && !row.key.startsWith('jira-detail:')) continue;
      this.db.run('DELETE FROM settings WHERE key = ?', [row.key]);
      bytes -= Buffer.byteLength(row.value);
      if (row.key.startsWith('jira-detail:')) details--;
    }
  }

  saveJiraQuery(scope: string, input: JiraSearchInput, page: JiraSearchPage): JiraSavedQuery {
    this.jiraScope(scope);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !['daily', 'recent'].includes(input.scope ?? 'daily') || input.projectKey !== undefined && input.projectKey !== '*' && !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.projectKey)) throw new Error('Jira 本地记录查询条件无效');
    if (!Array.isArray(page.issues) || page.issues.length > 50 || !Number.isSafeInteger(page.total) || page.total < 0 || !Number.isSafeInteger(page.startAt) || page.startAt < 0 || !Number.isSafeInteger(page.maxResults) || page.maxResults < 0 || page.maxResults > 1000 || page.startAt !== (input.startAt ?? 0)) throw new Error('Jira 本地记录分页无效');
    const normalized: JiraSearchInput = { date: input.date, startAt: page.startAt, onlyMine: !!input.onlyMine, scope: input.scope ?? 'daily', ...(input.projectKey === undefined ? {} : { projectKey: input.projectKey }) };
    const id = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const record: JiraSavedQuery = { id, input: normalized, page: { startAt: page.startAt, maxResults: page.maxResults, total: page.total, isLast: !!page.isLast, jql: jiraText(page.jql, '查询语句', 2000), timeZone: jiraText(page.timeZone, '时区', 200), fetchedAt: jiraText(page.fetchedAt, '读取时间', 100), issues: page.issues.map(jiraSnapshot) }, savedAt: new Date().toISOString() };
    if (Buffer.byteLength(JSON.stringify(record)) > 16 * 1024 * 1024) throw new Error('单次 Jira 记录超过16 MiB，请缩小查询范围');
    this.transaction(() => {
      this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [`jira-query:${scope}:${id}`, JSON.stringify(record)]);
      this.pruneJiraCache(scope);
    });
    return record;
  }

  saveJiraIssue(scope: string, issue: JiraIssue): void {
    this.jiraScope(scope);
    const snapshot = jiraSnapshot(issue);
    if (!/^[A-Z][A-Z0-9_]{0,63}-[1-9]\d{0,18}$/.test(snapshot.key)) throw new Error('Jira 本地记录任务 Key 无效');
    const record = { issue: snapshot, savedAt: new Date().toISOString() };
    this.transaction(() => {
      this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [`jira-detail:${scope}:${snapshot.key}`, JSON.stringify(record)]);
      this.pruneJiraCache(scope);
    });
  }

  getCachedJiraIssue(scope: string, key: string): JiraIssue | undefined {
    this.jiraScope(scope);
    const detail = this.rows<{ issue: JiraIssue; savedAt: string }>('SELECT value FROM settings WHERE key = ?', [`jira-detail:${scope}:${key}`])[0];
    const queried = this.listJiraQueries(scope).flatMap(record => record.page.issues).filter(issue => issue.key === key).sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0];
    return detail && (!queried || detail.issue.fetchedAt >= queried.fetchedAt) ? detail.issue : queried;
  }

  listDocuments(): ManagedDocument[] { return this.rows<ManagedDocument>('SELECT value FROM documents ORDER BY created_at DESC, rowid DESC'); }

  saveDocument(document: ManagedDocument): void {
    assertDocumentTextSize(document.content, document.kind);
    const value: ManagedDocument = { id: document.id, kind: document.kind, system: document.system, name: document.name, content: document.content, digest: document.digest, createdAt: document.createdAt, enabled: document.enabled };
    if (document.remote) value.remote = { ...document.remote };
    this.transaction(() => this.db.run('INSERT INTO documents(id, kind, created_at, value) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, created_at=excluded.created_at, value=excluded.value', [value.id, value.kind, value.createdAt, JSON.stringify(value)]));
  }

  deleteDocument(id: string): void { this.transaction(() => this.db.run('DELETE FROM documents WHERE id = ?', [id])); }

  setDocumentEnabled(id: string, enabled: boolean): void {
    const document = this.rows<ManagedDocument>('SELECT value FROM documents WHERE id = ?', [id])[0];
    if (!document) throw new Error('文档不存在');
    this.saveDocument({ ...document, enabled });
  }

  listMemories(): Memory[] { return this.rows<Memory>('SELECT value FROM memories ORDER BY created_at DESC, rowid DESC'); }

  saveMemory(memory: Memory): void {
    const value: Memory = { id: memory.id, title: memory.title, content: memory.content, createdAt: memory.createdAt };
    if (memory.source === 'session') { value.source = 'session'; value.sessionId = memory.sessionId; value.projectId = memory.projectId; value.sourceEventId = memory.sourceEventId; }
    this.transaction(() => this.db.run('INSERT INTO memories(id, created_at, value) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, value=excluded.value', [value.id, value.createdAt, JSON.stringify(value)]));
  }

  deleteMemory(id: string): void { this.transaction(() => this.db.run('DELETE FROM memories WHERE id = ?', [id])); }

  backup(destination: string): void {
    this.assertOpen();
    if (resolve(destination) === this.path) throw new Error('备份文件不能覆盖正在使用的数据库。');
    atomicWrite(resolve(destination), this.db.export());
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}
