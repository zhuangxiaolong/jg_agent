import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import { applyTaskLifecycleTransition, assertTaskGraph, assertTaskSafeMetadata, executionStatusOf, legacyTaskStatus, reconcileTaskStates, taskContentHash, taskDependenciesSatisfied, validateTaskContract, validateTaskEvidence, verifyTaskLifecycleEventChain } from '../../agent-orchestrator/src';
import type { TaskAuditAppend, TaskAuditSnapshot, TaskContract, TaskContractRecord, TaskEvidenceRecord, TaskLifecycleEvent, TaskLifecycleTransition, VerificationExecutionRecord } from '../../domain/src/engineering';
import { existsSync, mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentEvent, AgentTask, AgentTaskEvent, ClaudeRuntimeSettings, JiraAttachment, JiraIssue, JiraSavedQuery, JiraSearchInput, JiraSearchPage, JiraSettings, LayoutPreferences, ManagedDocument, Memory, PluginAuditAction, PluginAuditRecord, PluginMcpConfigRedacted, PluginMcpHealthStatus, PluginMcpServerRecord, PluginRecord, PluginSkillRecord, PluginSourceType, PluginStatus, PluginTrustStatus, PluginVersionRecord, Preferences, Project, ProviderProfile, ProviderSettings, RequirementsSync, RuntimeKind, RuntimePluginBindingRecord, RuntimePluginInstallState, Session, SessionPluginSnapshot } from '../../domain/src/index';
import type { WeComDeliveryRecord, WeComDeliveryStatus } from '../../wecom-notification/src/desktop-service';
import { assertDocumentTextSize } from '../../knowledge/src/limits';

const SCHEMA_VERSION = 10;
const EMPTY_TASK_EVENT_HASH = '0'.repeat(64);
export const LEGACY_PROVIDER_ID = 'legacy-default';

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLUGIN_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const PLUGIN_SECRET_KEY_PATTERN = /(?:secret|password|passwd|token|api[_-]?key|authorization|cookie|webhook(?:url)?|private[_-]?key|client[_-]?secret|\benv\b|headers?)/i;
const PLUGIN_SECRET_VALUE_PATTERN = /(?:\bBearer\s+[A-Za-z0-9._~+/-]{8,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*["']?[^\s"',;}]{6,}|--?(?:api[_-]?key|token|password|secret|authorization)(?:=|\s+)\S+|qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=)/i;

function pluginId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !PLUGIN_ID_PATTERN.test(value)) throw new Error(`${label}标识无效`);
  return value;
}

function pluginText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || PLUGIN_SECRET_VALUE_PATTERN.test(value)) throw new Error(`${label}无效或包含未脱敏凭据，未保存插件数据`);
  return value;
}

function pluginUrl(value: unknown, label: string): string {
  const text = pluginText(value, label, 2000);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${label}必须为有效 HTTP/HTTPS 地址`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(key => PLUGIN_SECRET_KEY_PATTERN.test(key))) throw new Error(`${label}不能包含授权凭据或敏感查询参数`);
  return text;
}

function pluginTimestamp(value: unknown, label: string): string {
  const text = pluginText(value, label, 100);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${label}时间无效`);
  return text;
}

function safePluginAuthor(author: PluginRecord['author']): PluginRecord['author'] {
  if (author === undefined) return undefined;
  if (!author || typeof author !== 'object' || Array.isArray(author)) throw new Error('插件作者元数据无效');
  const value: NonNullable<PluginRecord['author']> = {};
  if (author.name !== undefined) value.name = pluginText(author.name, '插件作者', 200);
  if (author.email !== undefined) value.email = pluginText(author.email, '插件作者邮箱', 320);
  if (author.url !== undefined) value.url = pluginUrl(author.url, '插件作者链接');
  return value;
}

function safePluginRecord(record: PluginRecord): PluginRecord {
  if (!record || typeof record !== 'object' || !['zip', 'folder', 'local_marketplace'].includes(record.sourceType) || !['portable', 'codex-compat'].includes(record.manifestFormat) || !['imported', 'installed', 'disabled', 'error', 'unavailable'].includes(record.status) || !['untrusted', 'reviewed', 'trusted', 'revoked'].includes(record.trustStatus) || typeof record.enabled !== 'boolean' || !PLUGIN_HASH_PATTERN.test(record.contentHash)) throw new Error('插件记录格式无效');
  if (record.enabled && record.trustStatus !== 'trusted') throw new Error('插件必须先标记为 trusted 才能启用');
  const value: PluginRecord = {
    id: pluginId(record.id, '插件'), name: pluginText(record.name, '插件名称', 128),
    version: pluginText(record.version, '插件版本', 100), description: pluginText(record.description, '插件说明', 4000, true),
    sourceType: record.sourceType, manifestPath: pluginText(record.manifestPath, 'Manifest 路径', 2048),
    installPath: pluginText(record.installPath, '插件安装路径', 2048), manifestFormat: record.manifestFormat,
    contentHash: record.contentHash.toLowerCase(), status: record.status, trustStatus: record.trustStatus,
    enabled: record.enabled, createdAt: pluginTimestamp(record.createdAt, '插件创建'), updatedAt: pluginTimestamp(record.updatedAt, '插件更新')
  };
  if (record.sourcePath !== undefined) value.sourcePath = pluginText(record.sourcePath, '插件来源路径', 2048);
  if (record.author !== undefined) value.author = safePluginAuthor(record.author);
  return value;
}

function safePluginVersion(record: PluginVersionRecord): PluginVersionRecord {
  if (!record || typeof record !== 'object' || typeof record.isActive !== 'boolean' || !PLUGIN_HASH_PATTERN.test(record.contentHash)) throw new Error('插件版本记录格式无效');
  return {
    id: pluginId(record.id, '插件版本'), pluginId: pluginId(record.pluginId, '插件'), version: pluginText(record.version, '插件版本', 100),
    installPath: pluginText(record.installPath, '插件版本路径', 2048), contentHash: record.contentHash.toLowerCase(),
    installedAt: pluginTimestamp(record.installedAt, '插件安装'), isActive: record.isActive
  };
}

function safePluginSkill(record: PluginSkillRecord): PluginSkillRecord {
  if (!record || typeof record !== 'object' || typeof record.enabled !== 'boolean' || !PLUGIN_HASH_PATTERN.test(record.contentHash)) throw new Error('Plugin Skill 记录格式无效');
  const value: PluginSkillRecord = {
    id: pluginId(record.id, 'Skill'), pluginId: pluginId(record.pluginId, '插件'), name: pluginText(record.name, 'Skill 名称', 200),
    description: pluginText(record.description, 'Skill 说明', 4000, true), skillDir: pluginText(record.skillDir, 'Skill 目录', 2048),
    skillFile: pluginText(record.skillFile, 'Skill 文件', 2048), contentHash: record.contentHash.toLowerCase(), enabled: record.enabled
  };
  if (record.metadata !== undefined) {
    if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) throw new Error('Skill 元数据无效');
    const metadata: NonNullable<PluginSkillRecord['metadata']> = {};
    if (record.metadata.author !== undefined) metadata.author = pluginText(record.metadata.author, 'Skill 作者', 200);
    if (record.metadata.compatibility !== undefined) metadata.compatibility = pluginText(record.metadata.compatibility, 'Skill 兼容信息', 500);
    if (record.metadata.tags !== undefined) {
      if (!Array.isArray(record.metadata.tags) || record.metadata.tags.length > 50) throw new Error('Skill 标签无效');
      metadata.tags = record.metadata.tags.map(tag => pluginText(tag, 'Skill 标签', 80));
    }
    value.metadata = metadata;
  }
  return value;
}

function safeCredentialRefs(refs: unknown): string[] {
  if (!Array.isArray(refs) || refs.length > 100 || refs.some(ref => typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(ref) || PLUGIN_SECRET_VALUE_PATTERN.test(ref))) throw new Error('MCP 凭据引用无效');
  return [...new Set(refs)];
}

function safePluginMcpConfig(config: PluginMcpConfigRedacted): PluginMcpConfigRedacted {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('MCP 脱敏配置无效');
  const keys = Object.keys(config);
  if (config.transport === 'stdio') {
    if (keys.some(key => !['transport', 'command', 'args', 'cwd', 'envVarNames'].includes(key)) || !Array.isArray(config.args) || config.args.length > 128) throw new Error('stdio MCP 配置包含不支持的字段');
    const value: Extract<PluginMcpConfigRedacted, { transport: 'stdio' }> = {
      transport: 'stdio', command: pluginText(config.command, 'MCP 命令', 2048),
      args: config.args.map(arg => pluginText(arg, 'MCP 参数', 2048, true))
    };
    if (config.cwd !== undefined) value.cwd = pluginText(config.cwd, 'MCP 工作目录', 2048);
    if (config.envVarNames !== undefined) {
      if (!Array.isArray(config.envVarNames) || config.envVarNames.length > 100 || config.envVarNames.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))) throw new Error('MCP 环境变量名称无效');
      value.envVarNames = [...new Set(config.envVarNames)];
    }
    return value;
  }
  if (config.transport === 'streamable-http') {
    if (keys.some(key => !['transport', 'url', 'headerNames'].includes(key))) throw new Error('HTTP MCP 配置包含不支持的字段');
    const value: Extract<PluginMcpConfigRedacted, { transport: 'streamable-http' }> = { transport: 'streamable-http', url: pluginUrl(config.url, 'MCP 地址') };
    if (config.headerNames !== undefined) {
      if (!Array.isArray(config.headerNames) || config.headerNames.length > 100 || config.headerNames.some(name => typeof name !== 'string' || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name))) throw new Error('MCP Header 名称无效');
      value.headerNames = [...new Set(config.headerNames)];
    }
    return value;
  }
  throw new Error('MCP 传输类型无效');
}

function safePluginMcpServer(record: PluginMcpServerRecord): PluginMcpServerRecord {
  if (!record || typeof record !== 'object' || typeof record.enabled !== 'boolean' || !['unknown', 'healthy', 'unhealthy', 'auth-required', 'unavailable'].includes(record.healthStatus) || !['stdio', 'streamable-http'].includes(record.transport)) throw new Error('MCP Server 记录格式无效');
  const configRedacted = safePluginMcpConfig(record.configRedacted);
  if (configRedacted.transport !== record.transport) throw new Error('MCP Server 传输类型与脱敏配置不一致');
  const value: PluginMcpServerRecord = {
    id: pluginId(record.id, 'MCP Server'), pluginId: pluginId(record.pluginId, '插件'),
    serverName: pluginText(record.serverName, 'MCP Server 名称', 200), transport: record.transport,
    configRedacted, credentialRefs: safeCredentialRefs(record.credentialRefs), enabled: record.enabled, healthStatus: record.healthStatus
  };
  if (record.configuredCredentialRefs !== undefined) {
    const configured = safeCredentialRefs(record.configuredCredentialRefs);
    if (configured.some(reference => !value.credentialRefs.includes(reference))) throw new Error('MCP Vault 状态引用不存在于 Server 配置');
    value.configuredCredentialRefs = configured;
  }
  if (record.lastCheckedAt !== undefined) value.lastCheckedAt = pluginTimestamp(record.lastCheckedAt, 'MCP 检查');
  if (record.lastError !== undefined) value.lastError = pluginText(record.lastError, 'MCP 错误', 1000, true);
  return value;
}

function safeRuntimePluginBinding(record: RuntimePluginBindingRecord): RuntimePluginBindingRecord {
  if (!record || typeof record !== 'object' || !['jinggong', 'codex', 'claude_agent_sdk'].includes(record.runtimeKind) || !['not-installed', 'installed', 'disabled', 'error', 'unavailable'].includes(record.installState)) throw new Error('Runtime 插件绑定格式无效');
  const value: RuntimePluginBindingRecord = {
    id: pluginId(record.id, 'Runtime 绑定'), pluginId: pluginId(record.pluginId, '插件'), runtimeKind: record.runtimeKind,
    profileId: pluginId(record.profileId, 'Runtime Profile'), installState: record.installState
  };
  if (record.nativePluginId !== undefined) value.nativePluginId = pluginText(record.nativePluginId, 'Runtime 插件标识', 256);
  if (record.nativePath !== undefined) value.nativePath = pluginText(record.nativePath, 'Runtime 插件路径', 2048);
  if (record.lastSyncAt !== undefined) value.lastSyncAt = pluginTimestamp(record.lastSyncAt, 'Runtime 同步');
  if (record.lastError !== undefined) value.lastError = pluginText(record.lastError, 'Runtime 错误', 1000, true);
  return value;
}

function safeSnapshot(snapshot: SessionPluginSnapshot): SessionPluginSnapshot {
  if (!snapshot || typeof snapshot !== 'object' || !['jinggong', 'codex', 'claude_agent_sdk'].includes(snapshot.runtimeKind) || !['session', 'runtime-profile'].includes(snapshot.effectiveScope) || !Number.isSafeInteger(snapshot.profileRevision) || snapshot.profileRevision < 0 || !PLUGIN_HASH_PATTERN.test(snapshot.snapshotHash) || !Array.isArray(snapshot.pluginIds) || !Array.isArray(snapshot.skillIds) || !Array.isArray(snapshot.plugins) || snapshot.plugins.length > 500 || snapshot.pluginIds.length > 500 || snapshot.skillIds.length > 2000) throw new Error('Session Plugin Snapshot 格式无效');
  const ids = (values: unknown[], label: string, maximum: number) => {
    if (values.length > maximum) throw new Error(`${label}数量超出限制`);
    const result = values.map(value => pluginId(value, label));
    if (new Set(result).size !== result.length) throw new Error(`${label}不能重复`);
    return result;
  };
  const plugins = snapshot.plugins.map(entry => {
    if (!entry || typeof entry !== 'object' || !PLUGIN_HASH_PATTERN.test(entry.contentHash) || !Array.isArray(entry.skillIds) || !Array.isArray(entry.skillNames) || !Array.isArray(entry.mcpServerIds) || entry.skillNames.length !== entry.skillIds.length) throw new Error('Session Plugin Snapshot 插件项无效');
    return {
      pluginId: pluginId(entry.pluginId, '插件'), name: pluginText(entry.name, '插件名称', 128), version: pluginText(entry.version, '插件版本', 100),
      contentHash: entry.contentHash.toLowerCase(), skillIds: ids(entry.skillIds, 'Skill', 500),
      skillNames: entry.skillNames.map(name => pluginText(name, 'Skill 名称', 200)), mcpServerIds: ids(entry.mcpServerIds, 'MCP Server', 500)
    };
  });
  if (new Set(plugins.map(entry => entry.pluginId)).size !== plugins.length) throw new Error('Session Plugin Snapshot 插件不能重复');
  return {
    sessionId: pluginId(snapshot.sessionId, '会话'), profileId: pluginId(snapshot.profileId, 'Runtime Profile'),
    profileRevision: snapshot.profileRevision, runtimeKind: snapshot.runtimeKind, effectiveScope: snapshot.effectiveScope,
    pluginIds: ids(snapshot.pluginIds, '插件', 500), skillIds: ids(snapshot.skillIds, 'Skill', 2000), plugins,
    snapshotHash: snapshot.snapshotHash.toLowerCase(), createdAt: pluginTimestamp(snapshot.createdAt, 'Session Snapshot')
  };
}

function safePluginAudit(record: PluginAuditRecord): PluginAuditRecord {
  const actions: PluginAuditAction[] = ['import', 'trust', 'install', 'uninstall', 'enable', 'disable', 'mcp-test', 'mcp-enable', 'mcp-disable', 'mcp-credential-save', 'mcp-credential-clear', 'runtime-sync', 'session-selection'];
  if (!record || typeof record !== 'object' || !actions.includes(record.action) || !['success', 'failure', 'cancelled'].includes(record.result) || !record.detailRedacted || typeof record.detailRedacted !== 'object' || Array.isArray(record.detailRedacted) || !['jinggong', 'codex', 'claude_agent_sdk', undefined].includes(record.runtimeKind)) throw new Error('插件审计记录格式无效');
  const sanitize = (value: unknown, depth: number): unknown => {
    if (depth > 8) throw new Error('插件审计明细层级超出限制');
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') return pluginText(value, '插件审计明细', 4000, true);
    if (Array.isArray(value)) {
      if (value.length > 100) throw new Error('插件审计明细数组超出限制');
      return value.map(item => sanitize(item, depth + 1));
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > 100) throw new Error('插件审计明细字段超出限制');
      const result: Record<string, unknown> = {};
      for (const [key, item] of entries) {
        if (PLUGIN_SECRET_KEY_PATTERN.test(key)) throw new Error('插件审计明细含有凭据字段，未保存');
        result[pluginText(key, '插件审计字段名', 100)] = sanitize(item, depth + 1);
      }
      return result;
    }
    throw new Error('插件审计明细类型无效');
  };
  const detailRedacted = sanitize(record.detailRedacted, 0) as Record<string, unknown>;
  const safe: PluginAuditRecord = {
    id: pluginId(record.id, '插件审计'), action: record.action,
    actor: pluginText(record.actor, '审计操作者', 200), result: record.result, detailRedacted,
    createdAt: pluginTimestamp(record.createdAt, '插件审计')
  };
  if (record.pluginId !== undefined) safe.pluginId = pluginId(record.pluginId, '插件');
  if (record.runtimeKind !== undefined) safe.runtimeKind = record.runtimeKind;
  if (record.target !== undefined) safe.target = pluginText(record.target, '插件审计目标', 500);
  if (Buffer.byteLength(JSON.stringify(safe), 'utf8') > 64 * 1024) throw new Error('单条插件审计记录不能超过 64 KiB');
  return safe;
}

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

function safeWeComDeliveryRecord(record: WeComDeliveryRecord): WeComDeliveryRecord {
  if (!record || typeof record !== 'object' || !/^[a-f0-9-]{36}$/i.test(record.id) || typeof record.idempotencyKey !== 'string' || record.idempotencyKey.length > 600 || !['terminal', 'test', 'manual_retry'].includes(record.kind) || !['sending', 'sent', 'failed'].includes(record.status)) throw new Error('企业微信通知记录格式无效');
  const target = record.targetSnapshot;
  if (!target || typeof target !== 'object' || !/^[a-f0-9-]{36}$/i.test(target.id) || !['private_group', 'team_group'].includes(target.purpose) || !/^wecom\.webhook\.[A-Za-z0-9._-]{1,120}$/.test(target.credentialRef)) throw new Error('企业微信通知目标快照无效');
  const targetSnapshot = {
    id: target.id,
    name: String(target.name).slice(0, 120),
    purpose: target.purpose,
    credentialRef: target.credentialRef,
    enabled: !!target.enabled,
    eventPolicy: {
      onCompleted: !!target.eventPolicy?.onCompleted,
      onFailed: !!target.eventPolicy?.onFailed,
      onError: !!target.eventPolicy?.onError,
      onCancelled: !!target.eventPolicy?.onCancelled,
      onInterrupted: !!target.eventPolicy?.onInterrupted,
    },
    ...(target.mentionedUserIds ? { mentionedUserIds: target.mentionedUserIds.map(value => String(value).slice(0, 128)).slice(0, 50) } : {}),
    ...(target.mentionedMobiles ? { mentionedMobiles: target.mentionedMobiles.map(value => String(value).slice(0, 20)).slice(0, 50) } : {}),
    ...(Array.isArray(target.workspaceIds) && target.workspaceIds.length ? { workspaceIds: target.workspaceIds.map(value => String(value).slice(0, 128)).slice(0, 50) } : {}),
    ...(Array.isArray(target.runtimeKinds) && target.runtimeKinds.length ? { runtimeKinds: target.runtimeKinds.filter(value => value === 'jinggong' || value === 'codex' || value === 'claude_agent_sdk').slice(0, 3) } : {}),
  };
  const value: WeComDeliveryRecord = {
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    kind: record.kind,
    status: record.status,
    targetId: targetSnapshot.id,
    targetName: String(record.targetName).slice(0, 120),
    targetSnapshot,
    content: String(record.content).replace(/https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[^\s&]+/gi, '[Webhook 已脱敏]').slice(0, 1800),
    attempts: Number.isInteger(record.attempts) ? Math.max(0, Math.min(3, record.attempts)) : 0,
    createdAt: String(record.createdAt).slice(0, 40),
    updatedAt: String(record.updatedAt).slice(0, 40),
  };
  if (record.eventId) value.eventId = String(record.eventId).slice(0, 120);
  if (record.platformSessionId) value.platformSessionId = String(record.platformSessionId).slice(0, 120);
  if (record.eventType) value.eventType = record.eventType;
  if (record.httpStatus !== undefined && Number.isInteger(record.httpStatus)) value.httpStatus = record.httpStatus;
  if (record.errcode !== undefined && Number.isInteger(record.errcode)) value.errcode = record.errcode;
  if (record.errorCode) value.errorCode = record.errorCode;
  if (record.errorSummary) value.errorSummary = String(record.errorSummary).replace(/https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[^\s&]+/gi, '[Webhook 已脱敏]').slice(0, 320);
  if (record.retryOfId) value.retryOfId = String(record.retryOfId).slice(0, 120);
  return value;
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
      if (bytes && version < SCHEMA_VERSION) atomicWrite(`${absolute}.pre-v${SCHEMA_VERSION}-from-v${version}-${Date.now()}-${randomUUID().slice(0, 8)}.bak`, bytes);
      const store = new LocalStore(db, sql, absolute);
      db.run('PRAGMA foreign_keys = ON');
      if (version === 0) {
        store.transaction(() => {
          db!.run(`
            CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
            CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), created_at TEXT NOT NULL, value TEXT NOT NULL);
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
      if (version <= 2) {
        store.transaction(() => {
          store.db.run(`
            CREATE TABLE wecom_targets (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE wecom_deliveries (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE INDEX wecom_deliveries_created ON wecom_deliveries(created_at DESC);
            PRAGMA user_version = 3;
          `);
        });
      }
      if (version <= 3) {
        store.transaction(() => {
          store.db.run(`
            CREATE TABLE workspaces (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA user_version = 4;
          `);
        });
      }
      if (version <= 4) {
        // SQLite 不能直接修改列的 NOT NULL 约束；同时重建 events 保留其外键和历史序号。
        // 迁移前暂时关闭外键检查，事务完成后立即恢复。
        db.run('PRAGMA foreign_keys = OFF');
        try {
          store.transaction(() => {
            store.db.run(`
              CREATE TABLE sessions_v5 (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), created_at TEXT NOT NULL, value TEXT NOT NULL);
              INSERT INTO sessions_v5(id, project_id, created_at, value) SELECT id, project_id, created_at, value FROM sessions;
              CREATE TABLE events_v5 (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL REFERENCES sessions_v5(id), value TEXT NOT NULL);
              INSERT INTO events_v5(seq, id, session_id, value) SELECT seq, id, session_id, value FROM events;
              DROP TABLE events;
              DROP TABLE sessions;
              ALTER TABLE sessions_v5 RENAME TO sessions;
              ALTER TABLE events_v5 RENAME TO events;
              CREATE INDEX events_session ON events(session_id, seq);
              PRAGMA user_version = 5;
            `);
          });
        } finally {
          store.db.run('PRAGMA foreign_keys = ON');
        }
      }
      if (version <= 5) {
        store.transaction(() => {
          store.db.run(`
            CREATE TABLE plugins (id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, trust_status TEXT NOT NULL, enabled INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE plugin_versions (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE, version TEXT NOT NULL, installed_at TEXT NOT NULL, is_active INTEGER NOT NULL, value TEXT NOT NULL);
            CREATE INDEX plugin_versions_plugin ON plugin_versions(plugin_id, installed_at DESC);
            CREATE UNIQUE INDEX plugin_versions_one_active ON plugin_versions(plugin_id) WHERE is_active = 1;
            CREATE TABLE plugin_skills (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE, name TEXT NOT NULL, enabled INTEGER NOT NULL, value TEXT NOT NULL);
            CREATE INDEX plugin_skills_plugin ON plugin_skills(plugin_id, name);
            CREATE TABLE plugin_mcp_servers (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE, server_name TEXT NOT NULL, transport TEXT NOT NULL, enabled INTEGER NOT NULL, health_status TEXT NOT NULL, value TEXT NOT NULL);
            CREATE INDEX plugin_mcp_servers_plugin ON plugin_mcp_servers(plugin_id, server_name);
            CREATE TABLE runtime_plugin_bindings (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE, runtime_kind TEXT NOT NULL, profile_id TEXT NOT NULL, install_state TEXT NOT NULL, value TEXT NOT NULL);
            CREATE UNIQUE INDEX runtime_plugin_binding_scope ON runtime_plugin_bindings(plugin_id, runtime_kind, profile_id);
            CREATE TABLE session_plugin_snapshots (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, profile_id TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE plugin_audit_logs (id TEXT PRIMARY KEY, action TEXT NOT NULL, plugin_id TEXT REFERENCES plugins(id) ON DELETE SET NULL, runtime_kind TEXT, result TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE INDEX plugin_audit_created ON plugin_audit_logs(created_at DESC);
            CREATE INDEX plugin_audit_plugin ON plugin_audit_logs(plugin_id, created_at DESC);
            PRAGMA user_version = 6;
          `);
        });
      }
      if (version <= 6) {
        store.transaction(() => {
          store.db.run(`
            CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, project_id TEXT REFERENCES projects(id), status TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE INDEX agent_tasks_session ON agent_tasks(session_id, created_at, id);
            PRAGMA user_version = 7;
          `);
        });
      }
      if (version <= 7) {
        store.transaction(() => {
          store.db.run(`
            CREATE TABLE agent_task_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, created_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE INDEX agent_task_events_task ON agent_task_events(task_id, seq);
            PRAGMA user_version = 8;
          `);
        });
      }
      if (version <= 8) {
        store.transaction(() => {
          store.db.run(`
            CREATE TABLE agent_task_contracts (task_id TEXT NOT NULL, session_id TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(task_id, version));
            CREATE INDEX agent_task_contracts_session ON agent_task_contracts(session_id, task_id, version);
            CREATE TABLE agent_task_lifecycle_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, session_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL, previous_hash TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE INDEX agent_task_lifecycle_task ON agent_task_lifecycle_events(session_id, task_id, seq);
            CREATE TABLE agent_task_evidence (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE INDEX agent_task_evidence_task ON agent_task_evidence(session_id, task_id, created_at);
            CREATE TABLE verification_executions (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT, record_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
            CREATE INDEX verification_executions_session ON verification_executions(session_id, created_at);
            PRAGMA user_version = 9;
          `);
        });
      }
      if (version <= 9) {
        store.transaction(() => {
          store.db.run(`
            CREATE TRIGGER agent_task_contracts_no_update BEFORE UPDATE ON agent_task_contracts BEGIN SELECT RAISE(ABORT, 'task contracts are append-only'); END;
            CREATE TRIGGER agent_task_contracts_no_delete BEFORE DELETE ON agent_task_contracts BEGIN SELECT RAISE(ABORT, 'task contracts are append-only'); END;
            CREATE TRIGGER agent_task_lifecycle_no_update BEFORE UPDATE ON agent_task_lifecycle_events BEGIN SELECT RAISE(ABORT, 'task lifecycle events are append-only'); END;
            CREATE TRIGGER agent_task_lifecycle_no_delete BEFORE DELETE ON agent_task_lifecycle_events BEGIN SELECT RAISE(ABORT, 'task lifecycle events are append-only'); END;
            CREATE TRIGGER agent_task_evidence_no_update BEFORE UPDATE ON agent_task_evidence BEGIN SELECT RAISE(ABORT, 'task evidence is append-only'); END;
            CREATE TRIGGER agent_task_evidence_no_delete BEFORE DELETE ON agent_task_evidence BEGIN SELECT RAISE(ABORT, 'task evidence is append-only'); END;
            CREATE TRIGGER verification_executions_no_update BEFORE UPDATE ON verification_executions BEGIN SELECT RAISE(ABORT, 'verification executions are append-only'); END;
            CREATE TRIGGER verification_executions_no_delete BEFORE DELETE ON verification_executions BEGIN SELECT RAISE(ABORT, 'verification executions are append-only'); END;
            PRAGMA user_version = 10;
          `);
        });
      }
      if (options.recoverUnfinished !== false) {
        const pendingTools = new Map(store.listAgentTasks().filter(task => task.contractVersion).map(task => [task.id, store.getTaskAuditSnapshot(task.sessionId, task.id).pendingToolCalls]));
        const unfinishedTasks = store.listAgentTasks().filter(task => task.status === 'RUNNING' || task.verificationStatus === 'RUNNING' || pendingTools.get(task.id)?.length);
        if (unfinishedTasks.length) store.transaction(() => {
          const sessions = new Set<string>();
          for (const task of unfinishedTasks) {
            let version = task.stateVersion ?? 0;
            for (const started of pendingTools.get(task.id) ?? []) {
              version += 1;
              store.appendTaskLifecycleEvent({ ...task, stateVersion: version }, 'tool.unknown_outcome', 'platform', { callId: started.payload.callId ?? started.payload.toolCallId ?? started.correlationId, toolName: started.payload.toolName ?? started.payload.tool, startedEventId: started.id, startedContractVersion: started.payload.contractVersion, outcome: 'unknown_outcome', reason: '应用退出时工具尚无确定结果，未自动重放。' }, started.correlationId);
            }
            const recovered: AgentTask = { ...task, stateVersion: version + 1, updatedAt: new Date().toISOString() };
            if (task.status === 'RUNNING' || pendingTools.get(task.id)?.length) {
              recovered.status = 'BLOCKED'; recovered.executionStatus = 'INTERRUPTED';
              recovered.error = '应用上次退出时任务仍在运行，未自动重放。';
              recovered.completedAt = undefined;
            }
            if (task.verificationStatus === 'RUNNING' || pendingTools.get(task.id)?.length && task.verificationStatus === 'PASSED') { recovered.verificationStatus = 'INCONCLUSIVE'; recovered.verificationReason = '应用退出，验证或工具结果未确定。'; }
            if (pendingTools.get(task.id)?.length && task.acceptanceStatus === 'ACCEPTED') { recovered.acceptanceStatus = 'PENDING_REVIEW'; recovered.acceptance = undefined; }
            store.writeAgentTask(recovered);
            store.appendTaskLifecycleEvent(recovered, 'task.interrupted', 'platform', { executionStatus: recovered.executionStatus, verificationStatus: recovered.verificationStatus, reason: recovered.error ?? recovered.verificationReason });
            sessions.add(task.sessionId);
          }
          for (const sessionId of sessions) for (const task of reconcileTaskStates(store.listAgentTasks(sessionId))) {
            const current = store.listAgentTasks(sessionId).find(item => item.id === task.id)!;
            if (current.status !== task.status) {
              const next = { ...task, stateVersion: (current.stateVersion ?? 0) + 1 };
              store.writeAgentTask(next);
              store.appendTaskLifecycleEvent(next, 'execution.reconciled', 'platform', { from: executionStatusOf(current), to: executionStatusOf(next) });
            }
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

  listAgentTasks(sessionId?: string): AgentTask[] {
    return sessionId === undefined
      ? this.rows<AgentTask>('SELECT value FROM agent_tasks ORDER BY created_at, id')
      : this.rows<AgentTask>('SELECT value FROM agent_tasks WHERE session_id = ? ORDER BY created_at, id', [sessionId]);
  }

  private writeAgentTask(task: AgentTask): void {
    this.db.run(`INSERT INTO agent_tasks(id, session_id, project_id, status, created_at, value)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, status = excluded.status, value = excluded.value`,
      [task.id, task.sessionId, task.projectId ?? null, task.status, task.createdAt, JSON.stringify(task)]);
  }

  private appendTaskLifecycleEvent(task: AgentTask, eventType: string, actor: string, inputPayload: Record<string, unknown>, correlationId: string = randomUUID()): TaskLifecycleEvent {
    const payload = { ...inputPayload, ...(task.contractVersion ? { contractVersion: task.contractVersion } : {}) };
    assertTaskSafeMetadata(payload);
    const previous = this.rows<TaskLifecycleEvent>('SELECT value FROM agent_task_lifecycle_events WHERE session_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1', [task.sessionId, task.id])[0];
    const unsigned = { id: randomUUID(), taskId: task.id, sessionId: task.sessionId, projectId: task.projectId, runtimeKind: task.runtimeKind,
      eventType, aggregateVersion: task.stateVersion ?? 0, actor, createdAt: new Date().toISOString(), correlationId, payload,
      previousHash: previous?.contentHash ?? EMPTY_TASK_EVENT_HASH };
    const event: TaskLifecycleEvent = { ...unsigned, contentHash: taskContentHash(unsigned) };
    this.db.run('INSERT INTO agent_task_lifecycle_events(id, task_id, session_id, aggregate_version, previous_hash, content_hash, created_at, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [event.id, event.taskId, event.sessionId, event.aggregateVersion, event.previousHash, event.contentHash, event.createdAt, JSON.stringify(event)]);
    return event;
  }

  getAgentTaskContractVersions(sessionId: string, taskId: string): TaskContractRecord[] {
    return this.rows<TaskContractRecord>('SELECT value FROM agent_task_contracts WHERE session_id = ? AND task_id = ? ORDER BY version', [sessionId, taskId]);
  }

  listTaskLifecycleEvents(sessionId: string, taskId: string): TaskLifecycleEvent[] {
    const events = this.rows<TaskLifecycleEvent>('SELECT value FROM agent_task_lifecycle_events WHERE session_id = ? AND task_id = ? ORDER BY seq', [sessionId, taskId]);
    if (!verifyTaskLifecycleEventChain(events)) throw new Error('任务生命周期审计链校验失败，请保留数据库并检查备份');
    return events;
  }

  listTaskEvidence(sessionId: string, taskId: string): TaskEvidenceRecord[] {
    return this.rows<TaskEvidenceRecord>('SELECT value FROM agent_task_evidence WHERE session_id = ? AND task_id = ? ORDER BY created_at, id', [sessionId, taskId]);
  }

  getTaskAuditSnapshot(sessionId: string, taskId: string): TaskAuditSnapshot {
    const task = this.listAgentTasks(sessionId).find(item => item.id === taskId);
    if (!task?.contractVersion) throw new Error('审计快照需要已有任务契约');
    const events = this.listTaskLifecycleEvents(sessionId, taskId);
    const toolEvents = events.filter(event => event.eventType.startsWith('tool.'));
    const pending = new Map<string, TaskLifecycleEvent>();
    const final = new Set(['tool.completed', 'tool.succeeded', 'tool.failed', 'tool.denied', 'tool.cancelled', 'tool.unknown_outcome']);
    for (const event of toolEvents) {
      const key = String(event.payload.callId ?? event.payload.toolCallId ?? event.correlationId);
      if (event.eventType === 'tool.started') pending.set(key, event);
      else if (final.has(event.eventType)) pending.delete(key);
    }
    const active = events.filter(event => event.payload.contractVersion === task.contractVersion);
    return { taskId, sessionId, contractVersion: task.contractVersion, stateVersion: task.stateVersion ?? 0, events, toolEvents, pendingToolCalls: [...pending.values()], approvals: active.filter(event => event.eventType.startsWith('approval.')), budgetEvents: events.filter(event => event.eventType.startsWith('budget.') || event.eventType.startsWith('model.')) };
  }

  appendTaskAuditEvent(sessionId: string, taskId: string, input: TaskAuditAppend): TaskLifecycleEvent {
    const task = this.listAgentTasks(sessionId).find(item => item.id === taskId);
    if (!task?.contractVersion) throw new Error('追加工程审计需要已有任务契约');
    if (!input || !/^(?:tool|approval|budget|model|runtime|context|governance|workspace)\.[a-z][a-z0-9_]{0,63}$/.test(input.eventType) || typeof input.actor !== 'string' || !input.actor.trim() || input.actor.length > 128 || /[\x00-\x1f\x7f]/.test(input.actor) || !input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('工程审计元数据无效');
    const correlationId = input.correlationId ?? String(input.payload.callId ?? input.payload.toolCallId ?? randomUUID());
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(correlationId) || input.payload.contractVersion !== undefined && input.payload.contractVersion !== task.contractVersion) throw new Error('审计关联标识或契约版本无效');
    if (input.eventType.startsWith('tool.')) {
      const allowed = new Set(['callId', 'toolCallId', 'toolName', 'tool', 'argumentsHash', 'argsHash', 'resultHash', 'idempotencyKeyHash', 'outcome', 'reason', 'reasonCode', 'status', 'durationMs', 'exitCode', 'approvalId', 'budgetReservationId', 'contractVersion', 'startedEventId', 'startedContractVersion', 'effect', 'requestId']);
      if (Object.entries(input.payload).some(([key, value]) => !allowed.has(key) || value !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof value) || typeof value === 'string' && value.length > 4000)) throw new Error('工具审计只能写摘要与Hash，不能持久化原始参数或结果');
      for (const key of ['argumentsHash', 'argsHash', 'resultHash', 'idempotencyKeyHash']) if (input.payload[key] !== undefined && !/^[a-f0-9]{64}$/i.test(String(input.payload[key]))) throw new Error('工具审计 Hash 无效');
      if (input.eventType === 'tool.started' && (typeof (input.payload.toolName ?? input.payload.tool) !== 'string' || !String(input.payload.toolName ?? input.payload.tool).trim() || !/^[a-f0-9]{64}$/i.test(String(input.payload.argumentsHash ?? input.payload.argsHash ?? '')))) throw new Error('工具开始审计必须包含工具名称和参数Hash');
      if (input.eventType === 'tool.started' && this.getTaskAuditSnapshot(sessionId, taskId).toolEvents.some(event => event.eventType === 'tool.started' && String(event.payload.callId ?? event.payload.toolCallId ?? event.correlationId) === String(input.payload.callId ?? input.payload.toolCallId ?? correlationId))) throw new Error('工具调用标识已经开始执行，不能重复登记或重放');
    }
    assertTaskSafeMetadata(input);
    const next = { ...task, stateVersion: (task.stateVersion ?? 0) + 1, updatedAt: new Date().toISOString() };
    let event: TaskLifecycleEvent | undefined;
    this.transaction(() => {
      this.writeAgentTask(next);
      event = this.appendTaskLifecycleEvent(next, input.eventType, input.actor, input.payload, correlationId);
    });
    return event!;
  }

  registerVerificationExecution(record: VerificationExecutionRecord): VerificationExecutionRecord {
    const session = this.getSession(record.sessionId);
    if (!session || session.projectId !== record.projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(record.runId) || !/^[a-f0-9]{64}$/i.test(record.recordHash) || !/^[a-f0-9]{64}$/i.test(record.manifestHash) || Number.isNaN(Date.parse(record.createdAt))) throw new Error('真实验证执行索引无效或会话项目不一致');
    assertTaskSafeMetadata(record);
    const existing = this.rows<VerificationExecutionRecord>('SELECT value FROM verification_executions WHERE run_id = ?', [record.runId])[0];
    if (existing) {
      if (taskContentHash(existing) !== taskContentHash(record)) throw new Error('验证执行索引已登记且内容不同，不能覆盖');
      return existing;
    }
    const value = JSON.parse(JSON.stringify(record)) as VerificationExecutionRecord;
    this.transaction(() => this.db.run('INSERT INTO verification_executions(run_id, session_id, project_id, record_hash, manifest_hash, created_at, value) VALUES (?, ?, ?, ?, ?, ?, ?)', [value.runId, value.sessionId, value.projectId ?? null, value.recordHash, value.manifestHash, value.createdAt, JSON.stringify(value)]));
    return value;
  }

  getVerificationExecution(sessionId: string, runId: string): VerificationExecutionRecord | undefined {
    return this.rows<VerificationExecutionRecord>('SELECT value FROM verification_executions WHERE session_id = ? AND run_id = ?', [sessionId, runId])[0];
  }

  saveAgentTaskContract(task: AgentTask, contractInput: TaskContract, expectedContractVersion: number, actor: string): TaskContractRecord {
    const contract = validateTaskContract(contractInput);
    const session = this.getSession(task.sessionId);
    const current = this.listAgentTasks().find(item => item.id === task.id);
    const versions = this.getAgentTaskContractVersions(task.sessionId, task.id);
    const latest = versions.at(-1);
    if (!current && this.rows<TaskLifecycleEvent>('SELECT value FROM agent_task_lifecycle_events WHERE task_id = ? LIMIT 1', [task.id]).length) throw new Error('历史任务 ID 不可重用，请创建新任务');
    if (!session || task.projectId !== session.projectId || current && current.sessionId !== task.sessionId) throw new Error('任务契约必须绑定当前会话和项目');
    if (!Number.isSafeInteger(expectedContractVersion) || expectedContractVersion < 0 || (latest?.version ?? 0) !== expectedContractVersion || contract.contractVersion !== expectedContractVersion + 1) throw new Error('任务契约版本已变化，请刷新后重试');
    if (typeof actor !== 'string' || !actor.trim() || actor.length > 128 || contract.createdBy !== actor) throw new Error('契约创建者必须与操作者一致');
    if (contract.taskId !== task.id || contract.sessionId !== task.sessionId || contract.projectId !== task.projectId || contract.runtimeKind !== (task.runtimeKind ?? 'codex') || contract.parentTaskId !== task.parentTaskId || contract.title !== task.name || contract.description !== task.description) throw new Error('任务契约与任务快照不一致');
    if (taskContentHash(contract.dependencies.map(item => item.taskId).sort()) !== taskContentHash([...task.dependencyIds].sort())) throw new Error('契约依赖与任务图不一致');
    if ((contract.workspacePolicy === 'isolated_worktree') !== (task.workspaceMode === 'worktree')) throw new Error('任务契约与工作区模式不一致');
    if (executionStatusOf(current ?? task) === 'RUNNING') throw new Error('运行中的任务不能修改契约');
    if (current && (task.stateVersion ?? 0) !== (current.stateVersion ?? 0)) throw new Error('任务状态版本已变化，请刷新后重试');
    const executionStatus = executionStatusOf(current ?? task);
    const next: AgentTask = { ...(current ?? task), name: task.name, description: task.description, dependencyIds: [...task.dependencyIds], contractVersion: contract.contractVersion,
      executionStatus, status: legacyTaskStatus(executionStatus), verificationStatus: 'NOT_STARTED', acceptanceStatus: 'NOT_SUBMITTED', evidenceIds: [], acceptance: undefined,
      verificationReason: undefined, acceptanceReason: undefined, stateVersion: (current?.stateVersion ?? 0) + 1, updatedAt: new Date().toISOString(),
      dependencyConditions: Object.fromEntries(contract.dependencies.map(item => [item.taskId, item.condition])),
      maxAttempts: contract.budgetPolicy.maxRetriesPerTask + 1, timeoutMs: contract.budgetPolicy.maxRuntimeMinutes * 60000 };
    const graph = this.listAgentTasks(task.sessionId).filter(item => item.id !== task.id).concat(next);
    assertTaskGraph(graph);
    const record: TaskContractRecord = { taskId: task.id, sessionId: task.sessionId, version: contract.contractVersion, contract, contentHash: taskContentHash(contract), createdBy: actor, createdAt: contract.createdAt };
    this.transaction(() => {
      this.writeAgentTask(next);
      this.db.run('INSERT INTO agent_task_contracts(task_id, session_id, version, content_hash, created_at, value) VALUES (?, ?, ?, ?, ?, ?)', [record.taskId, record.sessionId, record.version, record.contentHash, record.createdAt, JSON.stringify(record)]);
      this.appendTaskLifecycleEvent(next, latest ? 'contract.revised' : 'contract.created', actor, { contractVersion: record.version, contractHash: record.contentHash, previousContractHash: latest?.contentHash });
    });
    return record;
  }

  transitionTaskLifecycle(input: TaskLifecycleTransition): AgentTask {
    const current = this.listAgentTasks(input.sessionId).find(item => item.id === input.taskId);
    if (!current) throw new Error('子 Agent 任务不存在');
    const next = applyTaskLifecycleTransition(current, input, this.listTaskEvidence(input.sessionId, input.taskId));
    if (input.dimension === 'execution' && ['READY', 'RUNNING'].includes(input.to) && !taskDependenciesSatisfied(next, this.listAgentTasks(input.sessionId))) throw new Error('任务的完成、验证或验收依赖尚未满足');
    this.transaction(() => {
      this.writeAgentTask(next);
      this.appendTaskLifecycleEvent(next, `${input.dimension}.${input.to.toLowerCase()}`, input.actor, { from: input.dimension === 'execution' ? executionStatusOf(current) : input.dimension === 'verification' ? current.verificationStatus : current.acceptanceStatus, to: input.to, reason: input.reason, evidenceIds: input.evidenceIds, acceptance: input.acceptance });
    });
    return next;
  }

  appendTaskEvidence(sessionId: string, taskId: string, recordInput: TaskEvidenceRecord): TaskEvidenceRecord {
    const task = this.listAgentTasks(sessionId).find(item => item.id === taskId);
    const record = validateTaskEvidence({ ...recordInput, contractVersion: recordInput.contractVersion ?? task?.contractVersion });
    if (!task?.contractVersion || record.sessionId !== sessionId || record.taskId !== taskId || record.projectId !== task.projectId) throw new Error('证据必须绑定已有契约的当前任务、会话和项目');
    if (record.contractVersion !== task.contractVersion) throw new Error('证据契约版本已变化，请重新验证当前契约');
    const existing = this.rows<TaskEvidenceRecord>('SELECT value FROM agent_task_evidence WHERE id = ?', [record.id])[0];
    if (existing) {
      if (taskContentHash(existing) !== taskContentHash(record)) throw new Error('证据 ID 已存在且内容不一致，不能覆盖');
      return existing;
    }
    const next: AgentTask = { ...task, stateVersion: (task.stateVersion ?? 0) + 1, updatedAt: new Date().toISOString() };
    this.transaction(() => {
      this.db.run('INSERT INTO agent_task_evidence(id, task_id, session_id, content_hash, created_at, value) VALUES (?, ?, ?, ?, ?, ?)', [record.id, taskId, sessionId, taskContentHash(record), record.createdAt, JSON.stringify(record)]);
      this.writeAgentTask(next);
      this.appendTaskLifecycleEvent(next, 'evidence.collected', 'platform', { evidenceId: record.id, contentHash: record.contentHash, evidenceType: record.evidenceType, source: record.source, status: record.status });
    });
    return record;
  }

  bindTaskWorkspace(sessionId: string, taskId: string, expectedStateVersion: number, workspacePath: string, mapping: Record<string, unknown>): AgentTask {
    const task = this.listAgentTasks(sessionId).find(item => item.id === taskId);
    const contract = this.getAgentTaskContractVersions(sessionId, taskId).at(-1)?.contract;
    if (!task?.contractVersion || task.workspaceMode !== 'worktree' || !contract || contract.contractVersion !== task.contractVersion || contract.workspacePolicy !== 'isolated_worktree') throw new Error('工作区只能绑定已有隔离开发契约的任务');
    if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath) || workspacePath.length > 4000 || workspacePath.includes('\0') || !mapping || typeof mapping !== 'object' || Array.isArray(mapping) || mapping.taskId !== taskId || mapping.sessionId !== sessionId || mapping.projectId !== task.projectId || mapping.path !== workspacePath) throw new Error('工作区映射必须与当前任务、会话、项目和绝对路径一致');
    assertTaskSafeMetadata(mapping);
    if (executionStatusOf(task) === 'RUNNING') throw new Error('运行中的任务不能重新绑定工作区');
    if (task.workspacePath && task.workspacePath !== workspacePath) throw new Error('任务已经绑定其他工作区，不能覆盖');
    const existing = this.listTaskLifecycleEvents(sessionId, taskId).find(event => event.eventType === 'workspace.created')?.payload.workspace;
    if (existing !== undefined) {
      if (taskContentHash(existing) !== taskContentHash(mapping) || task.workspacePath !== workspacePath) throw new Error('任务已有不可变工作区映射，不能覆盖');
      return task;
    }
    if (!Number.isSafeInteger(expectedStateVersion) || (task.stateVersion ?? 0) !== expectedStateVersion) throw new Error('任务状态版本已变化，请刷新后重试');
    const next: AgentTask = { ...task, workspacePath, stateVersion: (task.stateVersion ?? 0) + 1, updatedAt: new Date().toISOString() };
    this.transaction(() => {
      this.writeAgentTask(next);
      this.appendTaskLifecycleEvent(next, 'workspace.created', 'platform', { workspace: mapping });
    });
    return next;
  }

  finalizeTaskVerification(input: TaskLifecycleTransition): AgentTask {
    if (input.dimension !== 'verification' || !['PASSED', 'FAILED', 'PARTIAL', 'INCONCLUSIVE'].includes(input.to)) throw new Error('验证完成接口只接受真实验证终态');
    const current = this.listAgentTasks(input.sessionId).find(task => task.id === input.taskId);
    if (!current || (current.stateVersion ?? 0) !== input.expectedStateVersion) throw new Error('任务状态版本已变化，请刷新后重试');
    const evidence = this.listTaskEvidence(input.sessionId, input.taskId);
    const running = current.verificationStatus === 'RUNNING' ? current : applyTaskLifecycleTransition(current, { ...input, to: 'RUNNING', evidenceIds: undefined, reason: '平台开始复核真实验证证据' }, evidence);
    const completed = applyTaskLifecycleTransition(running, { ...input, expectedStateVersion: running.stateVersion ?? 0 }, evidence);
    this.transaction(() => {
      this.writeAgentTask(completed);
      if (running !== current) this.appendTaskLifecycleEvent(running, 'verification.running', input.actor, { from: current.verificationStatus ?? 'NOT_STARTED', to: 'RUNNING', reason: '平台开始复核真实验证证据' });
      this.appendTaskLifecycleEvent(completed, `verification.${input.to.toLowerCase()}`, input.actor, { from: 'RUNNING', to: input.to, evidenceIds: completed.evidenceIds, reason: input.reason });
    });
    return completed;
  }

  saveAgentTasksForSession(sessionId: string, tasks: AgentTask[]): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('子 Agent 任务绑定的会话不存在');
    if (tasks.length > 100) throw new Error('单会话最多保存 100 个子 Agent 任务');
    const ids = new Set<string>();
    for (const task of tasks) {
      if (!task || task.sessionId !== sessionId || task.projectId !== session.projectId) throw new Error('子 Agent 任务必须绑定当前会话和项目');
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(task.id) || ids.has(task.id)) throw new Error('子 Agent 任务 ID 无效或重复');
      ids.add(task.id);
      if (!['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'WAITING', 'BLOCKED'].includes(task.status)) throw new Error('子 Agent 任务状态无效');
      if (!Array.isArray(task.dependencyIds) || task.dependencyIds.length > 100 || !task.dependencyIds.every(id => typeof id === 'string' && id !== task.id)) throw new Error('子 Agent 任务依赖无效');
    }
    assertTaskGraph(tasks);
    this.transaction(() => {
      const current = this.listAgentTasks(sessionId);
      const nextIds = new Set(tasks.map(task => task.id));
      for (const task of tasks) {
        const previous = current.find(item => item.id === task.id);
        const bound = this.listAgentTasks().find(item => item.id === task.id);
        if (bound && bound.sessionId !== sessionId) throw new Error('任务 ID 已绑定其他会话');
        if (!bound && this.rows<TaskLifecycleEvent>('SELECT value FROM agent_task_lifecycle_events WHERE task_id = ? LIMIT 1', [task.id]).length) throw new Error('历史任务 ID 不可重用，请创建新任务');
        if (task.contractVersion && !previous?.contractVersion) throw new Error('请通过任务契约接口创建工程任务');
        if (!previous?.contractVersion && (task.verificationStatus && task.verificationStatus !== 'NOT_STARTED' || task.acceptanceStatus && task.acceptanceStatus !== 'NOT_SUBMITTED' || task.evidenceIds?.length || task.acceptance)) throw new Error('历史任务没有任务契约，不能补造验证或验收结果');
        if (previous?.contractVersion) {
          const protectedKeys = ['contractVersion', 'verificationStatus', 'acceptanceStatus', 'evidenceIds', 'acceptance', 'verificationReason', 'acceptanceReason', 'dependencyConditions', 'name', 'description', 'input', 'model', 'parentTaskId', 'dependencyIds', 'runtimeKind', 'workspaceMode', 'workspacePath', 'maxAttempts', 'timeoutMs'] as const;
          for (const key of protectedKeys) if (taskContentHash({ value: task[key] }) !== taskContentHash({ value: previous[key] })) throw new Error(`工程任务 ${key} 必须通过契约或状态接口修改`);
          if ((task.stateVersion ?? 0) !== (previous.stateVersion ?? 0)) throw new Error('任务状态版本已变化，请刷新后重试');
          if (task.status !== legacyTaskStatus(executionStatusOf(task))) throw new Error('任务兼容状态与执行状态不一致');
          if (executionStatusOf(task) !== executionStatusOf(previous)) {
            const next = applyTaskLifecycleTransition(previous, { sessionId, taskId: task.id, dimension: 'execution', to: executionStatusOf(task), expectedStateVersion: previous.stateVersion ?? 0, actor: 'platform', reason: task.error }, this.listTaskEvidence(sessionId, task.id));
            if (['READY', 'RUNNING'].includes(next.executionStatus!) && !taskDependenciesSatisfied(next, tasks)) throw new Error('任务的完成、验证或验收依赖尚未满足');
            this.writeAgentTask({ ...task, ...next, result: task.result, workspacePath: task.workspacePath });
            this.appendTaskLifecycleEvent(next, `execution.${next.executionStatus!.toLowerCase()}`, 'platform', { from: executionStatusOf(previous), to: next.executionStatus, reason: task.error });
          } else {
            if (task.attempt !== previous.attempt) throw new Error('任务尝试次数只能随执行状态迁移变更');
            this.writeAgentTask(task);
          }
        } else this.writeAgentTask(task);
      }
      for (const task of current) if (!nextIds.has(task.id)) this.db.run('DELETE FROM agent_tasks WHERE id = ? AND session_id = ?', [task.id, sessionId]);
    });
  }

  listAgentTaskEvents(sessionId: string, taskId: string): AgentTaskEvent[] {
    if (!this.listAgentTasks(sessionId).some(task => task.id === taskId)) throw new Error('子 Agent 任务不存在');
    return this.rows<AgentTaskEvent>('SELECT value FROM agent_task_events WHERE session_id = ? AND task_id = ? ORDER BY seq', [sessionId, taskId]);
  }

  appendAgentTaskEvent(event: AgentTaskEvent): void {
    if (!this.listAgentTasks(event.sessionId).some(task => task.id === event.taskId)) throw new Error('子 Agent 任务不存在');
    if (!event.id || !event.sessionId || !event.taskId || !['user', 'delta', 'message', 'tool', 'status', 'error', 'approval'].includes(event.type) || typeof event.text !== 'string' || event.text.length > 32000 || Number.isNaN(Date.parse(event.createdAt))) throw new Error('子 Agent 事件无效');
    this.transaction(() => {
      this.db.run('INSERT INTO agent_task_events(id, task_id, session_id, created_at, value) VALUES (?, ?, ?, ?, ?)', [event.id, event.taskId, event.sessionId, event.createdAt, JSON.stringify(event)]);
      this.db.run('DELETE FROM agent_task_events WHERE task_id = ? AND seq NOT IN (SELECT seq FROM agent_task_events WHERE task_id = ? ORDER BY seq DESC LIMIT 5000)', [event.taskId, event.taskId]);
    });
  }

  getSession(id: string): Session | undefined { return this.rows<Session>('SELECT value FROM sessions WHERE id = ?', [id])[0]; }

  saveSession(session: Session): void {
    const current = this.getSession(session.id);
    if (current && current.projectId !== session.projectId && this.listAgentTasks(session.id).length) throw new Error('会话已有子 Agent 任务，不能更改项目绑定');
    const nextRuntime = session.runtimeKind ?? current?.runtimeKind ?? 'codex';
    if (nextRuntime !== 'jinggong' && nextRuntime !== 'codex' && nextRuntime !== 'claude_agent_sdk') throw new Error('会话 Runtime 类型无效');
    const value: Session = { id: session.id, projectId: session.projectId, title: session.title, workspacePath: session.workspacePath, branch: session.branch, status: session.status, createdAt: session.createdAt, model: session.model };
    if (session.workspaceId !== undefined) {
      if (!this.getWorkspace(session.workspaceId)) throw new Error('会话关联的工作区不存在');
      value.workspaceId = session.workspaceId;
    }
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
    if (session.runtimeNativeSessionId !== undefined) value.runtimeNativeSessionId = session.runtimeNativeSessionId;
    if (session.runtimeCapabilitiesVersion !== undefined) value.runtimeCapabilitiesVersion = session.runtimeCapabilitiesVersion;
    value.runtimeKind = nextRuntime;
    if (session.runtimeVersion !== undefined) value.runtimeVersion = session.runtimeVersion;
    if (session.providerId !== undefined) value.providerId = session.providerId;
    if (session.mode !== undefined) value.mode = session.mode;
    if (session.system !== undefined) value.system = session.system;
    if (session.jiraProjectKey !== undefined) value.jiraProjectKey = session.jiraProjectKey;
    if (session.jiraIssue !== undefined) value.jiraIssue = jiraSnapshot(session.jiraIssue);
    if (session.requirementAdmission !== undefined) value.requirementAdmission = session.requirementAdmission;
    if (session.requirementAdmissionHistory !== undefined) value.requirementAdmissionHistory = session.requirementAdmissionHistory;
    if (session.unreadCompletionId !== undefined) value.unreadCompletionId = session.unreadCompletionId;
    if (session.imported) value.imported = true;
    this.transaction(() => this.db.run('INSERT INTO sessions(id, project_id, created_at, value) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, created_at=excluded.created_at, value=excluded.value', [value.id, value.projectId ?? null, value.createdAt, JSON.stringify(value)]));
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
    this.transaction(() => { this.db.run('DELETE FROM events WHERE session_id = ?', [id]); this.db.run('DELETE FROM agent_tasks WHERE session_id = ?', [id]); this.db.run('DELETE FROM sessions WHERE id = ?', [id]); });
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
      if (session) this.db.run('INSERT INTO sessions(id,project_id,created_at,value) VALUES (?,?,?,?)', [session.id, session.projectId ?? null, session.createdAt, JSON.stringify(session)]);
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

  /** 全局默认仅影响新建会话；缺失配置按 Codex 迁移并持久化。 */
  getRuntimeKind(): RuntimeKind {
    const value = this.rows<{ kind?: unknown }>('SELECT value FROM settings WHERE key = ?', ['runtime-kind'])[0];
    if (value?.kind === 'jinggong' || value?.kind === 'codex' || value?.kind === 'claude_agent_sdk') return value.kind;
    this.saveRuntimeKind('codex');
    return 'codex';
  }

  saveRuntimeKind(kind: RuntimeKind): RuntimeKind {
    if (kind !== 'jinggong' && kind !== 'codex' && kind !== 'claude_agent_sdk') throw new Error('Runtime 类型无效');
    this.transaction(() => this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['runtime-kind', JSON.stringify({ kind })]));
    return kind;
  }

  /** Claude 的模型和可选兼容 Base URL 仅保存为元数据；API Key 不进入 SQLite。 */
  getClaudeRuntime(): Pick<ClaudeRuntimeSettings, 'model' | 'baseUrl'> {
    const value = this.rows<Partial<ClaudeRuntimeSettings>>('SELECT value FROM settings WHERE key = ?', ['claude-runtime'])[0];
    return {
      ...(typeof value?.model === 'string' && value.model.trim() ? { model: value.model.trim() } : {}),
      ...(typeof value?.baseUrl === 'string' && value.baseUrl.trim() ? { baseUrl: value.baseUrl.trim() } : {}),
    };
  }

  saveClaudeRuntime(value: Pick<ClaudeRuntimeSettings, 'model' | 'baseUrl'>): void {
    const metadata: Pick<ClaudeRuntimeSettings, 'model' | 'baseUrl'> = { ...(value.model ? { model: value.model.trim() } : {}), ...(value.baseUrl ? { baseUrl: value.baseUrl.trim() } : {}) };
    this.transaction(() => this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['claude-runtime', JSON.stringify(metadata)]));
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
    const catalog = provider.modelCatalog
      ?.filter(item => provider.models.includes(item.id))
      .map(item => ({ id: item.id, name: item.name }));
    const value: ProviderProfile = {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: [...provider.models],
      ...(catalog?.length ? { modelCatalog: catalog } : {}),
      hasKey: provider.hasKey,
    };
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

  listWeComTargets<T>(): T[] { return this.rows<T>('SELECT value FROM wecom_targets ORDER BY rowid'); }

  saveWeComTarget<T extends { id: string }>(target: T): void {
    if (!target || typeof target.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(target.id)) throw new Error('企业微信目标标识无效');
    // 仅接受安全配置元数据，防止调用方意外把 webhookUrl 写进 SQLite。
    const value = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
    if ('webhookUrl' in value || 'webhook' in value || 'secret' in value || 'apiKey' in value) throw new Error('企业微信凭据不能写入 SQLite');
    this.transaction(() => this.db.run('INSERT INTO wecom_targets(id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', [target.id, JSON.stringify(value)]));
  }

  deleteWeComTarget(id: string): void { this.transaction(() => this.db.run('DELETE FROM wecom_targets WHERE id = ?', [id])); }

  listWeComDeliveries(limit = 100): WeComDeliveryRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('企业微信历史条数无效');
    return this.rows<WeComDeliveryRecord>('SELECT value FROM wecom_deliveries ORDER BY created_at DESC, rowid DESC LIMIT ?', [limit]);
  }

  listWeComDeliveriesByStatus(status: WeComDeliveryStatus): WeComDeliveryRecord[] {
    if (!['sending', 'sent', 'failed'].includes(status)) throw new Error('企业微信通知状态无效');
    return this.rows<WeComDeliveryRecord>('SELECT value FROM wecom_deliveries WHERE status = ? ORDER BY created_at ASC, rowid ASC', [status]);
  }

  /** 删除超出保留期限的已完成记录；发送中的记录由启动恢复流程单独处理。 */
  deleteWeComDeliveriesBefore(cutoffIso: string): number {
    if (typeof cutoffIso !== 'string' || Number.isNaN(Date.parse(cutoffIso))) throw new Error('企业微信历史清理时间无效');
    let deleted = 0;
    this.transaction(() => {
      this.db.run("DELETE FROM wecom_deliveries WHERE created_at < ? AND status <> 'sending'", [cutoffIso]);
      deleted = this.db.getRowsModified();
    });
    return deleted;
  }

  cleanupWeComDeliveries(retentionDays = 90, now = new Date()): number {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650 || !(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('企业微信历史保留期限无效');
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.deleteWeComDeliveriesBefore(cutoff);
  }

  findWeComDeliveryByIdempotencyKey(key: string): WeComDeliveryRecord | undefined {
    return this.rows<WeComDeliveryRecord>('SELECT value FROM wecom_deliveries WHERE idempotency_key = ?', [key])[0];
  }

  findWeComDeliveryById(id: string): WeComDeliveryRecord | undefined {
    return this.rows<WeComDeliveryRecord>('SELECT value FROM wecom_deliveries WHERE id = ?', [id])[0];
  }

  insertWeComDeliveryIfAbsent(record: WeComDeliveryRecord): boolean {
    const safe = safeWeComDeliveryRecord(record);
    let inserted = false;
    this.transaction(() => {
      this.db.run('INSERT OR IGNORE INTO wecom_deliveries(id, idempotency_key, status, created_at, value) VALUES (?, ?, ?, ?, ?)', [safe.id, safe.idempotencyKey, safe.status, safe.createdAt, JSON.stringify(safe)]);
      inserted = this.db.getRowsModified() === 1;
    });
    return inserted;
  }

  saveWeComDelivery(record: WeComDeliveryRecord): void {
    const safe = safeWeComDeliveryRecord(record);
    this.transaction(() => this.db.run('INSERT INTO wecom_deliveries(id, idempotency_key, status, created_at, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, value=excluded.value', [safe.id, safe.idempotencyKey, safe.status, safe.createdAt, JSON.stringify(safe)]));
  }

  listWorkspaces<T>(): T[] { return this.rows<T>('SELECT value FROM workspaces ORDER BY rowid'); }

  getWorkspace<T>(id: string): T | undefined {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Workspace 标识无效');
    return this.rows<T>('SELECT value FROM workspaces WHERE id = ?', [id])[0];
  }

  saveWorkspace<T extends { id: string }>(workspace: T): void {
    if (!workspace || typeof workspace.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(workspace.id)) throw new Error('Workspace 标识无效');
    const value = JSON.stringify(workspace);
    if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw new Error('Workspace 本地元数据不能超过 1 MiB');
    this.transaction(() => this.db.run('INSERT INTO workspaces(id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', [workspace.id, value]));
  }

  deleteWorkspace(id: string): void {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Workspace 标识无效');
    const sessions = this.listSessions().filter(session => session.workspaceId === id);
    this.transaction(() => {
      for (const session of sessions) {
        const detached = { ...session };
        delete detached.workspaceId;
        this.db.run('UPDATE sessions SET value = ? WHERE id = ?', [JSON.stringify(detached), detached.id]);
      }
      this.db.run('DELETE FROM workspaces WHERE id = ?', [id]);
    });
  }

  listPlugins(): PluginRecord[] { return this.rows<PluginRecord>('SELECT value FROM plugins ORDER BY updated_at DESC, rowid DESC'); }

  getPlugin(id: string): PluginRecord | undefined {
    return this.rows<PluginRecord>('SELECT value FROM plugins WHERE id = ?', [pluginId(id, '插件')])[0];
  }

  savePlugin(record: PluginRecord): void {
    const value = safePluginRecord(record);
    this.transaction(() => this.db.run('INSERT INTO plugins(id, name, version, status, trust_status, enabled, content_hash, created_at, updated_at, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, status=excluded.status, trust_status=excluded.trust_status, enabled=excluded.enabled, content_hash=excluded.content_hash, updated_at=excluded.updated_at, value=excluded.value', [value.id, value.name, value.version, value.status, value.trustStatus, value.enabled ? 1 : 0, value.contentHash, value.createdAt, value.updatedAt, JSON.stringify(value)]));
  }

  deletePlugin(id: string): void {
    const safeId = pluginId(id, '插件');
    if (!this.getPlugin(safeId)) throw new Error('插件不存在');
    this.transaction(() => this.db.run('DELETE FROM plugins WHERE id = ?', [safeId]));
  }

  listPluginVersions(pluginIdValue: string): PluginVersionRecord[] {
    return this.rows<PluginVersionRecord>('SELECT value FROM plugin_versions WHERE plugin_id = ? ORDER BY installed_at DESC, rowid DESC', [pluginId(pluginIdValue, '插件')]);
  }

  savePluginVersion(record: PluginVersionRecord): void {
    const value = safePluginVersion(record);
    if (!this.getPlugin(value.pluginId)) throw new Error('插件不存在');
    this.transaction(() => {
      if (value.isActive) {
        for (const previous of this.listPluginVersions(value.pluginId)) {
          if (previous.isActive && previous.id !== value.id) {
            const inactive = { ...previous, isActive: false };
            this.db.run('UPDATE plugin_versions SET is_active = 0, value = ? WHERE id = ?', [JSON.stringify(inactive), previous.id]);
          }
        }
      }
      this.db.run('INSERT INTO plugin_versions(id, plugin_id, version, installed_at, is_active, value) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, installed_at=excluded.installed_at, is_active=excluded.is_active, value=excluded.value', [value.id, value.pluginId, value.version, value.installedAt, value.isActive ? 1 : 0, JSON.stringify(value)]);
    });
  }

  deletePluginVersion(id: string): void { this.transaction(() => this.db.run('DELETE FROM plugin_versions WHERE id = ?', [pluginId(id, '插件版本')])); }

  listPluginSkills(pluginIdValue?: string): PluginSkillRecord[] {
    const params: SqlValue[] = pluginIdValue === undefined ? [] : [pluginId(pluginIdValue, '插件')];
    return this.rows<PluginSkillRecord>(pluginIdValue === undefined ? 'SELECT value FROM plugin_skills ORDER BY name, rowid' : 'SELECT value FROM plugin_skills WHERE plugin_id = ? ORDER BY name, rowid', params);
  }

  getPluginSkill(id: string): PluginSkillRecord | undefined { return this.rows<PluginSkillRecord>('SELECT value FROM plugin_skills WHERE id = ?', [pluginId(id, 'Skill')])[0]; }

  savePluginSkill(record: PluginSkillRecord): void {
    const value = safePluginSkill(record);
    if (!this.getPlugin(value.pluginId)) throw new Error('插件不存在');
    this.transaction(() => this.db.run('INSERT INTO plugin_skills(id, plugin_id, name, enabled, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, value=excluded.value', [value.id, value.pluginId, value.name, value.enabled ? 1 : 0, JSON.stringify(value)]));
  }

  deletePluginSkill(id: string): void { this.transaction(() => this.db.run('DELETE FROM plugin_skills WHERE id = ?', [pluginId(id, 'Skill')])); }

  listPluginMcpServers(pluginIdValue?: string): PluginMcpServerRecord[] {
    const params: SqlValue[] = pluginIdValue === undefined ? [] : [pluginId(pluginIdValue, '插件')];
    return this.rows<PluginMcpServerRecord>(pluginIdValue === undefined ? 'SELECT value FROM plugin_mcp_servers ORDER BY server_name, rowid' : 'SELECT value FROM plugin_mcp_servers WHERE plugin_id = ? ORDER BY server_name, rowid', params);
  }

  getPluginMcpServer(id: string): PluginMcpServerRecord | undefined { return this.rows<PluginMcpServerRecord>('SELECT value FROM plugin_mcp_servers WHERE id = ?', [pluginId(id, 'MCP Server')])[0]; }

  savePluginMcpServer(record: PluginMcpServerRecord): void {
    const value = safePluginMcpServer(record);
    if (!this.getPlugin(value.pluginId)) throw new Error('插件不存在');
    this.transaction(() => this.db.run('INSERT INTO plugin_mcp_servers(id, plugin_id, server_name, transport, enabled, health_status, value) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET server_name=excluded.server_name, transport=excluded.transport, enabled=excluded.enabled, health_status=excluded.health_status, value=excluded.value', [value.id, value.pluginId, value.serverName, value.transport, value.enabled ? 1 : 0, value.healthStatus, JSON.stringify(value)]));
  }

  deletePluginMcpServer(id: string): void { this.transaction(() => this.db.run('DELETE FROM plugin_mcp_servers WHERE id = ?', [pluginId(id, 'MCP Server')])); }

  listRuntimePluginBindings(pluginIdValue?: string): RuntimePluginBindingRecord[] {
    const params: SqlValue[] = pluginIdValue === undefined ? [] : [pluginId(pluginIdValue, '插件')];
    return this.rows<RuntimePluginBindingRecord>(pluginIdValue === undefined ? 'SELECT value FROM runtime_plugin_bindings ORDER BY profile_id, rowid' : 'SELECT value FROM runtime_plugin_bindings WHERE plugin_id = ? ORDER BY profile_id, rowid', params);
  }

  getRuntimePluginBinding(id: string): RuntimePluginBindingRecord | undefined { return this.rows<RuntimePluginBindingRecord>('SELECT value FROM runtime_plugin_bindings WHERE id = ?', [pluginId(id, 'Runtime 绑定')])[0]; }

  saveRuntimePluginBinding(record: RuntimePluginBindingRecord): void {
    const value = safeRuntimePluginBinding(record);
    if (!this.getPlugin(value.pluginId)) throw new Error('插件不存在');
    this.transaction(() => this.db.run('INSERT INTO runtime_plugin_bindings(id, plugin_id, runtime_kind, profile_id, install_state, value) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(plugin_id, runtime_kind, profile_id) DO UPDATE SET id=excluded.id, install_state=excluded.install_state, value=excluded.value', [value.id, value.pluginId, value.runtimeKind, value.profileId, value.installState, JSON.stringify(value)]));
  }

  deleteRuntimePluginBinding(id: string): void { this.transaction(() => this.db.run('DELETE FROM runtime_plugin_bindings WHERE id = ?', [pluginId(id, 'Runtime 绑定')])); }

  getSessionPluginSnapshot(sessionId: string): SessionPluginSnapshot | undefined {
    return this.rows<SessionPluginSnapshot>('SELECT value FROM session_plugin_snapshots WHERE session_id = ?', [pluginId(sessionId, '会话')])[0];
  }

  saveSessionPluginSnapshot(snapshot: SessionPluginSnapshot): void {
    const value = safeSnapshot(snapshot);
    if (!this.getSession(value.sessionId)) throw new Error('会话不存在');
    this.transaction(() => this.db.run('INSERT INTO session_plugin_snapshots(session_id, profile_id, created_at, value) VALUES (?, ?, ?, ?)', [value.sessionId, value.profileId, value.createdAt, JSON.stringify(value)]));
  }

  deleteSessionPluginSnapshot(sessionId: string): void { this.transaction(() => this.db.run('DELETE FROM session_plugin_snapshots WHERE session_id = ?', [pluginId(sessionId, '会话')])); }

  appendPluginAudit(record: PluginAuditRecord): void {
    const value = safePluginAudit(record);
    this.transaction(() => this.db.run('INSERT INTO plugin_audit_logs(id, action, plugin_id, runtime_kind, result, created_at, value) VALUES (?, ?, ?, ?, ?, ?, ?)', [value.id, value.action, value.pluginId ?? null, value.runtimeKind ?? null, value.result, value.createdAt, JSON.stringify(value)]));
  }

  listPluginAudits(options: { pluginId?: string; limit?: number } = {}): PluginAuditRecord[] {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('插件审计条数无效');
    if (options.pluginId !== undefined) return this.rows<PluginAuditRecord>('SELECT value FROM plugin_audit_logs WHERE plugin_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [pluginId(options.pluginId, '插件'), limit]);
    return this.rows<PluginAuditRecord>('SELECT value FROM plugin_audit_logs ORDER BY created_at DESC, rowid DESC LIMIT ?', [limit]);
  }

  deletePluginAuditsBefore(cutoffIso: string): number {
    const cutoff = pluginTimestamp(cutoffIso, '插件审计清理');
    let deleted = 0;
    this.transaction(() => { this.db.run('DELETE FROM plugin_audit_logs WHERE created_at < ?', [cutoff]); deleted = this.db.getRowsModified(); });
    return deleted;
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
