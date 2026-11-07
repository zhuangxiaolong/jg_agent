import { z } from 'zod';

const planPath = z.string().trim().min(1).max(500).transform(value => value.replaceAll('\\', '/').split('/').filter(part => part !== '.').join('/'))
  .refine(value => !!value && !value.startsWith('/') && !/[\x00-\x1f<>:"|?*`]/.test(value) && !value.split('/').some(part => !part || part === '..' || part.toLowerCase() === '.git'), '方案文件必须为项目内相对路径');
const planText = z.string().trim().min(1).max(2000);
const changePlanSchema = z.object({
  stage: z.enum(['draft', 'ready']).default('ready'),
  goal: planText,
  changes: z.array(z.object({ path: planPath, change: planText }).strict()).max(30),
  assumptions: z.array(planText).max(20).default([]),
  pendingQuestions: z.array(planText).max(20).default([]),
  impact: planText,
  validation: z.array(planText).min(1).max(20)
}).strict()
  .refine(value => value.stage !== 'ready' || value.changes.length > 0, '正式方案必须包含已定位的修改文件')
  .refine(value => value.stage !== 'ready' || value.pendingQuestions.length === 0, '仍有待确认事项时请发布 draft 初步方案')
  .refine(value => value.stage !== 'draft' || value.pendingQuestions.length > 0, '初步方案需说明待确认事项')
  .refine(value => JSON.stringify(value).length <= 18000, '代码修改方案过长，请精简方案后重试');

export const CHANGE_PLAN_TOOL = {
  type: 'function', name: 'publish_change_plan',
  description: '在当前会话中发布代码修改方案。涉及代码修改即使条件不全也必须给方案：stage=draft 发布初步方案，列出已确认方向、暂定修改、assumptions 假设和 pendingQuestions 待确认项，不允许凭此写入；尚未定位文件时 changes 可为空，不能编造路径。条件齐全时用 stage=ready 发布逐文件正式方案，再允许按方案写入/删除。发布方案不代表已修改或测试通过。',
  inputSchema: {
    type: 'object', properties: {
      stage: { type: 'string', enum: ['draft', 'ready'], description: '条件不全用 draft 初步方案；条件齐全用 ready 正式方案。省略时兼容旧方案，按 ready 处理' },
      goal: { type: 'string', description: '本轮目标、现状和原因' },
      changes: { type: 'array', maxItems: 30, items: { type: 'object', properties: { path: { type: 'string', description: '已定位的项目内相对文件路径；未定位时不要编造路径' }, change: { type: 'string', description: '涉及的类/方法、改法和执行步骤；初步方案标明哪些部分暂定' } }, required: ['path', 'change'], additionalProperties: false } },
      assumptions: { type: 'array', maxItems: 20, items: { type: 'string' }, description: '方案采用但尚待核实的假设，不能把假设写成事实' },
      pendingQuestions: { type: 'array', maxItems: 20, items: { type: 'string' }, description: '待确认的业务、代码范围或实现条件；draft 至少一项，ready 必须为空' },
      impact: { type: 'string', description: '影响范围、风险及兼容性；数据库或产线流程需说明事务和性能影响' },
      validation: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: '计划执行的构建、测试和验收方式，不得冒充已通过结果' }
    }, required: ['goal', 'changes', 'impact', 'validation'], additionalProperties: false
  }
} as const;

export function parseChangePlan(input: unknown) { return changePlanSchema.parse(input); }
export type ChangePlan = ReturnType<typeof parseChangePlan>;
export function planIncludesFile(plan: ChangePlan, filename: string): boolean {
  if (plan.stage !== 'ready') return false;
  const normalize = (value: string) => value.replaceAll('\\', '/').split('/').filter(part => part !== '.').join('/');
  const key = (value: string) => process.platform === 'win32' ? normalize(value).toLowerCase() : normalize(value);
  return plan.changes.some(item => key(item.path) === key(filename));
}
export function renderChangePlan(plan: ChangePlan): string {
  const list = (items: string[]) => items.map(item => `- ${item.replaceAll('\n', '\n  ')}`).join('\n');
  const changes = plan.changes.map((item, index) => `${index + 1}. \`${item.path}\`\n   ${item.change.replaceAll('\n', '\n   ')}`).join('\n') || '具体文件与方法尚待定位；先按下述目标核对代码入口和调用关系，再补充逐文件修改范围。';
  const draft = plan.stage === 'draft';
  return `## 代码修改方案${draft ? '（初步，待确认）' : ''}\n\n${draft ? '> ⚠️ 条件尚未齐全，以下为初步方案。待确认事项补齐并更新正式方案后，再执行代码修改。\n\n' : ''}### 修改目标\n${plan.goal}\n\n### ${draft ? '暂定修改范围与步骤' : '修改文件与步骤'}\n${changes}${plan.assumptions.length ? `\n\n### 方案假设（待核实）\n${list(plan.assumptions)}` : ''}${plan.pendingQuestions.length ? `\n\n### 待确认事项\n${list(plan.pendingQuestions)}` : ''}\n\n### 影响与风险\n${plan.impact}\n\n### 验证计划\n${list(plan.validation)}\n\n以上为修改前方案，实际改动和验证结果将在完成后另行说明。`;
}
