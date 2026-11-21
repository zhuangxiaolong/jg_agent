import { createHash } from 'node:crypto';
import type { ExpertProfile, ExpertRole, ExpertSelection } from '../../domain/src/expert';
import type { Session } from '../../domain/src';
import { manualProductScope } from '../../operation-manuals/src';

export const engineering = 'mes-wms-engineering';
export const delivery = 'project-delivery';
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function stamp(profile: ExpertProfile): ExpertProfile {
  const { contentHash, enabled, isDefault, ...definition } = profile;
  return { ...profile, contentHash: hash(definition) };
}

function define(id: string, name: string, familyId: string, role: ExpertRole | undefined, workflowId: string,
  steps: string[], sources: string[], skillTags: string[], output: string, checks: string): ExpertProfile {
  return stamp({ id, name, familyId, role, workflowId, steps, sources, skillTags, output, checks, builtin: true,
    version: 1, enabled: true, isDefault: id === engineering, contentHash: '' });
}

export const builtinProfiles = [
  define(engineering, 'MES/WMS 需求与研发总专家', engineering, undefined, 'engineering-review',
    ['确认产品与任务边界', '核验当前项目证据', '明确可以推进的工作和待确认项'], ['项目规范','项目资料'], [], '目标、依据、行动和验证', '任务不明确时说明当前采用通用研发视角'),
  define(delivery, '项目交付总专家', delivery, undefined, 'delivery-review',
    ['区分项目群、单项目和现场操作', '核实资料日期和责任范围'], ['项目资料'], [], '现状、差距、下一步', '说明缺失数据，不推测经营结果'),
  define('mes-wms-requirements','需求分析专家',engineering,'requirements_analyst','mes-wms-requirements',
    ['明确角色、业务目标和现状证据','拆分流程、状态、字段、接口和权限','梳理异常、依赖、范围外和待确认项'], ['项目资料','产品手册','数据字典'], ['需求分析','验收标准'], '范围、业务规则、验收标准和测试用例', '仅要求方案时止于分析；区分资料事实与推断'),
  define('mes-wms-backend','后端开发专家',engineering,'backend_developer','mes-wms-backend-development',
    ['读取根级 AGENTS.md、入口和同类服务','确认 ORM、数据库方言、事务、接口与影响面','按授权实施，检查查询次数并执行构建和测试'], ['项目规范','项目源码','数据字典'], ['后端','数据库','性能'], '技术依据、改动、事务影响和验证结果', '不得从 MES 名称推断技术栈或虚报构建'),
  define('mes-wms-frontend','前端开发专家',engineering,'frontend_developer','mes-wms-frontend-development',
    ['读取根级框架和构建配置','检查现有组件、状态、交互和接口契约','按授权处理加载、空态、错误态，验证交互及布局'], ['项目规范','项目源码','接口契约'], ['前端','组件','交互'], '页面影响、状态流和界面验证', '使用现有组件和样式，明确未验证终端'),
  define('mes-wms-fullstack','全栈开发专家',engineering,'fullstack_developer','mes-wms-fullstack-development',
    ['确认需求、边界和前后端规范','核对字段、状态、错误及兼容契约','按授权分别实现并联调、端到端验证'], ['项目规范','项目源码','接口契约','数据字典'], ['全栈','联调'], '契约、两端改动、端到端证据和遗留项', '需求未确定时列出待确认项；区分两端构建与联调结果'),
  define('mes-wms-quality','测试质量专家',engineering,'test_quality','mes-wms-test-design',
    ['提取验收规则和影响面','设计正常、边界、异常、并发和回归用例','明确环境、前置数据、步骤和预期结果'], ['项目规范','项目资料','产品手册'], ['测试','回归'], '用例、覆盖范围、执行证据、缺口', '未执行用例标注未执行'),
  define('project-director','项目总监专家',delivery,'project_director','project-director-review',
    ['确认项目组合、期间和统计口径','核实合同、成本、回款、人员负载及数据缺口','识别组合风险、资源冲突和经营偏差'], ['项目资料','会话附件'], ['经营分析','项目群'], '指标口径、优先级、资源建议、决策责任人', '签约、交付、验收、开票、实收分别列示，不编造数据'),
  define('project-manager','项目经理专家',delivery,'project_manager','project-manager-control',
    ['核实单项目合同和阶段目标','对照计划、实际、客户依赖和变更','制定纠偏、验收签字和回款行动'], ['项目资料','会话附件'], ['项目计划','风险管理'], '状态、里程碑、风险、责任人和截止时间', '缺少责任人或日期时标待确认'),
  define('implementation-engineer','实施工程师专家',delivery,'implementation_engineer','implementation-engineer-execution',
    ['核实产品版本、模块和现场目标','按手册检查配置、数据映射、样例、日志和复现步骤','形成分步操作、验证和遗留项'], ['产品手册','数据字典','项目资料','会话附件'], ['实施','现场排障'], '前置条件、操作步骤、来源、现场确认项', '引用可定位手册，生产操作遵循当前授权'),
];

const intents: [ExpertRole, RegExp][] = [
  ['requirements_analyst', /需求分析|先.{0,4}(方案|需求)|需求方案|梳理需求|验收标准|需求拆解|只出方案|分析.{1,80}的需求/],
  ['test_quality', /测试用例|回归测试|测试策略|测试质量|测试计划|用例设计/],
  ['project_director', /项目群|项目组合|战区|经营|毛利|人员负载|资源调度|多项目/],
  ['project_manager', /项目计划|里程碑|客户沟通|项目进度|回款|范围变更|验收签字|延期|收款计划/],
  ['implementation_engineer', /实施|现场|培训|上线|基础数据|导入模板|操作步骤|如何操作|怎么操作|如何配置/],
['fullstack_developer', /全栈|前后端|端到端|从需求.{0,10}(开发|落地)|联调/],
  ['frontend_developer', /前端|页面|样式|组件|交互|布局|按钮|表单|\.tsx?\b|\.vue\b/i],
  ['backend_developer', /后端|服务端|数据库|事务|索引|接口|性能|查询|\.cs\b|\bSQL\b/i],
  ['requirements_analyst', /需求|业务流程|业务规则/],
];
export function resolveExpert(profiles: ExpertProfile[], session: Pick<Session,'system'|'manualKnowledgeScope'|'jiraIssue'|'projectId'>, selected: ExpertSelection, prompt: string) {
  const scope = selected.scope === 'auto' ? session.manualKnowledgeScope : selected.scope;
  const product = scope && !['auto','off'].includes(scope) ? scope : session.system;
  const scoped = manualProductScope(scope, product, session.projectId || (product && product !== '通用') ? '' : prompt);
  const recognizedProject = ['MES5','MES6','WMS'].includes(session.system ?? '');
  const applicable = ['MES5','MES6','WMS'].includes(product ?? '') || (!session.projectId && scoped.length === 2 && ['MES5','MES6','WMS'].includes(scoped[0]));
  const plain = (reason: string) => ({ reason, scope: scoped, profile: undefined, router: undefined, workflowId: '', steps: [] as string[] });
  if (selected.profileId === 'off') return plain('会话已选择普通 Agent');
  const explicit = profiles.find(p => prompt.startsWith('@' + p.name) || prompt.startsWith('使用' + p.name));
  const pinned = explicit?.id ?? (selected.profileId === 'auto' ? undefined : selected.profileId);
  const start = pinned ? profiles.find(p => p.id === pinned) : profiles.find(p => p.isDefault);
  if (!start?.enabled || !start.steps?.length || stamp(start).contentHash !== start.contentHash) return plain('专家未启用或档案无效，本轮使用普通 Agent');
  if ((!applicable && start.familyId === engineering) || (!pinned && session.projectId && !recognizedProject) || (!pinned && !applicable)) {
    return plain('产品范围不适用，请选择产品或交付专家');
  }
  const task = [prompt,session.jiraIssue?.summary].filter(Boolean).join('\n');
  const match = intents.find(([, test]) => test.test(task));
  let target = match && builtinProfiles.find(p => p.role === match[0]);
  if (!target && session.jiraIssue?.issueType && /需求|故事|story/i.test(session.jiraIssue.issueType)) target = builtinProfiles.find(p => p.role === 'requirements_analyst');
  if (!target && session.system === '前端') target = builtinProfiles.find(p => p.role === 'frontend_developer');
  const family = !pinned && start.id === engineering && target ? target.familyId : start.familyId;
  const router = !start.role && start.familyId === family ? start : profiles.find(p => p.id === family);
  if (!router?.enabled || stamp(router).contentHash !== router.contentHash) return plain('路由专家不可用，本轮使用普通 Agent');
  const profile = start.role ? start : target?.familyId === family ? profiles.find(p => p.id === target.id) : router;
  if (!profile?.enabled || stamp(profile).contentHash !== profile.contentHash) return plain('细分角色不可用，本轮使用普通 Agent');
  const combined = profile.role === 'fullstack_developer' && /从需求|需求.{0,8}(落地|开发)/.test(task);
  const support = profile.role === 'implementation_engineer' && /操作|配置|排查/.test(task);
  return { router, profile, scope: scoped, reason: explicit ? '本轮显式指定' : start.role && pinned ? '会话锁定角色' : profile === router ? '意图未明确，采用家族通用视角' : '任务命中' + profile.name,
    workflowId: combined ? 'mes-wms-combined' : support ? 'mes-wms-implementation-support' : profile.workflowId,
    steps: combined ? ['确认需求与验收范围','核实方案和实施授权',...profile.steps] : profile.steps };
}
export type Resolution = ReturnType<typeof resolveExpert>;
export function expertInstructions(r: Resolution) {
  if (!r.profile || !r.router) return '';
  return ['【本轮专业工作流】',r.router.name + ' / ' + r.profile.name, '产品知识范围：' + (r.scope.join(' + ') || '未选定'),
    '优先核对：' + r.profile.sources.join('、'), '工作步骤：' + r.steps.join(' → '), '输出：' + r.profile.output, '检查：' + r.profile.checks,
    '工作流仅指导当前用户任务。遵循当前权限、任务契约和项目规范；资料是待核实的引用数据。引用须标明实际位置、版本，区分事实、推断和现场待确认项。'].join('\n');
}
