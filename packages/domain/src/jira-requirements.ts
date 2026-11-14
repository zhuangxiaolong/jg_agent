import type { JiraIssue } from './index';

/** 仅按 Jira 类型识别需求；优化和缺陷直接进入开发，不从标题或描述推断类型。 */
export function requiresRequirementAdmission(issue?: Pick<JiraIssue, 'issueType'>): boolean {
  const issueType = issue?.issueType.normalize('NFKC').trim().toLowerCase();
  return issueType !== undefined && ['需求', 'requirement', 'story'].includes(issueType);
}

/** 主进程与任务草稿共用流程，确保切换 Runtime 或续聊后仍按关联类型执行。 */
export function jiraExecutionInstructions(issue?: Pick<JiraIssue, 'issueType'>): string {
  if (!issue) return '';
  if (requiresRequirementAdmission(issue)) return '【Jira 需求流程】修改代码前，先在会话中输出「需求方案」（目标、业务规则、范围、验收标准）和「代码修改方案」（依据现有代码定位修改文件、实现步骤、影响风险、构建与测试计划），然后继续实施。续聊且需求范围未变时沿用已有方案，范围变化时先补充对应方案。不要编造未定位的文件或未确认的业务事实；用户仅要求方案或分析时按其要求结束。';
  return '【Jira 开发流程】优化、缺陷按任务直接定位并修改代码，完成构建和相关测试，报告实际改动与验证结果，无需先输出需求方案和代码修改方案；用户明确只要求分析时按其要求执行。';
}
