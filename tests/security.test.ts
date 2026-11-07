import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardTextSchema, providerSchema, promptSchema, idSchema, jiraSchema, jiraProjectScopeSchema, jiraSearchSchema, requirementInputSchema, redact } from '../apps/desktop/src/main/security';
test('模型地址禁止非 HTTPS、URL 凭据与查询参数', () => {
  for (const baseUrl of ['http://example.com', 'https://user:pass@example.com', 'file:///secret', 'https://example.com?token=abc', 'https://example.com/#secret']) assert.equal(providerSchema.safeParse({ baseUrl, model: 'model' }).success, false);
  assert.equal(providerSchema.safeParse({ baseUrl: 'https://example.com/v1', model: 'model-1' }).success, true);
});
test('IPC 拒绝非法 ID、空输入与超长输入', () => {
  assert.equal(idSchema.safeParse('../../secret').success, false);
  assert.equal(promptSchema.safeParse(' ').success, false);
  assert.equal(promptSchema.safeParse('a'.repeat(50001)).success, false);
  assert.equal(clipboardTextSchema.parse('\t中文代码\n\n  '), '\t中文代码\n\n  ');
  assert.equal(clipboardTextSchema.safeParse({ text: '错误参数' }).success, false);
  assert.equal(clipboardTextSchema.safeParse('a'.repeat(2 * 1024 * 1024 + 1)).success, false);
});
test('错误与事件隐藏当前密钥和常见认证头', () => {
  const text = redact('failed sample-test-key Bearer abc123 sk-testkey123456', 'sample-test-key');
  assert.ok(!text.includes('sample-test-key') && !text.includes('abc123') && !text.includes('sk-testkey'));
});

test('Jira 接受 HTTP 项目页面并保留 contextpath，模型 HTTPS 边界不变', () => {
  const jira = jiraSchema.parse({ baseUrl: 'http://jira.example.invalid:8080/jira/projects/NEWDEVGROUP?selected=tasks#sheet', account: 'developer', projectKey: 'NEWDEVGROUP', dateFieldId: '11116' });
  assert.equal(jira.baseUrl, 'http://jira.example.invalid:8080/jira');
  for (const baseUrl of ['http://user:secret@jira.example.invalid', 'file:///private']) assert.equal(jiraSchema.safeParse({ baseUrl, account: 'developer' }).success, false);
  assert.equal(providerSchema.safeParse({ baseUrl: 'http://gateway.example.invalid/v1', model: 'model' }).success, false);
  assert.equal(jiraSchema.safeParse({ baseUrl: jira.baseUrl, account: 'user:other' }).success, false);
});

test('直接输入开发规范限制正文、标题和资料类型，保留完整合法正文', () => {
  const input = { title: 'MES5 开发规范', content: '修改前先阅读同类代码。', system: 'MES5' };
  assert.equal(requirementInputSchema.parse(input).content, input.content);
  assert.equal(requirementInputSchema.safeParse({ ...input, content: '中'.repeat(80001) }).success, false);
  assert.equal(requirementInputSchema.safeParse({ ...input, title: '一行\n第二行' }).success, false);
  assert.equal(requirementInputSchema.safeParse({ ...input, id: '../dictionary' }).success, false);
});

test('Jira 查询项目范围保留日报和本人条件并拒绝注入或伪造快照', () => {
  const query = { date: '2026-11-04', scope: 'daily', onlyMine: true, projectKey: '*' };
  assert.deepEqual(jiraSearchSchema.parse(query), query);
  assert.equal(jiraProjectScopeSchema.parse('CD'), 'CD');
  assert.equal(jiraProjectScopeSchema.parse(undefined), undefined);
  for (const projectKey of ['', 'CD" OR project = OTHER', '../CD', 'C'.repeat(65), { key: 'CD' }]) {
    assert.equal(jiraProjectScopeSchema.safeParse(projectKey).success, false);
    assert.equal(jiraSearchSchema.safeParse({ ...query, projectKey }).success, false);
  }
  assert.equal(jiraSearchSchema.safeParse({ ...query, issue: { key: 'CD-435' } }).success, false);
});
