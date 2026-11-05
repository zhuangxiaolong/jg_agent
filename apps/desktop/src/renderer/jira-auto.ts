import type { JiraSavedQuery, JiraSearchInput } from '../../../../packages/domain/src';

export function jiraDateAt(timeZone: string, instant = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function todayJiraInput(date: string): JiraSearchInput {
  return { date, projectKey: '*', scope: 'daily', onlyMine: true, startAt: 0 };
}

export function cachedTodayQuery(records: JiraSavedQuery[], instant = new Date(), timeZone?: string) {
  return records.find(record => {
    if (record.input.projectKey !== '*' || (record.input.scope ?? 'daily') !== 'daily' || !record.input.onlyMine || (record.input.startAt ?? 0) !== 0) return false;
    try { return record.input.date === jiraDateAt(timeZone || record.page.timeZone, instant); }
    catch { return false; }
  });
}

// 面板在主窗口生命周期内保持挂载；同一 Jira 日期仅自动尝试一次，失败也不循环重试。
export class JiraAutoRefreshGate {
  private attempted = new Set<string>();
  private enabled = true;
  get active() { return this.enabled; }
  pause() { this.enabled = false; }
  resume() { this.enabled = true; }
  claim(date: string, force = false) {
    if (!this.enabled || !force && this.attempted.has(date)) return false;
    this.attempted.add(date);
    return true;
  }
}
