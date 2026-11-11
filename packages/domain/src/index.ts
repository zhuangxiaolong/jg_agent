export * from './engineering';
export * from './task-api';
import type { TaskEngineeringApi } from './task-api';
import type { TaskAcceptanceRecord, TaskAcceptanceStatus, TaskDependencyCondition, TaskExecutionStatus, TaskVerificationStatus } from './engineering';
export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'interrupted';
export interface Project { id: string; name: string; path: string; branch: string; collapsed?: boolean }
export type WorkspaceRepositoryRole = 'frontend' | 'backend' | 'common' | 'service' | 'test' | 'deployment' | 'docs' | 'other';
export type WorkspaceAccess = 'read' | 'write';
export interface DesktopWorkspaceRepository { id: string; alias: string; name: string; rootPath: string; role: WorkspaceRepositoryRole; primary: boolean; access: WorkspaceAccess; description?: string; defaultBranch?: string; currentBranch?: string; remoteUrl?: string; status?: 'clean' | 'dirty' | 'conflicted' | 'unavailable' }
export interface DesktopWorkspace { id: string; name: string; description?: string; system?: string; instructions?: string; primaryRepositoryId?: string; repositories: DesktopWorkspaceRepository[]; createdAt: string; updatedAt: string }
export type AgentMode = 'read' | 'develop';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type RuntimeKind = 'jinggong' | 'codex' | 'claude_agent_sdk';
export type PluginSourceType = 'zip' | 'folder' | 'local_marketplace';
export type PluginManifestFormat = 'portable' | 'codex-compat';
export type PluginTrustStatus = 'untrusted' | 'reviewed' | 'trusted' | 'revoked';
export type PluginStatus = 'imported' | 'installed' | 'disabled' | 'error' | 'unavailable';
export type PluginMcpTransport = 'stdio' | 'streamable-http';
export type PluginMcpHealthStatus = 'unknown' | 'healthy' | 'unhealthy' | 'auth-required' | 'unavailable';
export type RuntimePluginInstallState = 'not-installed' | 'installed' | 'disabled' | 'error' | 'unavailable';
export type SessionPluginEffectiveScope = 'session' | 'runtime-profile';
export type PluginAuditResult = 'success' | 'failure' | 'cancelled';
export interface PluginAuthor { name?: string; email?: string; url?: string }
/** 插件本地登记元数据；不得包含密钥、令牌或凭据原文。 */
export interface PluginRecord {
  id: string; name: string; version: string; description: string; author?: PluginAuthor;
  sourceType: PluginSourceType; sourcePath?: string; manifestPath: string; installPath: string;
  manifestFormat: PluginManifestFormat; contentHash: string; status: PluginStatus;
  trustStatus: PluginTrustStatus; enabled: boolean; createdAt: string; updatedAt: string;
}
export interface PluginVersionRecord { id: string; pluginId: string; version: string; installPath: string; contentHash: string; installedAt: string; isActive: boolean }
/** Skills 仅存发现元数据及摘要；文件正文由插件目录读取，不写入 SQLite。 */
export interface PluginSkillRecord {
  id: string; pluginId: string; name: string; description: string; skillDir: string; skillFile: string;
  contentHash: string; metadata?: { author?: string; compatibility?: string; tags?: string[] }; enabled: boolean;
}
/** MCP 配置只保存非敏感连接元数据；环境变量值和 HTTP Header 值必须使用凭据库引用。 */
export type PluginMcpConfigRedacted =
  | { transport: 'stdio'; command: string; args: string[]; cwd?: string; envVarNames?: string[] }
  | { transport: 'streamable-http'; url: string; headerNames?: string[] };
export interface PluginMcpServerRecord {
  id: string; pluginId: string; serverName: string; transport: PluginMcpTransport;
  configRedacted: PluginMcpConfigRedacted; credentialRefs: string[]; enabled: boolean;
  /** 仅是 Vault 中已配置的引用名，不是秘密值。 */
  configuredCredentialRefs?: string[];
  healthStatus: PluginMcpHealthStatus; lastCheckedAt?: string; lastError?: string;
}
export interface RuntimePluginBindingRecord {
  id: string; pluginId: string; runtimeKind: RuntimeKind; profileId: string; nativePluginId?: string;
  nativePath?: string; installState: RuntimePluginInstallState; lastSyncAt?: string; lastError?: string;
}
export interface SessionPluginSnapshotEntry {
  pluginId: string; name: string; version: string; contentHash: string; skillIds: string[]; skillNames: string[]; mcpServerIds: string[];
}
/** 固化会话启动时的选择与生效范围，不含可执行正文或凭据原文。 */
export interface SessionPluginSnapshot {
  sessionId: string; profileId: string; profileRevision: number; runtimeKind: RuntimeKind;
  effectiveScope: SessionPluginEffectiveScope; pluginIds: string[]; skillIds: string[];
  plugins: SessionPluginSnapshotEntry[]; snapshotHash: string; createdAt: string;
}
export type PluginAuditAction = 'import' | 'trust' | 'install' | 'uninstall' | 'enable' | 'disable' | 'mcp-test' | 'mcp-enable' | 'mcp-disable' | 'mcp-credential-save' | 'mcp-credential-clear' | 'runtime-sync' | 'session-selection';
export interface PluginAuditRecord {
  id: string; action: PluginAuditAction; pluginId?: string; runtimeKind?: RuntimeKind;
  actor: string; target?: string; result: PluginAuditResult; detailRedacted: Record<string, unknown>; createdAt: string;
}
export interface PluginImportResult { plugin: PluginRecord; warnings: string[] }
export interface CodexPluginImportSummary { imported: PluginImportResult[]; skipped: Array<{ path: string; error: string }>; scanned: number }
export interface PluginReviewResource { kind: 'reference' | 'script' | 'asset'; relativePath: string }
export interface PluginReviewSkill { id: string; name: string; description: string; skillFile: string; contentHash: string; resources: PluginReviewResource[] }
export interface PluginReviewManifest { format: PluginManifestFormat; path: string; sha256: string; raw: Record<string, unknown> }
export interface PluginReviewDiagnostic { code: string; message: string; paths?: string[]; severity: 'warning' | 'error' }
export interface PluginReviewMcpServer { id: string; pluginId: string; name: string; transport: PluginMcpTransport; command?: string; args?: string[]; cwd?: string; url?: string; envRefs?: Record<string, string>; httpHeaderRefs?: Record<string, string>; redactedConfig: Record<string, unknown> }
export interface PluginReview {
  sourceType: PluginSourceType;
  sourcePath?: string;
  contentHash: string;
  manifest: PluginReviewManifest;
  diagnostics: PluginReviewDiagnostic[];
  skills: PluginReviewSkill[];
  mcpServers: PluginReviewMcpServer[];
  hooks: string[];
  executableResources: string[];
}
export interface PluginDetail { plugin: PluginRecord; versions: PluginVersionRecord[]; skills: PluginSkillRecord[]; mcpServers: PluginMcpServerRecord[]; runtimeBindings: RuntimePluginBindingRecord[]; review: PluginReview }
export interface PluginValidationResult { valid: boolean; errors: string[]; warnings: string[] }
export interface PluginSkillPreview { skill: PluginSkillRecord; content: string; truncated: boolean }
export interface PluginMcpHealthResult { status: PluginMcpHealthStatus; error?: string; checkedAt: string }
export interface RuntimePluginSyncResult { profileId: string; installed: number; errors: string[]; syncedAt: string }
/** UI 通过 DesktopApi 的可选插件桥接访问；不依赖某个 Runtime 的实现细节。 */
export interface PluginManagerApi {
  selectPluginPath(sourceType: 'zip' | 'folder'): Promise<string | null>;
  importPlugin(input: { path: string; sourceType: 'zip' | 'folder' }): Promise<PluginImportResult>;
  importCodexPlugins(): Promise<CodexPluginImportSummary>;
  listPlugins(): Promise<PluginRecord[]>;
  getPluginDetail(pluginId: string): Promise<PluginDetail>;
  validatePlugin(pluginId: string): Promise<PluginValidationResult>;
  trustPlugin(pluginId: string, trustScope: 'install' | 'execute_mcp'): Promise<void>;
  installForCodex(pluginId: string, profileId: string): Promise<RuntimePluginBindingRecord>;
  uninstallFromCodex(pluginId: string, profileId: string): Promise<void>;
  enablePlugin(pluginId: string, enabled: boolean): Promise<void>;
  listSkills(pluginId?: string): Promise<PluginSkillRecord[]>;
  previewSkill(skillId: string): Promise<PluginSkillPreview>;
  listMcpServers(pluginId?: string): Promise<PluginMcpServerRecord[]>;
  setMcpServerEnabled(serverId: string, enabled: boolean): Promise<void>;
  saveMcpCredential(serverId: string, reference: string, secret: string): Promise<void>;
  clearMcpCredential(serverId: string, reference: string): Promise<void>;
  testMcpServer(serverId: string): Promise<PluginMcpHealthResult>;
  getSessionPluginSnapshot(sessionId: string): Promise<SessionPluginSnapshot | null>;
  updateSessionPluginSelection(input: { sessionId?: string; profileId: string; pluginIds: string[]; skillIds: string[] }): Promise<SessionPluginSnapshot>;
  syncCodexProfile(profileId: string): Promise<RuntimePluginSyncResult>;
}
export type RequirementAdmissionStatus = 'ready' | 'needs_confirmation' | 'blocked' | 'stale' | 'not_checked' | 'error';
export type RequirementItemStatus = 'confirmed' | 'missing' | 'ambiguous' | 'assumption' | 'not_applicable';
export type RequirementRiskLevel = 'critical' | 'high' | 'medium' | 'low';
export type RequirementBlockingStage = 'design' | 'implementation' | 'testing' | 'release' | 'none';
export type RequirementResolutionAction = 'confirm' | 'provide_info' | 'reject_assumption' | 'not_applicable' | 'accept_risk';
export type RequirementTaskType = 'bug' | 'feature' | 'integration' | 'schema' | 'report' | 'ui' | 'config' | 'refactor' | 'unknown';
export interface RequirementEvidence { sourceType: 'jira_summary' | 'jira_description' | 'jira_comment' | 'jira_attachment' | 'user_supplement' | 'project_context' | 'knowledge'; sourceId?: string; location?: string; quote?: string }
export interface RequirementCheckItem { id: string; itemKey: string; title: string; description?: string; status: RequirementItemStatus; riskLevel: RequirementRiskLevel; blockingStage: RequirementBlockingStage; overrideAllowed: boolean; finding: string; question?: string; evidence: RequirementEvidence[]; updatedAt: string }
export interface RequirementResolution { id: string; itemId: string; action: RequirementResolutionAction; valueText?: string; reason?: string; actorId?: string; actorLabel: string; createdAt: string }
export interface RequirementEffectiveItem extends RequirementCheckItem { effectiveStatus: RequirementItemStatus; riskAccepted: boolean; latestResolution?: RequirementResolution }
export interface RequirementAcceptanceCriterion { id: string; criterionKey: string; statement: string; status: 'confirmed' | 'needs_confirmation' | 'not_applicable'; source: RequirementEvidence[] }
export interface RequirementSnapshot { id: string; issueKey: string; jiraUpdated?: string; contentHash: string; fetchedAt: string; issue: JiraIssue }
export interface RequirementAnalysis { taskType: RequirementTaskType; projectGeneration: ProductSystem | 'unknown'; summary: string; items: RequirementCheckItem[]; acceptanceCriteria: RequirementAcceptanceCriterion[] }
export interface RequirementAdmission { id: string; status: RequirementAdmissionStatus; implementationAllowed: boolean; projectGeneration: ProductSystem | 'unknown'; taskType: RequirementTaskType; snapshotHash: string; templateVersion: string; ruleVersion: string; checkedAt: string; items: RequirementCheckItem[]; resolutions: RequirementResolution[]; acceptanceCriteria: RequirementAcceptanceCriterion[]; stageBlockers: RequirementBlockingStage[] }
export interface Session { id: string; workspaceId?: string; projectId?: string; title: string; alias?: string; reasoningEffort?: ReasoningEffort; workspacePath: string; branch?: string; baseBranch?: string; runtimeKind?: RuntimeKind; runtimeVersion?: string; runtimeThreadId?: string; runtimeNativeSessionId?: string; runtimeCapabilitiesVersion?: number; status: SessionStatus; createdAt: string; model: string; providerId?: string; mode?: AgentMode; system?: ProductSystem; jiraIssue?: JiraIssue; jiraProjectKey?: string; requirementAdmission?: RequirementAdmission; requirementAdmissionHistory?: RequirementAdmission[]; unreadCompletionId?: string; imported?: boolean }
export interface IpcErrorInfo { error: string; code?: string; details?: unknown; retryable?: boolean; suggestedAction?: string }
export type IpcResult<T> = { ok: true; value: T } | ({ ok: false } & IpcErrorInfo);
export interface AgentEvent { id: string; sessionId: string; type: 'user' | 'delta' | 'message' | 'tool' | 'status' | 'error' | 'approval'; text: string; createdAt: string; requestId?: number | string }
export type AgentTaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'WAITING' | 'BLOCKED';
export type AgentTaskRole = 'requirement' | 'architecture' | 'developer' | 'review' | 'testing' | 'documentation' | 'custom';
export type AgentTaskWorkspaceMode = 'read' | 'worktree';
export interface AgentTaskResult {
  summary?: string;
  changedFiles?: string[];
  testSummary?: string;
  unresolved?: string[];
  error?: string;
  logRef?: string;
}
export interface AgentTask {
  id: string;
  sessionId: string;
  projectId?: string;
  parentTaskId?: string;
  name: string;
  role: AgentTaskRole;
  description: string;
  input?: string;
  model?: string;
  runtimeKind?: RuntimeKind;
  workspaceMode: AgentTaskWorkspaceMode;
  workspacePath?: string;
  dependencyIds: string[];
  status: AgentTaskStatus;
  executionStatus?: TaskExecutionStatus;
  verificationStatus?: TaskVerificationStatus;
  acceptanceStatus?: TaskAcceptanceStatus;
  contractVersion?: number;
  stateVersion?: number;
  evidenceIds?: string[];
  dependencyConditions?: Record<string, TaskDependencyCondition>;
  acceptance?: TaskAcceptanceRecord;
  verificationReason?: string;
  acceptanceReason?: string;
  maxAttempts: number;
  attempt: number;
  timeoutMs?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: AgentTaskResult;
  error?: string;
}
export interface AgentTaskEvent { id: string; taskId: string; sessionId: string; type: AgentEvent['type']; text: string; createdAt: string; requestId?: number | string }
/** 瞬时审批请求；只通过 IPC 推送，不写入会话事件或数据库。 */
export interface ApprovalRequest { token: string; sessionId: string; kind: 'command' | 'fileChange'; summary: string; cwd?: string; reason?: string }
export interface ConversationAttachment { id: string; name: string; mimeType: string; size: number; kind: 'image' | 'file' }
export interface FileDiff { path: string; status: string; diff: string; binary?: boolean; truncated?: boolean; staged?: boolean }
export interface ProviderSettings { baseUrl: string; model: string; hasKey: boolean }
export interface ProviderModel { id: string; name: string }
export interface ProviderProfile { id: string; name: string; baseUrl: string; models: string[]; modelCatalog?: ProviderModel[]; hasKey: boolean }
export type CompletionSound = 'chime' | 'bright' | 'soft' | 'off';
export type UpdateMode = 'automatic' | 'manual';
export type UpdateState = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
export interface Preferences { theme: 'dark' | 'light' | 'system' | 'purple' | 'black' | 'sky' | 'grass'; style: 'jinggong' | 'minimal'; completionSound: CompletionSound; updateMode?: UpdateMode }
export interface LayoutPreferences {
  leftVisible: boolean;
  rightVisible: boolean;
  bottomVisible: boolean;
  leftWidth?: number;
  rightWidth?: number;
  bottomHeight?: number;
  composerHeight?: number;
}
export interface JiraSettings { baseUrl: string; account: string; hasPassword: boolean; projectKey?: string; dateFieldId?: string }
export interface WeComTargetSummary {
  id: string; name: string; purpose: 'private_group' | 'team_group'; credentialRef: string; hasCredential: boolean; enabled: boolean;
  mentionedUserIds?: string[]; mentionedMobiles?: string[];
  /** 可选策略范围；空数组表示不限制工作区或 Runtime。 */
  workspaceIds?: string[]; runtimeKinds?: RuntimeKind[];
  eventPolicy: { onCompleted: boolean; onFailed: boolean; onError: boolean; onCancelled: boolean; onInterrupted: boolean };
  createdAt: string; updatedAt: string;
}
export type WeComDeliveryKind = 'terminal' | 'test' | 'manual_retry';
export type WeComDeliveryStatus = 'sending' | 'sent' | 'failed';
export interface WeComDeliverySummary {
  id: string; kind: WeComDeliveryKind; status: WeComDeliveryStatus; targetId: string; targetName: string;
  eventType?: 'session.completed' | 'session.failed' | 'session.error' | 'session.cancelled' | 'session.interrupted';
  content: string; attempts: number; createdAt: string; updatedAt: string; errorCode?: string; errorSummary?: string; retryOfId?: string;
}
export interface WeComNotificationSettings { targets: WeComTargetSummary[]; deliveries: WeComDeliverySummary[] }
/** Claude Agent SDK 的独立运行时元数据；凭据仍由主进程 DPAPI 保存。 */
export interface ClaudeRuntimeSettings { hasCredential: boolean; model?: string; baseUrl?: string }
export interface JiraProject { id: string; key: string; name: string }
export type JiraImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export interface JiraAttachment { id: string; name: string; mimeType: string; size: number; url: string; localImage?: { sha256: string; mimeType: JiraImageMime; size: number }; imageWarning?: string }
export interface JiraIssue { id: string; key: string; summary: string; description: string; status: string; issueType: string; priority?: string; assignee?: string; updated?: string; url: string; attachments: JiraAttachment[]; fetchedAt: string }
export interface JiraConnectionResult { displayName: string; timeZone: string; fieldName: string; fieldType: 'date' | 'datetime' }
export interface JiraTransition { id: string; name: string; status: string }
export interface JiraAssignee { id: string; displayName: string; field: 'name' | 'accountId' }
export interface JiraTestImage { id: string; name: string; preview: string }
export interface JiraFlowInput { key: string; projectKey?: string; transitionId: string; assignee?: JiraAssignee; comment: string; imageIds: string[]; sessionId?: string }
export interface JiraSearchInput { date: string; startAt?: number; onlyMine?: boolean; scope?: 'daily' | 'recent'; projectKey?: string }
export interface JiraSearchPage { issues: JiraIssue[]; startAt: number; maxResults: number; total: number; isLast: boolean; jql: string; timeZone: string; fetchedAt: string }
export interface JiraSavedQuery { id: string; input: JiraSearchInput; page: JiraSearchPage; savedAt: string }
export type ProductSystem = 'MES5' | 'MES6' | 'WMS' | '通用';
export interface ManagedDocument { id: string; kind: 'dictionary' | 'requirement'; system: ProductSystem; name: string; content: string; digest: string; createdAt: string; enabled: boolean; remote?: { source: string; key: string; version: string; digest: string } }
export interface Memory { id: string; title: string; content: string; createdAt: string; source?: 'session'; sessionId?: string; projectId?: string; sourceEventId?: string }
export interface UpdateStatus { state: UpdateState; version?: string; progress?: number; message?: string }
export interface RequirementsSync { url: string; automatic: boolean; version?: string; lastChecked?: string; lastUpdated?: string; message?: string; error?: string }
export interface ShareExportInput { kind: 'session' | 'memories'; sessionId?: string; memoryIds?: string[] }
export interface ShareImportResult { sessions: number; memories: number; sessionId?: string }
export interface BrowserAction { action: 'open' | 'snapshot' | 'click' | 'fill' | 'select' | 'press' | 'evaluate' | 'screenshot' | 'back' | 'forward' | 'reload' | 'tab'; url?: string; ref?: string; selector?: string; frame?: string; value?: string; script?: string; key?: string; tabId?: string }
export interface SettingsSnapshot { preferences: Preferences; providers: ProviderProfile[]; jira: JiraSettings; documents: ManagedDocument[]; memories: Memory[]; update: UpdateStatus; appVersion: string; updateUrl: string; runtimeKind?: RuntimeKind; requirementsSync?: RequirementsSync; wecom?: WeComNotificationSettings; claude?: ClaudeRuntimeSettings; notificationWorkspaces?: Array<{ id: string; name: string }> }
export interface GitCommit { hash: string; shortHash: string; author: string; date: string; message: string }
export interface GitState { branch: string; commits: GitCommit[]; remotes: string[]; dirty: boolean }
export interface RequirementResult { documentId: string; name: string; status: 'pass' | 'fail' | 'review'; details: string[] }
export type VerificationProfileId = 'typecheck' | 'tests';
export type VerificationStatus = 'passed' | 'failed' | 'not_run' | 'indeterminate' | 'stale';
export type VerificationProcessStatus = 'not_started' | 'running' | 'completed' | 'cancelled' | 'timed_out' | 'crashed' | 'launch_failed';
export interface VerificationRunSummary {
  runId: string; projectId: string; projectName: string; sessionId: string; runType: 'test' | 'typecheck';
  status: VerificationStatus; processStatus: VerificationProcessStatus; exitCode: number | null;
  startedAt: string; finishedAt: string; durationMs: number; headSha?: string; fingerprintBefore?: string; fingerprintAfter?: string;
  stdoutBytes: number; stderrBytes: number; stdoutTruncated: boolean; stderrTruncated: boolean; limitations: string[];
  testReport?: { total: number; passed: number; failed: number; skipped: number; errors: number; status: 'parsed' | 'empty' | 'invalid' };
}
export interface VerificationRunDetail { summary: VerificationRunSummary; markdown: string; artifacts: string[] }
export interface VerificationRunEvent { runId: string; sessionId: string; state: 'started' | 'completed'; status?: VerificationStatus; processStatus?: VerificationProcessStatus; exitCode?: number | null }
export interface RuntimeHealth { available: boolean; version: string; compatible: boolean; detail: string; kind?: RuntimeKind; capabilitiesVersion?: number; upstreamCommit?: string; buildNumber?: string; sandbox?: 'verified' | 'unverified' }
export interface Bootstrap { projects: Project[]; sessions: Session[]; provider: ProviderSettings; runtime: RuntimeHealth; runtimes?: Partial<Record<RuntimeKind, RuntimeHealth>>; dataDirectory: string; gitVersion: string; settings: SettingsSnapshot; layout: LayoutPreferences; closeToTray: boolean }
export interface DesktopApi {
  /** Plugin Manager IPC 能力，当前构建未接入时保持未定义。 */
  pluginManager?: PluginManagerApi;
  bootstrap(): Promise<Bootstrap>;
  listWorkspaces(): Promise<DesktopWorkspace[]>;
  createWorkspace(input: { name: string; description?: string; system?: string; instructions?: string; alias?: string; role?: WorkspaceRepositoryRole; access?: WorkspaceAccess }): Promise<DesktopWorkspace | null>;
  addWorkspaceRepository(id: string, input: { alias?: string; role?: WorkspaceRepositoryRole; access?: WorkspaceAccess; description?: string }): Promise<DesktopWorkspace | null>;
  updateWorkspace(id: string, input: { name: string; description?: string; system?: string; instructions?: string }): Promise<DesktopWorkspace>;
  updateWorkspaceRepository(id: string, repositoryId: string, input: { alias: string; role: WorkspaceRepositoryRole; access: WorkspaceAccess; description?: string }): Promise<DesktopWorkspace>;
  setPrimaryWorkspaceRepository(id: string, repositoryId: string): Promise<DesktopWorkspace>;
  removeWorkspaceRepository(id: string, repositoryId: string): Promise<DesktopWorkspace>;
  deleteWorkspace(id: string): Promise<void>;
  refreshWorkspaceRepository(id: string, repositoryId: string): Promise<DesktopWorkspace>;
  selectProject(): Promise<Project | null>;
  renameProject(id: string, name: string): Promise<Project>;
  setProjectCollapsed(id: string, collapsed: boolean): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  createSession(input: { workspaceId?: string; projectId?: string; jiraIssueKey?: string; jiraProjectKey?: string; baseBranch?: string; mode?: AgentMode; runtimeKind?: RuntimeKind; pluginIds?: string[]; alias?: string } | string, jiraIssueKey?: string, jiraProjectKey?: string, baseBranch?: string): Promise<Session>;
  listProjectBranches(projectId: string): Promise<string[]>;
  switchSessionBranch(sessionId: string, baseBranch: string): Promise<Session>;
  renameSession(id: string, alias: string): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  markSessionRead(id: string, completionId: string): Promise<void>;
  getEvents(sessionId: string): Promise<AgentEvent[]>;
  listAgentTasks(sessionId: string): Promise<AgentTask[]>;
  taskEngineering?: TaskEngineeringApi;
  listAgentTaskEvents(sessionId: string, taskId: string): Promise<AgentTaskEvent[]>;
  createAgentTask(input: { sessionId: string; name: string; role: AgentTaskRole; description: string; input?: string; workspaceMode?: AgentTaskWorkspaceMode; outputExpectations?: string[]; acceptanceCriteria?: string[]; dependencyIds?: string[]; timeoutMs?: number; maxAttempts?: number }): Promise<AgentTask>;
  cancelAgentTask(sessionId: string, taskId: string): Promise<void>;
  sendTurn(sessionId: string, prompt: string, attachmentIds?: string[]): Promise<void>;
  refreshRequirementAdmission(sessionId: string): Promise<Session>;
  resolveRequirementItem(sessionId: string, itemId: string, action: RequirementResolutionAction, valueText?: string, reason?: string): Promise<Session>;
  pickAttachments(sessionId: string): Promise<ConversationAttachment[]>;
  cancelRun(sessionId: string): Promise<void>;
  resolveApproval(token: string, decision: 'accept' | 'decline'): Promise<void>;
  getDiff(sessionId: string): Promise<FileDiff[]>;
  getFileDiff(sessionId: string, file: string): Promise<FileDiff>;
  configureSession(sessionId: string, input: { providerId?: string; model?: string; mode?: AgentMode; system?: ProductSystem; reasoningEffort?: ReasoningEffort; runtimeKind?: RuntimeKind }): Promise<Session>;
  bindSessionProject(sessionId: string, projectId: string, baseBranch?: string): Promise<Session>;
  getSettings(): Promise<SettingsSnapshot>;
  checkRuntime(kind: RuntimeKind): Promise<RuntimeHealth>;
  saveRuntimeKind(kind: RuntimeKind): Promise<RuntimeKind>;
  savePreferences(input: Preferences): Promise<Preferences>;
  saveLayout(input: LayoutPreferences): Promise<LayoutPreferences>;
  notifyCompletion(sessionTitle: string): Promise<void>;
  copyText(text: string): Promise<void>;
  openBrowser(sessionId: string, url?: string): Promise<void>;
  exportShare(input: ShareExportInput): Promise<string | null>;
  importShare(projectId?: string): Promise<ShareImportResult | null>;
  saveRequirementsSync(input: { url: string; automatic: boolean }): Promise<RequirementsSync>;
  syncRequirements(): Promise<RequirementsSync>;
  installUpdate(): Promise<void>;
  checkForUpdate(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  saveUpdateUrl(url: string): Promise<string>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  saveModelProvider(input: { id?: string; name: string; baseUrl: string; models: string[]; modelCatalog?: ProviderModel[]; apiKey?: string }): Promise<ProviderProfile>;
  fetchProviderModels(providerId: string): Promise<ProviderModel[]>;
  deleteModelProvider(id: string): Promise<void>;
  saveJira(input: { baseUrl: string; account: string; password?: string; projectKey?: string; dateFieldId?: string }): Promise<JiraSettings>;
  saveClaudeCredential(apiKey: string): Promise<ClaudeRuntimeSettings>;
  saveClaudeRuntime(input: { model: string; baseUrl?: string }): Promise<ClaudeRuntimeSettings>;
  testClaudeConnection(): Promise<RuntimeHealth>;
  clearClaudeCredential(): Promise<void>;
  saveWeComTarget(input: { id?: string; name: string; purpose: 'private_group' | 'team_group'; webhookUrl?: string; enabled: boolean; mentionedUserIds?: string[]; mentionedMobiles?: string[]; workspaceIds?: string[]; runtimeKinds?: RuntimeKind[]; eventPolicy: WeComTargetSummary['eventPolicy'] }): Promise<WeComTargetSummary>;
  deleteWeComTarget(id: string): Promise<void>;
  testWeComTarget(id: string): Promise<{ status: 'sent' | 'failed' | 'skipped'; errorSummary?: string }>;
  retryWeComDelivery(id: string): Promise<{ status: 'sent' | 'failed' | 'skipped'; errorSummary?: string }>;
  saveRequirement(input: { id?: string; title: string; content: string; system: ProductSystem }): Promise<ManagedDocument>;
  testJiraConnection(): Promise<JiraConnectionResult>;
  listJiraProjects(): Promise<JiraProject[]>;
  searchJiraIssues(input: JiraSearchInput): Promise<JiraSearchPage>;
  listJiraQueries(): Promise<JiraSavedQuery[]>;
  getJiraIssue(key: string, projectKey?: string): Promise<JiraIssue>;
  getJiraWorkflow(key: string, projectKey?: string): Promise<{ transitions: JiraTransition[]; assignees: JiraAssignee[]; testResult: string; sessionId?: string }>;
  searchJiraAssignees(key: string, query: string, projectKey?: string): Promise<JiraAssignee[]>;
  selectJiraTestImages(): Promise<JiraTestImage[]>;
  transitionJira(input: JiraFlowInput): Promise<{ message: string; issue?: JiraIssue }>;
  getJiraImage(issueKey: string, attachmentId: string, sessionId?: string): Promise<string>;
  importDocument(input: { kind: ManagedDocument['kind']; system: ProductSystem }): Promise<ManagedDocument | null>;
  deleteDocument(id: string): Promise<void>;
  setDocumentEnabled(id: string, enabled: boolean): Promise<void>;
  saveMemory(input: { title: string; content: string }): Promise<Memory>;
  deleteMemory(id: string): Promise<void>;
  getGitState(sessionId: string): Promise<GitState>;
  startVerification(sessionId: string, profileId: VerificationProfileId): Promise<{ runId: string }>;
  cancelVerification(sessionId: string, runId: string): Promise<void>;
  listVerificationRuns(sessionId: string): Promise<VerificationRunSummary[]>;
  getVerificationRun(sessionId: string, runId: string): Promise<VerificationRunDetail>;
  readVerificationArtifact(sessionId: string, runId: string, artifact: 'stdout.log' | 'stderr.log' | 'report.md' | 'manifest.json' | 'test-results/junit.xml'): Promise<string>;
  onVerification(listener: (event: VerificationRunEvent) => void): () => void;
  generateCommitMessage(sessionId: string): Promise<string>;
  checkRequirements(sessionId: string): Promise<RequirementResult[]>;
  commitChanges(sessionId: string, input: { message: string; reviewedDocumentIds: string[]; authorName?: string; authorEmail?: string }): Promise<string>;
  pushChanges(sessionId: string, remote: string): Promise<void>;
  pullChanges(sessionId: string, remote: string): Promise<void>;
  stageFile(sessionId: string, file: string): Promise<void>;
  unstageFile(sessionId: string, file: string): Promise<void>;
  discardFile(sessionId: string, file: string): Promise<void>;
  openChangedFile(sessionId: string, file: string): Promise<void>;
  saveProvider(input: { baseUrl: string; model: string; apiKey?: string }): Promise<ProviderSettings>;
  backup(): Promise<string | null>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  onAgentTaskEvent(listener: (event: AgentTaskEvent) => void): () => void;
  onApprovalRequest(listener: (request: ApprovalRequest) => void): () => void;
  onApprovalResolved(listener: (token: string) => void): () => void;
}
