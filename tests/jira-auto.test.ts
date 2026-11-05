import test from 'node:test';
import assert from 'node:assert/strict';
import type { JiraSavedQuery } from '../packages/domain/src';
import { cachedTodayQuery, jiraDateAt, JiraAutoRefreshGate, todayJiraInput } from '../apps/desktop/src/renderer/jira-auto';

function record(id: string, date: string, input: Partial<JiraSavedQuery['input']> = {}): JiraSavedQuery {
  return { id, input: { ...todayJiraInput(date), ...input }, savedAt: '2026-11-05T00:20:00Z', page: { issues: [], startAt: 0, maxResults: 50, total: 0, isLast: true, jql: '', timeZone: 'Pacific/Honolulu', fetchedAt: '2026-11-05T00:20:00Z' } };
}

test('今日采用 Jira 账户时区，跨本地午夜和夏令时日期均正确', () => {
  const instant = new Date('2026-11-05T00:20:00Z');
  assert.equal(jiraDateAt('Asia/Shanghai', instant), '2026-11-05');
  assert.equal(jiraDateAt('Pacific/Honolulu', instant), '2026-11-04');
  assert.equal(jiraDateAt('America/Los_Angeles', new Date('2026-11-01T08:30:00Z')), '2026-11-01');
  assert.equal(jiraDateAt('Pacific/Honolulu', new Date('2026-11-05T09:59:59Z')), '2026-11-04');
  assert.equal(jiraDateAt('Pacific/Honolulu', new Date('2026-11-05T10:00:00Z')), '2026-11-05');
  assert.throws(() => jiraDateAt('无效时区', instant));
});

test('只恢复当日全部项目仅本人首页，昨日或手动历史仍保留供选择', () => {
  const records = [record('yesterday', '2026-11-03'), record('recent', '2026-11-04', { scope: 'recent' }), record('project', '2026-11-04', { projectKey: 'CD' }), record('all-users', '2026-11-04', { onlyMine: false }), record('page-two', '2026-11-04', { startAt: 50 }), record('today', '2026-11-04')];
  assert.equal(cachedTodayQuery(records, new Date('2026-11-05T00:20:00Z'))?.id, 'today');
  assert.equal(cachedTodayQuery(records, new Date('2026-11-05T00:20:00Z'), 'Asia/Shanghai'), undefined);
  assert.equal(records.length, 6);
  assert.deepEqual(todayJiraInput('2026-11-04'), { date: '2026-11-04', projectKey: '*', scope: 'daily', onlyMine: true, startAt: 0 });
});

test('每个 Jira 日只自动尝试一次，focus或失败不重试，手动条件暂停直到显式恢复', () => {
  const gate = new JiraAutoRefreshGate();
  assert.equal(gate.claim('2026-11-04'), true);
  assert.equal(gate.claim('2026-11-04'), false);
  assert.equal(gate.claim('2026-11-05'), true);
  gate.pause();
  assert.equal(gate.active, false);
  assert.equal(gate.claim('2026-11-06'), false);
  assert.equal(gate.claim('2026-11-05', true), false);
  gate.resume();
  assert.equal(gate.claim('2026-11-05', true), true);
  assert.equal(gate.claim('2026-11-05'), false);
  assert.equal(gate.claim('2026-11-06'), true);
});
