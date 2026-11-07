/** Jira 面板仅在发起 Jira 会话创建请求时进入忙碌状态。 */
export function isJiraSessionCreating(busy: string): boolean {
  return busy === 'jira-session';
}

export function isJiraCreateSessionDisabled(state: {
  projectId: string;
  creating: boolean;
  changed: boolean;
  loading: boolean;
  hasSearch: boolean;
}): boolean {
  return !state.projectId || state.creating || state.changed || state.loading || !state.hasSearch;
}
