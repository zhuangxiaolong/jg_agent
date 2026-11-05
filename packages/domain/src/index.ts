export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'interrupted';
export interface Project { id: string; name: string; path: string; branch: string }
export type AgentMode = 'read' | 'develop';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface Session { id: string; projectId: string; title: string; alias?: string; reasoningEffort?: ReasoningEffort; workspacePath: string; branch: string; runtimeThreadId?: string; runtimeCapabilitiesVersion?: number; status: SessionStatus; createdAt: string; model: string; providerId?: string; mode?: AgentMode; system?: ProductSystem; jiraIssue?: JiraIssue }
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };
export interface AgentEvent { id: string; sessionId: string; type: 'user' | 'delta' | 'message' | 'tool' | 'status' | 'error' | 'approval'; text: string; createdAt: string; requestId?: number | string }
export interface FileDiff { path: string; status: string; diff: string; binary?: boolean; truncated?: boolean }
export interface ProviderSettings { baseUrl: string; model: string; hasKey: boolean }
export interface ProviderProfile { id: string; name: string; baseUrl: string; models: string[]; hasKey: boolean }
export interface Preferences { theme: 'dark' | 'light' | 'system' | 'purple' | 'black' | 'sky' | 'grass'; style: 'jinggong' | 'minimal' }
export interface LayoutPreferences { leftVisible: boolean; rightVisible: boolean; bottomVisible: boolean }
export interface JiraSettings { baseUrl: string; account: string; hasPassword: boolean; projectKey?: string; dateFieldId?: string }
export interface JiraProject { id: string; key: string; name: string }
export type JiraImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export interface JiraAttachment { id: string; name: string; mimeType: string; size: number; url: string; localImage?: { sha256: string; mimeType: JiraImageMime; size: number } }
export interface JiraIssue { id: string; key: string; summary: string; description: string; status: string; issueType: string; priority?: string; assignee?: string; updated?: string; url: string; attachments: JiraAttachment[]; fetchedAt: string }
export interface JiraConnectionResult { displayName: string; timeZone: string; fieldName: string; fieldType: 'date' | 'datetime' }
export interface JiraSearchInput { date: string; startAt?: number; onlyMine?: boolean; scope?: 'daily' | 'recent'; projectKey?: string }
export interface JiraSearchPage { issues: JiraIssue[]; startAt: number; maxResults: number; total: number; isLast: boolean; jql: string; timeZone: string; fetchedAt: string }
export interface JiraSavedQuery { id: string; input: JiraSearchInput; page: JiraSearchPage; savedAt: string }
export type ProductSystem = 'MES5' | 'MES6' | 'WMS' | '通用';
export interface ManagedDocument { id: string; kind: 'dictionary' | 'requirement'; system: ProductSystem; name: string; content: string; digest: string; createdAt: string; enabled: boolean }
export interface Memory { id: string; title: string; content: string; createdAt: string }
export interface SettingsSnapshot { preferences: Preferences; providers: ProviderProfile[]; jira: JiraSettings; documents: ManagedDocument[]; memories: Memory[] }
export interface GitCommit { hash: string; shortHash: string; author: string; date: string; message: string }
export interface GitState { branch: string; commits: GitCommit[]; remotes: string[]; dirty: boolean }
export interface RequirementResult { documentId: string; name: string; status: 'pass' | 'fail' | 'review'; details: string[] }
export interface RuntimeHealth { available: boolean; version: string; compatible: boolean; detail: string }
export interface Bootstrap { projects: Project[]; sessions: Session[]; provider: ProviderSettings; runtime: RuntimeHealth; dataDirectory: string; gitVersion: string; settings: SettingsSnapshot; layout: LayoutPreferences; closeToTray: boolean }
export interface DesktopApi {
  bootstrap(): Promise<Bootstrap>;
  selectProject(): Promise<Project | null>;
  renameProject(id: string, name: string): Promise<Project>;
  createSession(projectId: string, jiraIssueKey?: string, jiraProjectKey?: string): Promise<Session>;
  renameSession(id: string, alias: string): Promise<Session>;
  getEvents(sessionId: string): Promise<AgentEvent[]>;
  sendTurn(sessionId: string, prompt: string): Promise<void>;
  cancelRun(sessionId: string): Promise<void>;
  getDiff(sessionId: string): Promise<FileDiff[]>;
  configureSession(sessionId: string, input: { providerId: string; model: string; mode: AgentMode; system?: ProductSystem; reasoningEffort?: ReasoningEffort }): Promise<Session>;
  getSettings(): Promise<SettingsSnapshot>;
  savePreferences(input: Preferences): Promise<Preferences>;
  saveLayout(input: LayoutPreferences): Promise<LayoutPreferences>;
  saveModelProvider(input: { id?: string; name: string; baseUrl: string; models: string[]; apiKey?: string }): Promise<ProviderProfile>;
  deleteModelProvider(id: string): Promise<void>;
  saveJira(input: { baseUrl: string; account: string; password?: string; projectKey?: string; dateFieldId?: string }): Promise<JiraSettings>;
  saveRequirement(input: { id?: string; title: string; content: string; system: ProductSystem }): Promise<ManagedDocument>;
  testJiraConnection(): Promise<JiraConnectionResult>;
  listJiraProjects(): Promise<JiraProject[]>;
  searchJiraIssues(input: JiraSearchInput): Promise<JiraSearchPage>;
  listJiraQueries(): Promise<JiraSavedQuery[]>;
  getJiraIssue(key: string, projectKey?: string): Promise<JiraIssue>;
  getJiraImage(issueKey: string, attachmentId: string, sessionId?: string): Promise<string>;
  importDocument(input: { kind: ManagedDocument['kind']; system: ProductSystem }): Promise<ManagedDocument | null>;
  deleteDocument(id: string): Promise<void>;
  setDocumentEnabled(id: string, enabled: boolean): Promise<void>;
  saveMemory(input: { title: string; content: string }): Promise<Memory>;
  deleteMemory(id: string): Promise<void>;
  getGitState(sessionId: string): Promise<GitState>;
  generateCommitMessage(sessionId: string): Promise<string>;
  checkRequirements(sessionId: string): Promise<RequirementResult[]>;
  commitChanges(sessionId: string, input: { message: string; reviewedDocumentIds: string[]; authorName?: string; authorEmail?: string }): Promise<string>;
  pushChanges(sessionId: string, remote: string): Promise<void>;
  pullChanges(sessionId: string, remote: string): Promise<void>;
  saveProvider(input: { baseUrl: string; model: string; apiKey?: string }): Promise<ProviderSettings>;
  backup(): Promise<string | null>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}
