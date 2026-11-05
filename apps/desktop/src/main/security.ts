import { z } from 'zod';
import { normalizeJiraUrl } from '../../../../packages/jira-connector/src';
export const idSchema = z.string().uuid();
export const projectIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const profileIdSchema = z.union([idSchema, z.literal('legacy-default')]);
export const httpsUrlSchema = z.string().url().max(2000).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }, '地址必须为不含用户名、密码或查询参数的 HTTPS 地址');
export const modelSchema = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
export const promptSchema = z.string().trim().min(1).max(50000);
export const providerSchema = z.object({
  baseUrl: httpsUrlSchema,
  model: modelSchema,
  apiKey: z.string().min(1).max(8192).optional()
}).strict();
export const modelProfileSchema = z.object({ id: profileIdSchema.optional(), name: z.string().trim().min(1).max(80), baseUrl: httpsUrlSchema, models: z.array(modelSchema).min(1).max(50).refine(values => new Set(values).size === values.length, '模型不能重复'), apiKey: z.string().min(1).max(8192).optional() }).strict();
export const preferencesSchema = z.object({ theme: z.enum(['dark', 'light', 'system', 'purple', 'black', 'sky', 'grass']), style: z.enum(['jinggong', 'minimal']) }).strict();
export const layoutSchema = z.object({ leftVisible: z.boolean(), rightVisible: z.boolean(), bottomVisible: z.boolean() }).strict();
export const projectNameSchema = z.string().trim().min(1, '请输入项目显示名称').max(100, '项目显示名称最多100字').refine(value => !/[\x00-\x1f\x7f]/.test(value), '项目显示名称不能包含换行或控制字符');
export const sessionAliasSchema = z.string().trim().max(100, '会话别名最多100字').refine(value => !/[\x00-\x1f\x7f]/.test(value), '会话别名不能包含换行或控制字符');
export const systemSchema = z.enum(['MES5', 'MES6', 'WMS', '通用']);
export const sessionOptionsSchema = z.object({ providerId: profileIdSchema, model: modelSchema, mode: z.enum(['read', 'develop']), system: systemSchema.optional(), reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional() }).strict();
const jiraUrlSchema = z.string().trim().min(1).max(2000).transform((value, context) => {
  try { return normalizeJiraUrl(value); }
  catch { context.addIssue({ code: 'custom', message: '请输入有效的 HTTP 或 HTTPS Jira 地址，不能包含账号或密码。' }); return z.NEVER; }
});
export const jiraSchema = z.object({ baseUrl: jiraUrlSchema, account: z.string().trim().min(1).max(320).refine(value => !/[:\r\n]/.test(value), 'Jira 账号不能包含冒号或换行'), password: z.string().min(1).max(8192).optional(), projectKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/).optional(), dateFieldId: z.string().trim().regex(/^\d{1,10}$/).optional() }).strict();
export const jiraIssueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}-[1-9]\d{0,11}$/);
export const jiraProjectScopeSchema = z.union([z.literal('*'), z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)]).optional();
export const jiraSearchSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startAt: z.number().int().min(0).max(1000000).optional(), onlyMine: z.boolean().optional(), scope: z.enum(['daily', 'recent']).optional(), projectKey: jiraProjectScopeSchema }).strict();
export const requirementInputSchema = z.object({ id: idSchema.optional(), title: z.string().trim().min(1).max(160).refine(value => !/[\r\n\x00]/.test(value), '标题不能包含换行'), content: z.string().min(1).max(80000).refine(value => !!value.trim(), '请输入开发要求正文'), system: systemSchema }).strict();
export const documentImportSchema = z.object({ kind: z.enum(['dictionary', 'requirement']), system: systemSchema }).strict();
export const memorySchema = z.object({ title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(12000) }).strict();
export const commitSchema = z.object({ message: z.string().trim().min(1).max(2000), reviewedDocumentIds: z.array(idSchema).max(100), authorName: z.string().trim().min(1).max(100).optional(), authorEmail: z.email().max(320).optional() }).strict();
export function redact(text: string, secret?: string): string {
  let value = text;
  if (secret) value = value.split(secret).join('[已脱敏]');
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [已脱敏]').replace(/\bsk-[\w-]{8,}/g, '[已脱敏]');
}
