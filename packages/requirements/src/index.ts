import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requiresRequirementAdmission } from '../../domain/src/jira-requirements';
import type {
  JiraIssue,
  ProductSystem,
  RequirementAdmissionStatus,
  RequirementAdmission,
  RequirementAnalysis,
  RequirementBlockingStage,
  RequirementCheckItem,
  RequirementEffectiveItem,
  RequirementEvidence,
  RequirementResolution,
  RequirementTaskType,
} from '../../domain/src';

export const REQUIREMENT_TEMPLATE_VERSION = '1.0.0';
export const REQUIREMENT_RULE_VERSION = '1.0.0';

export interface RequirementSnapshot {
  id: string;
  issueKey: string;
  jiraUpdated?: string;
  contentHash: string;
  fetchedAt: string;
  issue: JiraIssue;
}

export interface RequirementTemplateCheck {
  itemKey: string;
  title: string;
  description: string;
  riskLevel: RequirementCheckItem['riskLevel'];
  blockingStage: RequirementBlockingStage;
  overrideAllowed: boolean;
  question?: string;
}

export interface RequirementTemplate {
  id: string;
  version: string;
  projectGenerations: Array<ProductSystem | 'unknown'>;
  taskTypes: RequirementTaskType[];
  checks: RequirementTemplateCheck[];
}

const taskTypes = ['bug', 'feature', 'integration', 'schema', 'report', 'ui', 'config', 'refactor', 'unknown'] as const;
const systems = ['MES5', 'MES6', 'WMS', '前端', '通用', 'unknown'] as const;
const blockingStages = ['design', 'implementation', 'testing', 'release', 'none'] as const;
const riskLevels = ['critical', 'high', 'medium', 'low'] as const;
const itemStatuses = ['confirmed', 'missing', 'ambiguous', 'assumption', 'not_applicable'] as const;
const resolutionActions = ['confirm', 'provide_info', 'reject_assumption', 'not_applicable', 'accept_risk'] as const;

const evidenceSchema = z.object({
  sourceType: z.enum(['jira_summary', 'jira_description', 'jira_comment', 'jira_attachment', 'user_supplement', 'project_context', 'knowledge']),
  sourceId: z.string().min(1).max(200).optional(),
  location: z.string().min(1).max(500).optional(),
  quote: z.string().max(1000).optional(),
}).strict();

const checkItemSchema = z.object({
  id: z.string().uuid(), itemKey: z.string().min(1).max(100), title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(), status: z.enum(itemStatuses),
  riskLevel: z.enum(riskLevels), blockingStage: z.enum(blockingStages), overrideAllowed: z.boolean(),
  finding: z.string().min(1).max(4000), question: z.string().max(2000).optional(),
  evidence: z.array(evidenceSchema).max(30), updatedAt: z.string().datetime(),
}).strict();

const acceptanceCriterionSchema = z.object({
  id: z.string().uuid(), criterionKey: z.string().regex(/^AC-[A-Z0-9_-]{1,40}$/),
  statement: z.string().min(1).max(2000), status: z.enum(['confirmed', 'needs_confirmation', 'not_applicable']),
  source: z.array(evidenceSchema).max(30),
}).strict();

export const requirementAnalysisSchema = z.object({
  taskType: z.enum(taskTypes), projectGeneration: z.enum(systems), summary: z.string().min(1).max(4000),
  items: z.array(checkItemSchema).min(1).max(200), acceptanceCriteria: z.array(acceptanceCriterionSchema).max(100),
}).strict();

const resolutionSchema = z.object({
  id: z.string().uuid(), itemId: z.string().uuid(), action: z.enum(resolutionActions),
  valueText: z.string().max(8000).optional(), reason: z.string().max(4000).optional(),
  actorId: z.string().max(200).optional(), actorLabel: z.string().min(1).max(200), createdAt: z.string().datetime(),
}).strict();

function normalizedText(value: string | undefined): string | null {
  return value === undefined ? null : value.normalize('NFC').replace(/\r\n?/g, '\n');
}

/** Hashes only requirement-relevant Jira content; fetch timestamps and attachment ordering do not affect identity. */
export function hashRequirementSnapshot(issue: JiraIssue): string {
  const attachments = [...issue.attachments]
    .map(item => ({
      id: item.id,
      name: normalizedText(item.name),
      mimeType: normalizedText(item.mimeType),
      size: item.size,
      localImage: item.localImage ? { sha256: item.localImage.sha256, mimeType: item.localImage.mimeType, size: item.localImage.size } : null,
      imageWarning: normalizedText(item.imageWarning),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const canonical = {
    id: normalizedText(issue.id),
    key: normalizedText(issue.key),
    summary: normalizedText(issue.summary),
    description: normalizedText(issue.description),
    status: normalizedText(issue.status),
    issueType: normalizedText(issue.issueType),
    priority: normalizedText(issue.priority),
    updated: normalizedText(issue.updated),
    attachments,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export function createRequirementSnapshot(issue: JiraIssue, now = new Date().toISOString()): RequirementSnapshot {
  const contentHash = hashRequirementSnapshot(issue);
  return {
    id: createHash('sha256').update(`${issue.key}\0${contentHash}`, 'utf8').digest('hex'),
    issueKey: issue.key,
    ...(issue.updated ? { jiraUpdated: issue.updated } : {}),
    contentHash,
    fetchedAt: now,
    issue,
  };
}

const attachmentOnlyPattern = /(?:详见|见|依据|按照|以).*附件|附件(?:中|内容|说明)/i;
const uiOnlyPattern = /文案|按钮|页面|布局|颜色|样式|交互|显示|弹窗|字段顺序|字段标签|提示语|字体(?:大小)?|字号|导航名称|表单/;
const uiLocationPattern = /(?:登录|首页|主页|工作台|库存|订单|用户|客户|设备|生产|报工|设置|系统|项目|任务|数据|质量|物料|查询|明细|详情|编辑|新增|列表|工序|工单|看板)[\u4e00-\u9fff]{0,8}(?:页面|页|列表|详情|表单|弹窗|对话框|窗口|导航|菜单|面板|区域)/;
const uiTargetPattern = /[“"「『][^”"」』]{1,80}[”"」』]|(?:列宽|边距|字体大小|字号|颜色|宽度|高度|布局|字段顺序|空状态|悬停.{0,8}提示|鼠标悬停显示).{0,16}(?:调整|改为|改成|设置|统一|显示|隐藏|使用|变为).{0,20}|(?:改为|改成|调整为|设置为|显示为|使用品牌色)\s*[^\s，。；]{1,30}/;
const uiScopePattern = /简体中文|繁体中文|中文|英文|英语|日文|日语|语言|仅在|仅限|仅此页面|只在|只限|所有页面|全部页面|移动端|桌面端|PC端|手机端|平板端|终端|响应式|仅对.{0,20}(?:生效|显示|使用|页面|表单)/i;
const businessActionPattern = /扣减|出库|拣货|冻结|解冻|预占|释放|报工|上料|工单|工序|质检|检验|接口|同步|集成|对接|数据库|建表|迁移|统计逻辑/;

/**
 * Creates an admission using only local keyword rules. It does not call an AI model or claim semantic understanding;
 * ambiguous/missing business facts remain unresolved and the deterministic gate decides whether writes can proceed.
 */
export function createDefaultRequirementAdmission(
  issue: JiraIssue, generation: ProductSystem | 'unknown', now = new Date().toISOString(),
): RequirementAdmission {
  const snapshot = createRequirementSnapshot(issue, now);
  const text = `${issue.summary}\n${issue.description}`.normalize('NFC');
  const taskType = inferRequirementTaskType(issue);
  const items: RequirementCheckItem[] = [];
  const acceptanceCriteria: RequirementAnalysis['acceptanceCriteria'] = [];
  let specializedRuleApplied = false;

  if (taskType === 'ui') {
    const hasLocation = uiLocationPattern.test(text);
    const hasTarget = uiTargetPattern.test(text);
    const hasDisplayScope = uiScopePattern.test(text);
    const missing: string[] = [];
    if (!hasLocation) missing.push('请明确页面或功能位置');
    if (!hasTarget) missing.push('请明确目标文案或具体显示行为');
    if (!hasDisplayScope) missing.push('请明确语言或显示范围');
    const complete = missing.length === 0;
    items.push(makeRuleItem(issue, now, {
      itemKey: 'REQ-UI-SCOPE', title: 'UI 需求范围', status: complete ? 'confirmed' : 'missing', riskLevel: complete ? 'low' : 'high',
      blockingStage: complete ? 'none' : 'implementation', overrideAllowed: false,
      finding: complete
        ? '本地规则识别到页面位置、目标文案或行为以及语言/显示范围；未加载 MES/WMS 业务模板。'
        : `界面调整范围信息不完整：${missing.join('；')}。本地规则不会据此猜测实现目标。`,
      question: complete ? undefined : `${missing.join('；')}。`,
      evidence: findEvidence(issue, uiOnlyPattern),
    }));
  }

  // Task-aware checks: a simple UI request must never inherit MES/WMS business rules.
  if (generation === 'WMS' && taskType !== 'ui' && /库存/.test(text) && /扣减|出库|拣货|冻结|解冻|预占|释放/.test(text)) {
    specializedRuleApplied = true;
    const timing = !/(?:扣减|库存).{0,16}(?:未明确|不明确|不清楚|待确认|有歧义)/.test(text) &&
      /(?:确认|完成|复核|下架|拣货)后.{0,12}(?:扣减|减少库存)|(?:扣减|减少库存).{0,12}(?:确认|完成|复核|下架|拣货)|实时扣减/.test(text);
    items.push(makeRuleItem(issue, now, {
      itemKey: 'REQ-WMS-STOCK-DEDUCTION-TIMING', title: '库存扣减时点', status: timing ? 'confirmed' : 'missing',
      riskLevel: 'critical', blockingStage: 'implementation', overrideAllowed: false,
      finding: timing ? '需求文本给出了库存扣减时点线索；请以来源原文为准。' : '需求涉及库存变化，但未说明在哪个业务节点扣减库存。',
      question: timing ? undefined : '库存应在拣货、复核、出库确认还是其他节点扣减？',
      evidence: timing ? findEvidence(issue, /扣减时(?:机|点)|扣减|预占库存/) : [],
    }));
  }

  if ((generation === 'MES5' || generation === 'MES6') && taskType !== 'ui' && /报工/.test(text)) {
    specializedRuleApplied = true;
    const ambiguous = /(?:按|以).{0,12}(?:投入|投产|完工|合格|不合格|良品|不良品|工序|剩余).{0,8}(?:还是|或|与).{0,12}(?:投入|投产|完工|合格|不合格|良品|不良品|工序|剩余)|数量口径.{0,8}(?:不清|不明|有歧义|两种)|报工.{0,30}(?:待确认|未明确|不明确|有歧义|说法不一致)/.test(text);
    const quantityDefined = /(?:数量口径|按.{0,16}(?:投入|投产|完工|合格|不合格|良品|不良品|工序|剩余).{0,8}数量|(?:合格|不合格|良品|不良品|投入|投产|完工|工序|剩余)数量|报工数量.{0,12}(?:为|按|等于|不能超过))/.test(text);
    items.push(makeRuleItem(issue, now, {
      itemKey: 'REQ-MES-REPORT-QUANTITY-BASIS', title: '生产报工数量口径', status: ambiguous ? 'ambiguous' : quantityDefined ? 'confirmed' : 'missing',
      riskLevel: 'critical', blockingStage: 'implementation', overrideAllowed: false,
      finding: ambiguous ? '需求文本同时出现多种数量口径线索，需要人工澄清。' : quantityDefined ? '需求文本给出了报工数量定义线索；请以来源原文为准。' : '需求涉及生产报工，但未明确报工数量按什么口径计算。',
      question: ambiguous ? '请确认报工数量按投入数、完工数、合格数还是其他口径计算。' : quantityDefined ? undefined : '报工数量按投入数、完工数、合格数还是工序数量计算？',
      evidence: findEvidence(issue, /报工|数量|投入|投产|完工|合格|不合格/),
    }));
  }

  // This local-only analyzer does not OCR or extract file content, so a cached image still is not evidence it has read.
  const referencedAttachment = issue.attachments[0];
  if (referencedAttachment && attachmentOnlyPattern.test(text) && text.replace(attachmentOnlyPattern, '').replace(/\s/g, '').length < 120) {
    items.push(makeRuleItem(issue, now, {
      itemKey: 'REQ-GEN-ATTACHMENT-READABILITY', title: '唯一需求附件可读取性', status: 'missing',
      riskLevel: 'high', blockingStage: 'design', overrideAllowed: false,
      finding: `需求文本将附件“${referencedAttachment.name}”作为唯一依据；本地规则分析器不会读取附件正文，因此不能据此推断业务规则。`,
      question: '请把关键业务规则补充到 Jira 描述或用户补充中，再重新检查。', evidence: findEvidence(issue, /附件|需求/),
    }));
  }

  const acceptance = extractAcceptanceCriterion(issue);
  if (acceptance) acceptanceCriteria.push(acceptance);
  else items.push(makeRuleItem(issue, now, {
    itemKey: 'REQ-GEN-11', title: '验收标准', status: 'missing', riskLevel: 'medium',
    blockingStage: 'testing', overrideAllowed: false,
    finding: '未找到可识别的验收标准；这不阻止初步开发，但测试/验收结论必须保持受阻。',
    question: '完成后应观察到什么结果，如何验证？', evidence: [],
  }));

  if (taskType !== 'ui' && !specializedRuleApplied) {
    items.push(makeRuleItem(issue, now, {
      itemKey: 'REQ-GEN-LOCAL-RULE-COVERAGE', title: '本地规则覆盖范围', status: 'missing', riskLevel: 'high',
      blockingStage: 'design', overrideAllowed: false,
      finding: '当前任务类型或业务范围未命中已实现的专项检查模板，不能据此推断接口、数据、异常和验收规则已完整。',
      question: '请补充适用的业务模板、关键规则、接口约束和验收标准，再重新检查。', evidence: [],
    }));
  } else if (items.length === 0) {
    items.push(makeRuleItem(issue, now, {
      itemKey: 'REQ-GEN-LOCAL-RULE-COVERAGE', title: '本地规则覆盖范围', status: 'assumption', riskLevel: 'low',
      blockingStage: 'none', overrideAllowed: true,
      finding: '本地关键词规则未识别到更多专项检查项；准入结论只覆盖已实现的确定性规则，仍需人工核对未覆盖的业务条件。',
      evidence: [],
    }));
  }

  const calculation = calculateRequirementAdmission(items, [], true);
  const analysis: RequirementAnalysis = { taskType, projectGeneration: generation, summary: issue.summary, items, acceptanceCriteria };
  return {
    id: stableUuid(`${snapshot.contentHash}\0${REQUIREMENT_RULE_VERSION}`),
    status: calculation.status,
    implementationAllowed: calculation.implementationAllowed,
    projectGeneration: generation,
    taskType: analysis.taskType,
    snapshotHash: snapshot.contentHash,
    templateVersion: REQUIREMENT_TEMPLATE_VERSION,
    ruleVersion: REQUIREMENT_RULE_VERSION,
    checkedAt: now,
    items,
    resolutions: [],
    acceptanceCriteria,
    stageBlockers: calculation.stageBlockers,
  };
}

function inferRequirementTaskType(issue: JiraIssue): RequirementTaskType {
  const text = `${issue.issueType} ${issue.summary} ${issue.description}`.normalize('NFC');
  if (uiOnlyPattern.test(text) && !businessActionPattern.test(text)) return 'ui';
  if (/bug|缺陷|故障|错误|修复|报错/i.test(text)) return 'bug';
  if (/接口|同步|集成|对接|ERP|QMS/i.test(text)) return 'integration';
  if (/数据库|表结构|建表|字段变更|索引/i.test(text)) return 'schema';
  if (/报表|统计|查询/i.test(text)) return 'report';
  if (/配置|部署|脚本/i.test(text)) return 'config';
  if (/重构|升级依赖|技术改造/i.test(text)) return 'refactor';
  if (/story|feature|需求|新增|增加|支持/i.test(text)) return 'feature';
  return 'unknown';
}

function makeRuleItem(issue: JiraIssue, now: string, item: Omit<RequirementCheckItem, 'id' | 'updatedAt'>): RequirementCheckItem {
  return { ...item, id: stableUuid(`${issue.key}\0${item.itemKey}`), updatedAt: now };
}

function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function findEvidence(issue: JiraIssue, pattern: RegExp): RequirementEvidence[] {
  for (const [sourceType, sourceId, location, value] of [
    ['jira_summary', issue.key, 'summary', issue.summary],
    ['jira_description', issue.key, 'description', issue.description],
  ] as const) {
    const match = value.match(pattern);
    if (match?.index !== undefined) {
      const start = Math.max(0, match.index - 35);
      return [{ sourceType, sourceId, location, quote: value.slice(start, Math.min(value.length, start + 140)) }];
    }
  }
  return [];
}

function extractAcceptanceCriterion(issue: JiraIssue): RequirementAnalysis['acceptanceCriteria'][number] | undefined {
  const fullText = `${issue.summary}\n${issue.description}`;
  const match = fullText.match(/(?:验收标准|验收条件|AC[-_ ]?\d{1,3})\s*[:：]?\s*([^\n。；;]{4,180})/i);
  if (!match || !match[1].trim()) return undefined;
  const quote = match[0].trim();
  const inSummary = issue.summary.includes(quote);
  const evidence: RequirementEvidence = {
    sourceType: inSummary ? 'jira_summary' : 'jira_description', sourceId: issue.key,
    location: inSummary ? 'summary' : 'description', quote: quote.slice(0, 140),
  };
  return { id: stableUuid(`${issue.key}\0AC-01`), criterionKey: 'AC-01', statement: match[1].trim(), status: 'confirmed', source: [evidence] };
}

/** Selects checks by explicit enum scopes. No expression evaluation or model-provided admission status is used. */
export function selectRequirementTemplateChecks(
  templates: RequirementTemplate[], projectGeneration: ProductSystem | 'unknown', taskType: RequirementTaskType,
): RequirementTemplateCheck[] {
  const selected = templates.filter(template =>
    template.projectGenerations.includes(projectGeneration) && template.taskTypes.includes(taskType));
  const seen = new Set<string>();
  const checks: RequirementTemplateCheck[] = [];
  for (const template of selected) {
    for (const check of template.checks) {
      if (seen.has(check.itemKey)) continue;
      seen.add(check.itemKey);
      checks.push({ ...check });
    }
  }
  return checks;
}

/** Runtime-validates structured extraction and rejects evidence references outside the supplied source index. */
export function parseRequirementAnalysis(input: unknown, sourceIndex: RequirementEvidence[]): RequirementAnalysis {
  const parsed = requirementAnalysisSchema.parse(input) as RequirementAnalysis;
  const sources = new Map(sourceIndex.map(source => [evidenceKey(source), source]));
  const validateEvidence = (evidence: RequirementEvidence, owner: string) => {
    const source = sources.get(evidenceKey(evidence));
    if (!source) throw new Error(`${owner} 引用了当前快照中不存在的证据来源`);
    if (evidence.quote) {
      const normalize = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();
      if (!source.quote || !normalize(source.quote).includes(normalize(evidence.quote))) throw new Error(`${owner} 的证据摘录与来源不符`);
    }
  };
  for (const item of parsed.items) {
    if (item.status === 'confirmed' && !item.evidence.length) throw new Error(`检查项 ${item.itemKey} 缺少事实来源，不能标记为已确认`);
    item.evidence.forEach(evidence => validateEvidence(evidence, `检查项 ${item.itemKey}`));
  }
  for (const criterion of parsed.acceptanceCriteria) {
    if (criterion.status === 'confirmed' && !criterion.source.length) throw new Error(`验收标准 ${criterion.criterionKey} 缺少事实来源`);
    criterion.source.forEach(evidence => validateEvidence(evidence, `验收标准 ${criterion.criterionKey}`));
  }
  const itemIds = new Set<string>();
  const itemKeys = new Set<string>();
  for (const item of parsed.items) {
    if (itemIds.has(item.id)) throw new Error(`检查项 ID 重复：${item.id}`);
    itemIds.add(item.id);
    if (itemKeys.has(item.itemKey)) throw new Error(`检查项键重复：${item.itemKey}`);
    itemKeys.add(item.itemKey);
  }
  const criterionKeys = new Set<string>();
  for (const item of parsed.acceptanceCriteria) {
    if (criterionKeys.has(item.criterionKey)) throw new Error(`验收标准 ID 重复：${item.criterionKey}`);
    criterionKeys.add(item.criterionKey);
  }
  return parsed;
}

function evidenceKey(evidence: RequirementEvidence): string {
  return `${evidence.sourceType}\0${evidence.sourceId ?? ''}\0${evidence.location ?? ''}`;
}

/** Validates an append-only human decision before it is persisted. */
export function validateRequirementResolution(input: unknown, items: RequirementCheckItem[]): RequirementResolution {
  const resolution = resolutionSchema.parse(input) as RequirementResolution;
  const item = items.find(candidate => candidate.id === resolution.itemId);
  if (!item) throw new Error('人工决策引用的检查项不存在');
  if (resolution.action === 'provide_info' && !resolution.valueText?.trim()) throw new Error('补充事实时必须填写补充内容');
  if (resolution.action === 'not_applicable' && !resolution.reason?.trim()) throw new Error('标记不适用时必须填写原因');
  if (resolution.action === 'not_applicable' && !item.overrideAllowed && ['design', 'implementation'].includes(item.blockingStage)) {
    throw new Error('不可覆盖的设计或实施硬阻塞不能通过普通不适用决策解除');
  }
  if (resolution.action === 'accept_risk') {
    if (!item.overrideAllowed) throw new Error('此硬阻塞项不允许人工接受风险');
    if (!resolution.reason?.trim()) throw new Error('接受风险时必须填写依据和风险说明');
  }
  if (resolution.action === 'confirm' && !['confirmed', 'not_applicable'].includes(item.status) && !resolution.valueText?.trim()) throw new Error('确认检查项时必须记录确认的事实或依据');
  if (resolution.action === 'reject_assumption' && item.status !== 'assumption') throw new Error('只有假设项可以执行拒绝假设');
  return resolution;
}

function latestResolutions(resolutions: RequirementResolution[]): Map<string, RequirementResolution> {
  const latest = new Map<string, RequirementResolution>();
  for (const resolution of resolutions) {
    const current = latest.get(resolution.itemId);
    if (!current || resolution.createdAt.localeCompare(current.createdAt) > 0 ||
      resolution.createdAt === current.createdAt && resolution.id.localeCompare(current.id) > 0) latest.set(resolution.itemId, resolution);
  }
  return latest;
}

/** Applies the latest audit decision without erasing the original check status. */
export function applyRequirementResolutions(items: RequirementCheckItem[], resolutions: RequirementResolution[]): RequirementEffectiveItem[] {
  // Revalidate persisted decisions at the boundary so malformed or stale records cannot bypass hard blockers.
  const validated = resolutions.map(resolution => validateRequirementResolution(resolution, items));
  const latest = latestResolutions(validated);
  return items.map(item => {
    const resolution = latest.get(item.id);
    let effectiveStatus = item.status;
    let riskAccepted = false;
    if (resolution) {
      if (resolution.action === 'confirm' || resolution.action === 'provide_info') effectiveStatus = 'confirmed';
      else if (resolution.action === 'not_applicable') effectiveStatus = 'not_applicable';
      else if (resolution.action === 'reject_assumption') effectiveStatus = 'missing';
      else if (resolution.action === 'accept_risk' && item.overrideAllowed) riskAccepted = true;
    }
    return { ...item, effectiveStatus, riskAccepted, ...(resolution ? { latestResolution: resolution } : {}) };
  });
}

export interface RequirementAdmissionCalculation {
  status: RequirementAdmissionStatus;
  implementationAllowed: boolean;
  items: RequirementEffectiveItem[];
  stageBlockers: RequirementBlockingStage[];
}

/** Deterministic status calculation. Testing/release blockers remain visible without blocking initial development. */
export function calculateRequirementAdmission(
  items: RequirementCheckItem[], resolutions: RequirementResolution[], snapshotFresh = true,
): RequirementAdmissionCalculation {
  const effectiveItems = applyRequirementResolutions(items, resolutions);
  if (!snapshotFresh) return { status: 'stale', implementationAllowed: false, items: effectiveItems, stageBlockers: unresolvedStages(effectiveItems) };
  if (effectiveItems.length === 0) return { status: 'not_checked', implementationAllowed: false, items: effectiveItems, stageBlockers: [] };
  const blockers = effectiveItems.filter(item => isUnresolved(item) && ['design', 'implementation'].includes(item.blockingStage));
  const hardBlock = blockers.some(item => !item.overrideAllowed);
  const stageBlockers = unresolvedStages(effectiveItems);
  if (hardBlock) return { status: 'blocked', implementationAllowed: false, items: effectiveItems, stageBlockers };
  if (blockers.length) return { status: 'needs_confirmation', implementationAllowed: false, items: effectiveItems, stageBlockers };
  return { status: 'ready', implementationAllowed: true, items: effectiveItems, stageBlockers };
}

/** Recomputes the deterministic gate from the persisted record before allowing a code write. */
export function requirementAdmissionAllowsWrites(admission: RequirementAdmission | undefined, issue: JiraIssue): boolean {
  if (!requiresRequirementAdmission(issue)) return true;
  if (!admission || admission.status !== 'ready' || !admission.implementationAllowed) return false;
  if (hashRequirementSnapshot(issue) !== admission.snapshotHash) return false;
  try {
    const calculation = calculateRequirementAdmission(admission.items, admission.resolutions, true);
    return calculation.status === 'ready' && calculation.implementationAllowed;
  } catch {
    return false;
  }
}

function isUnresolved(item: RequirementEffectiveItem): boolean {
  // Risk acceptance can allow implementation-stage progress, but never removes a testing/release gate.
  if (item.riskAccepted && !['testing', 'release'].includes(item.blockingStage)) return false;
  return item.effectiveStatus !== 'confirmed' && item.effectiveStatus !== 'not_applicable';
}

function unresolvedStages(items: RequirementEffectiveItem[]): RequirementBlockingStage[] {
  const order: RequirementBlockingStage[] = ['design', 'implementation', 'testing', 'release'];
  const unresolved = new Set(items.filter(isUnresolved).map(item => item.blockingStage));
  return order.filter(stage => unresolved.has(stage));
}

