import { z } from 'zod';
import { MODEL_ROUTE_TASKS } from '../../../../packages/domain/src/model-routing';
import { normalizeJiraUrl } from '../../../../packages/jira-connector/src';
export const idSchema = z.string().uuid();
export const operationManualIdSchema = z.union([idSchema, z.string().regex(/^builtin-operation-manual-[a-z0-9-]+$/)]);
export const pluginIdentifierSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, '插件标识无效');
export const projectIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const profileIdSchema = z.union([idSchema, z.literal('legacy-default')]);
export const httpsUrlSchema = z.string().url().max(2000).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }, '地址必须为不含用户名、密码或查询参数的 HTTPS 地址');
export const modelSchema = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
export const modelApiKeySchema = z.string().trim().min(1, '请填写 API Key').max(8192)
  .refine(value => !/[\x00-\x1f\x7f]/.test(value), 'API Key 不能包含控制字符')
  .refine(value => !/^https?:\/\//i.test(value), 'API Key 不能填写网址，请填写中转站生成的密钥');
export const promptSchema = z.string().trim().min(1).max(50000);
export const sessionSendSchema = z.object({ prompt: promptSchema, attachmentIds: z.array(idSchema).max(20).default([]) }).strict();
export const sessionConversationImageSchema = z.object({ sessionId: idSchema, attachmentId: idSchema, fullSize: z.boolean().default(false) }).strict();
export const sessionConversationAttachmentSchema = z.object({ sessionId: idSchema, attachmentId: idSchema }).strict();
export const sessionAttachmentPathsSchema = z.object({ sessionId: idSchema, paths: z.array(z.string().min(1).max(4096).refine(value => !value.includes('\0'), '附件路径无效')).min(1).max(20) }).strict();
const clipboardImageBytesSchema = z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= 8 * 1024 * 1024, '剪贴板图片数据无效或超过 8 MiB');
export const sessionAttachmentsSchema = z.object({
  sessionId: idSchema,
  items: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('path'), path: z.string().min(1).max(4096).refine(value => !value.includes('\0'), '附件路径无效') }).strict(),
    z.object({ kind: z.literal('clipboard-image'), mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), bytes: clipboardImageBytesSchema }).strict()
  ])).min(1).max(20)
}).strict();
export const requirementResolutionActionSchema = z.enum(['confirm', 'provide_info', 'reject_assumption', 'not_applicable', 'accept_risk']);
export const requirementResolutionSchema = z.object({ itemId: idSchema, action: requirementResolutionActionSchema, valueText: z.string().max(8000).optional(), reason: z.string().max(4000).optional() }).strict();
export const clipboardTextSchema = z.string().max(2 * 1024 * 1024, '代码内容过长，请分段复制');
export const providerSchema = z.object({
  baseUrl: httpsUrlSchema,
  model: modelSchema,
  apiKey: modelApiKeySchema.optional()
}).strict();
export const modelProfileSchema = z.object({ id: profileIdSchema.optional(), name: z.string().trim().min(1).max(80), baseUrl: httpsUrlSchema, models: z.array(modelSchema).min(1).max(50).refine(values => new Set(values).size === values.length, '模型不能重复'), modelCatalog: z.array(z.object({ id: modelSchema, name: z.string().trim().min(1).max(240) }).strict()).max(100).optional(), apiKey: modelApiKeySchema.optional() }).strict();
export const providerCredentialRevealSchema = z.object({ id: profileIdSchema, baseUrl: httpsUrlSchema }).strict();
export const providerModelsSchema = z.union([profileIdSchema, z.object({ id: profileIdSchema.optional(), baseUrl: httpsUrlSchema, apiKey: modelApiKeySchema.optional() }).strict()]);
const avatarSchema = z.string().refine(value => value.startsWith('preset-') || /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value), '头像格式不受支持');
export const preferencesSchema = z.object({
  theme: z.enum(['dark', 'light', 'system', 'purple', 'black', 'sky', 'grass']),
  style: z.enum(['jinggong', 'minimal']),
  completionSound: z.enum(['chime', 'bright', 'soft', 'off']).default('chime'),
  updateMode: z.enum(['automatic', 'manual']).default('automatic'),
  userProfile: z.object({ name: z.string().trim().min(1).max(40), avatar: avatarSchema, profession: z.string().trim().max(100) }).strict().optional()
}).strict();
export const layoutSchema = z.object({
  leftVisible: z.boolean(), rightVisible: z.boolean(), bottomVisible: z.boolean(),
  leftWidth: z.number().int().min(180).max(520).optional(),
  rightWidth: z.number().int().min(260).max(840).optional(),
  bottomHeight: z.number().int().min(100).max(480).optional(),
  composerHeight: z.number().int().min(80).max(400).optional(),
  standaloneSessionsHeight: z.number().int().min(15).max(75).optional()
}).strict();
export const projectNameSchema = z.string().trim().min(1, '请输入项目显示名称').max(100, '项目显示名称最多100字').refine(value => !/[\x00-\x1f\x7f]/.test(value), '项目显示名称不能包含换行或控制字符');
export const sessionAliasSchema = z.string().trim().max(100, '会话别名最多100字').refine(value => !/[\x00-\x1f\x7f]/.test(value), '会话别名不能包含换行或控制字符');
export const systemSchema = z.enum(['MES5', 'MES6', 'WMS', '前端', '通用']);
export const modelRoutingSchema = z.object({
  rules: z.array(z.object({
    taskType: z.enum(['simple_question', 'code_change', 'architecture', 'long_context', 'code_review', 'document']),
    providerId: profileIdSchema,
    modelId: modelSchema,
    runtimeKind: z.enum(['jinggong', 'codex', 'claude_agent_sdk', 'grok_build_acp'])
  }).strict()).max(MODEL_ROUTE_TASKS.length)
}).strict().refine(value => new Set(value.rules.map(rule => rule.taskType)).size === value.rules.length, '同一任务类型只能配置一条模型路由');
export const sessionOptionsSchema = z.object({ providerId: profileIdSchema.optional(), model: modelSchema.optional(), system: systemSchema.optional(), reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(), runtimeKind: z.enum(['jinggong', 'codex', 'claude_agent_sdk', 'grok_build_acp']).optional(), delegationMode: z.enum(['native', 'governed', 'off']).optional(), modelRouteTaskType: z.enum(['simple_question', 'code_change', 'architecture', 'long_context', 'code_review', 'document']).optional() }).strict().refine(value => (value.providerId === undefined) === (value.model === undefined) && Object.keys(value).length > 0 && (value.modelRouteTaskType === undefined || (value.providerId !== undefined && value.model !== undefined && value.runtimeKind !== undefined)), '会话配置无效');
const jiraUrlSchema = z.string().trim().min(1).max(2000).transform((value, context) => {
  try { return normalizeJiraUrl(value); }
  catch { context.addIssue({ code: 'custom', message: '请输入有效的 HTTP 或 HTTPS Jira 地址，不能包含账号或密码。' }); return z.NEVER; }
});
export const jiraSchema = z.object({ baseUrl: jiraUrlSchema, account: z.string().trim().min(1).max(320).refine(value => !/[:\r\n]/.test(value), 'Jira 账号不能包含冒号或换行'), password: z.string().min(1).max(8192).optional(), projectKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/).optional(), dateFieldId: z.string().trim().regex(/^\d{1,10}$/).optional() }).strict();
export const claudeCredentialSchema = z.string().trim().min(1, '请填写 Claude Console API Key').max(8192).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Claude API Key 格式无效');
export const claudeRuntimeSchema = z.object({ model: modelSchema, baseUrl: httpsUrlSchema.optional() }).strict();
const wecomWebhookSchema = z.string().trim().min(1).max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.toLowerCase() === 'qyapi.weixin.qq.com' && url.pathname === '/cgi-bin/webhook/send' && !!url.searchParams.get('key') && [...url.searchParams.keys()].every(key => key === 'key') && !url.username && !url.password && !url.hash; } catch { return false; }
}, '请输入有效的企业微信群机器人 HTTPS Webhook');
export const wecomTargetSchema = z.object({
  id: idSchema.optional(), name: z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f\x7f]/.test(value), '目标名称不能包含控制字符'),
  purpose: z.enum(['private_group', 'team_group']), webhookUrl: wecomWebhookSchema.optional(), enabled: z.boolean(),
  mentionedUserIds: z.array(z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.@-]+$/)).max(50).optional(),
  mentionedMobiles: z.array(z.string().trim().regex(/^\+?[0-9]{6,20}$/)).max(50).optional(),
  workspaceIds: z.array(projectIdSchema).max(50).optional(),
  runtimeKinds: z.array(z.enum(['jinggong', 'codex', 'claude_agent_sdk', 'grok_build_acp'])).max(4).optional(),
  eventPolicy: z.object({ onCompleted: z.boolean(), onFailed: z.boolean(), onError: z.boolean(), onCancelled: z.boolean(), onInterrupted: z.boolean() }).strict(),
}).strict();
export const jiraIssueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}-[1-9]\d{0,11}$/);
export const jiraProjectScopeSchema = z.union([z.literal('*'), z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)]).optional();
export const sessionCreateSchema = z.object({
  workMode: z.enum(['delivery', 'development']).default('development'),
  alias: sessionAliasSchema.optional(),
  workspaceId: idSchema.optional(),
  projectId: projectIdSchema.optional(),
  deliveryProjectId: idSchema.optional(),
  jiraIssueKey: jiraIssueKeySchema.optional(),
  jiraProjectKey: jiraProjectScopeSchema,
  baseBranch: z.string().trim().min(1).max(255).optional(),
  runtimeKind: z.enum(['jinggong', 'codex', 'claude_agent_sdk', 'grok_build_acp']).default('claude_agent_sdk'),
  delegationMode: z.enum(['native', 'governed', 'off']).optional(),
  pluginIds: z.array(pluginIdentifierSchema).max(100).optional(),
}).strict()
  .refine(value => (!value.jiraIssueKey && !value.jiraProjectKey) || (!!value.projectId && !!value.jiraIssueKey), 'Jira 关联必须同时绑定项目和任务')
  .refine(value => value.workMode === 'delivery'
    ? !value.projectId && !value.workspaceId && !value.jiraIssueKey && !value.jiraProjectKey && !value.baseBranch && !value.pluginIds
    : !value.deliveryProjectId, '会话项目绑定与工作模式不匹配');
export const jiraSearchSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startAt: z.number().int().min(0).max(1000000).optional(), onlyMine: z.boolean().optional(), scope: z.enum(['daily', 'recent']).optional(), projectKey: jiraProjectScopeSchema, priorityFirst: z.boolean().optional() }).strict();
export const requirementInputSchema = z.object({ id: idSchema.optional(), title: z.string().trim().min(1).max(160).refine(value => !/[\r\n\x00]/.test(value), '标题不能包含换行'), content: z.string().min(1).max(80000).refine(value => !!value.trim(), '请输入开发要求正文'), system: systemSchema }).strict();
export const documentImportSchema = z.object({ kind: z.enum(['dictionary', 'requirement']), system: systemSchema }).strict();
export const memorySchema = z.object({ id: idSchema.optional(), title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(12000), category: z.enum(['preference', 'working_style', 'constraint', 'tool_preference', 'role_context', 'reusable_experience', 'other']).optional() }).strict();
export const memoryStatusSchema = z.enum(['active', 'pending_review', 'superseded', 'archived', 'blocked_sensitive']);
export const memorySettingsSchema = z.object({ autoCaptureEnabled: z.boolean(), globalInjectionEnabled: z.boolean(), projectInjectionEnabled: z.boolean(), codexMemoryInjectionEnabled: z.boolean().default(true), maxItems: z.number().int().min(1).max(20), maxChars: z.number().int().min(500).max(10000) }).strict();
export const commitSchema = z.object({ message: z.string().trim().min(1).max(4000), reviewedDocumentIds: z.array(idSchema).max(100).optional(), authorName: z.string().trim().min(1).max(100).optional(), authorEmail: z.email().max(320).optional(), jiraUrl: z.url().max(2000).optional() }).strict();
export const gitFileSchema = z.string().min(1).max(1000).refine(value => !/[\x00-\x1f\x7f]/.test(value), '文件路径不能包含控制字符').refine(value => !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value), '文件路径必须使用工作区内的相对路径');
export function redact(text: string, secret?: string): string {
  let value = text;
  if (secret) value = value.split(secret).join('[已脱敏]');
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [已脱敏]').replace(/\bsk-[\w-]{8,}/g, '[已脱敏]');
}
