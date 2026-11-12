import type { JiraIssue, Session } from './index';

const MAX_TITLE_LENGTH = 32;

function shortTitle(value: string): string {
  const characters = Array.from(value);
  return characters.length > MAX_TITLE_LENGTH ? `${characters.slice(0, MAX_TITLE_LENGTH - 1).join('').trimEnd()}…` : value;
}

export function initialSessionTitle(issue?: Pick<JiraIssue, 'key' | 'summary'>): string {
  const summary = issue?.summary.replace(/\s+/g, ' ').trim();
  return issue ? summary ? `${issue.key} · ${shortTitle(summary)}` : issue.key : '新会话';
}

/** 从用户任务提取短标题，不使用附加的本地路径、工具日志或模型输出。 */
export function sessionTitleFromPrompt(prompt: string): string | undefined {
  const text = prompt.split(/\r?\n?【本轮上传附件】/, 1)[0].replace(/```[\s\S]*?(?:```|$)/g, '').replace(/~~~[\s\S]*?(?:~~~|$)/g, '');
  for (const line of text.split(/\r?\n/)) {
    let title = line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)、]\s*)+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(`+|\*{1,2}|~~)(.+?)\1/g, '$2').replace(/(?<![\p{L}\p{N}_])(_{1,2})(.+?)\1(?![\p{L}\p{N}_])/gu, '$2')
      .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || /^(?:你好|您好|hi|hello)[！!，,。.\s]*$/i.test(title) || /^[-=]+$/.test(title)) continue;
    title = title.replace(/^(?:你好|您好)[，,！!\s]+/, '').replace(/^(?:请帮我|请协助|麻烦帮我|帮我)\s*/, '')
      .replace(/^请(?=修复|检查|分析|实现|调整|优化|新增|添加|修改|删除|排查|生成|设计|整理|说明|帮忙)\s*/, '')
      .replace(/^(?:please\s+)?(?:help me\s+(?:to\s+)?)/i, '').replace(/^please\s+/i, '').trim();
    title = title.split(/[。！？!?]/, 1)[0].replace(/[，,；;：:。.!?！？]+$/, '').trim();
    if (title) return shortTitle(title);
  }
  return undefined;
}

export function canGenerateSessionTitle(session: Session, projectName?: string): boolean {
  if (session.imported || session.titleSource === 'content') return false;
  const title = session.title.trim();
  if (title === '新会话' || title === '会话' || title === initialSessionTitle(session.jiraIssue)) return true;
  const prefix = `${session.jiraIssue ? session.jiraIssue.key + ' · ' : ''}${projectName ?? ''}`;
  if (projectName && (title === prefix || title === `${prefix} · 会话`)) return true;
  // 旧版默认日期标题；自定义名称（包括别名）保持原样。
  return /^(?:.+ · )?会话 \d{4}[/-]\d{2}[/-]\d{2} \d{2}:\d{2}$/.test(title);
}

export function contentTitledSession(session: Session, prompt: string, projectName?: string): Session {
  if (!canGenerateSessionTitle(session, projectName)) return session;
  const title = sessionTitleFromPrompt(prompt);
  if (!title) return session;
  return { ...session, title: session.jiraIssue ? `${session.jiraIssue.key} · ${title}` : title, titleSource: 'content' };
}

export function sessionDisplayTitle(session: Pick<Session, 'title' | 'alias' | 'jiraIssue' | 'titleSource'>): string {
  if (session.alias !== undefined) return session.alias;
  if (session.titleSource === 'content') return session.title;
  if (session.jiraIssue) {
    const summary = session.jiraIssue.summary.replace(/\s+/g, ' ').trim();
    return summary ? `${session.jiraIssue.key} · ${summary}` : session.jiraIssue.key;
  }
  return session.title.replace(/\s*·\s*(?:隔离开发|代码开发|只读分析)$/, '');
}
