import type { JiraIssue } from '../../../../packages/domain/src';

export function appendJiraCommitUrl(message: string, issue?: Pick<JiraIssue, 'url'>): string {
  if (!issue?.url) return message;
  const urls = message.match(/https?:\/\/[^\s<>"`]+/g) ?? [];
  const included = urls.some(url => url.replace(/[),.;，。；）\]]+$/, '') === issue.url);
  const result = included ? message : `${message}\n\nJira: ${issue.url}`;
  if (result.length > 4000) throw new Error('附加 Jira 地址后提交说明超过4000字，请精简后重试');
  return result;
}
