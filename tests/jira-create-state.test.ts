import test from 'node:test';
import assert from 'node:assert/strict';
import { isJiraCreateSessionDisabled, isJiraSessionCreating } from '../apps/desktop/src/renderer/jira-create-state';

test('运行已有会话不会锁定 Jira 创建会话按钮', () => {
  assert.equal(isJiraSessionCreating(''), false);
  assert.equal(isJiraSessionCreating('session'), false);
  assert.equal(isJiraSessionCreating('send'), false);
  assert.equal(isJiraSessionCreating('jira-session'), true);
});

test('已选中 Jira 任务且条件完整时创建会话按钮可用', () => {
  const ready = { projectId: 'project', creating: false, changed: false, loading: false, hasSearch: true };
  assert.equal(isJiraCreateSessionDisabled(ready), false);
  assert.equal(isJiraCreateSessionDisabled({ ...ready, creating: true }), true);
  assert.equal(isJiraCreateSessionDisabled({ ...ready, projectId: '' }), true);
  assert.equal(isJiraCreateSessionDisabled({ ...ready, changed: true }), true);
  assert.equal(isJiraCreateSessionDisabled({ ...ready, loading: true }), true);
  assert.equal(isJiraCreateSessionDisabled({ ...ready, hasSearch: false }), true);
});
