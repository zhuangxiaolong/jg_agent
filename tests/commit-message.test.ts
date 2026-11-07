import test from 'node:test';
import assert from 'node:assert/strict';
import { appendJiraCommitUrl } from '../apps/desktop/src/main/commit-message';
import { commitSchema } from '../apps/desktop/src/main/security';

const issue = { url: 'https://jira.example.invalid/jira/browse/CD-435' };

test('Jira 会话在中文说明后附加任务地址，未关联会话保留原文', () => {
  const message = '修复设备过站报错\n\n保留人工补充的原因和验证结果。';
  assert.equal(appendJiraCommitUrl(message, issue), `${message}\n\nJira: ${issue.url}`);
  assert.equal(appendJiraCommitUrl(message), message);
});

test('完整任务地址已经存在时不重复，任务编号前缀相同不能误判', () => {
  for (const message of [`修复设备过站报错\n\nJira: ${issue.url}`, `修复设备过站报错 ${issue.url}`, `修复设备过站报错（${issue.url}）`, `修复设备过站报错 [任务](${issue.url})`]) {
    assert.equal(appendJiraCommitUrl(message, issue), message);
  }
  const otherIssue = `修复另一问题 ${issue.url}0`;
  assert.equal(appendJiraCommitUrl(otherIssue, issue), `${otherIssue}\n\nJira: ${issue.url}`);
});

test('最终提交说明与输入统一限制4000字，附加地址超长在提交前明确失败', () => {
  const suffix = `\n\nJira: ${issue.url}`;
  const message = '修'.repeat(4000 - suffix.length);
  assert.equal(appendJiraCommitUrl(message, issue).length, 4000);
  assert.throws(() => appendJiraCommitUrl(`${message}复`, issue), /附加 Jira 地址后.*4000/);
  assert.equal(commitSchema.safeParse({ message: appendJiraCommitUrl(message, issue), reviewedDocumentIds: [] }).success, true);
  assert.equal(commitSchema.safeParse({ message: '修'.repeat(4001), reviewedDocumentIds: [] }).success, false);
});
