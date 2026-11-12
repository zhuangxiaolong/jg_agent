import type { JiraIssue } from './index';

/** 仅按 Jira 类型识别需求和优化，不从标题或描述推断准入范围。 */
export function requiresRequirementAdmission(issue?: Pick<JiraIssue, 'issueType'>): boolean {
  const issueType = issue?.issueType.normalize('NFKC').trim().toLowerCase();
  return issueType !== undefined && ['需求', '优化', 'requirement', 'story', 'improvement'].includes(issueType);
}
