import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardTextSchema, commitSchema, providerSchema, promptSchema, idSchema, jiraSchema, jiraProjectScopeSchema, jiraSearchSchema, requirementInputSchema, redact, claudeCredentialSchema, wecomTargetSchema, sessionCreateSchema, sessionOptionsSchema } from '../apps/desktop/src/main/security';

test('提交不再要求复核资料列表，保留旧请求兼容与提交参数校验', () => {
  assert.deepEqual(commitSchema.parse({ message: '提交本地修改' }), { message: '提交本地修改' });
  assert.equal(commitSchema.safeParse({ message: '兼容旧请求', reviewedDocumentIds: [] }).success, true);
  assert.equal(commitSchema.safeParse({ message: ' ' }).success, false);
  assert.equal(commitSchema.safeParse({ message: '提交', authorEmail: '错误邮箱' }).success, false);
  assert.equal(commitSchema.safeParse({ message: '提交', reviewedDocumentIds: ['../invalid'] }).success, false);
});
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

test('Claude 与企业微信凭据输入独立校验', () => {
  assert.equal(claudeCredentialSchema.safeParse('synthetic-claude-console-key').success, true);
  assert.equal(claudeCredentialSchema.safeParse('key\nleak').success, false);
  const target = { name: '测试群', purpose: 'team_group' as const, webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-key', enabled: true, eventPolicy: { onCompleted: true, onFailed: true, onError: true, onCancelled: false, onInterrupted: true } };
  assert.equal(wecomTargetSchema.safeParse(target).success, true);
  assert.equal(wecomTargetSchema.safeParse({ ...target, webhookUrl: 'http://example.invalid/send?key=bad' }).success, false);
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

test('会话创建默认可开发且无项目可直接开始，Jira 关联仍要求项目和任务', () => {
  const empty = sessionCreateSchema.parse({});
  assert.equal('mode' in empty, false);
  assert.equal(sessionCreateSchema.safeParse({}).success, true);
  assert.equal(sessionCreateSchema.safeParse({ jiraIssueKey: 'CD-435' }).success, false);
  assert.equal(sessionCreateSchema.safeParse({ jiraProjectKey: 'CD' }).success, false);
  assert.equal(sessionCreateSchema.safeParse({ projectId: 'a'.repeat(24) }).success, true);
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  assert.equal(sessionCreateSchema.parse({ workspaceId }).workspaceId, workspaceId);
  assert.equal(sessionCreateSchema.parse({ workspaceId }).projectId, undefined);
  assert.equal(sessionCreateSchema.safeParse({ workspaceId: '../invalid' }).success, false);
  assert.equal(sessionCreateSchema.safeParse({ workspaceId }).success, true);
  assert.equal(sessionCreateSchema.parse({ alias: '佛山天气测试' }).alias, '佛山天气测试');
  assert.equal(sessionCreateSchema.safeParse({ alias: '一\n二' }).success, false);
});

test('新会话默认 Claude Runtime，允许逐会话显式选择且拒绝无效 Runtime', () => {
  assert.equal(sessionCreateSchema.parse({}).runtimeKind, 'claude_agent_sdk');
  for (const runtimeKind of ['jinggong', 'codex', 'claude_agent_sdk'] as const) {
    assert.equal(sessionCreateSchema.parse({ runtimeKind }).runtimeKind, runtimeKind);
    assert.equal(sessionCreateSchema.parse({ projectId: 'a'.repeat(24), runtimeKind }).runtimeKind, runtimeKind);
  }
  for (const runtimeKind of ['unknown', '', null, 1]) assert.equal(sessionCreateSchema.safeParse({ runtimeKind }).success, false);
});

test('会话可单独选择 Runtime 和推理强度，模型变更仍要求完整配对', () => {
  for (const runtimeKind of ['jinggong', 'codex', 'claude_agent_sdk'] as const) {
    assert.deepEqual(sessionOptionsSchema.parse({ runtimeKind }), { runtimeKind });
    assert.equal(sessionOptionsSchema.safeParse({ runtimeKind, providerId: 'legacy-default' }).success, false);
    assert.equal(sessionOptionsSchema.safeParse({ runtimeKind, model: 'fixture-model' }).success, false);
  }
  assert.equal(sessionOptionsSchema.safeParse({}).success, false);
  assert.equal(sessionOptionsSchema.safeParse({ runtimeKind: 'unknown' }).success, false);
  assert.equal(sessionOptionsSchema.safeParse({ providerId: 'legacy-default', model: 'fixture-model' }).success, true);
  assert.deepEqual(sessionOptionsSchema.parse({ runtimeKind: 'codex', reasoningEffort: undefined }), { runtimeKind: 'codex', reasoningEffort: undefined });
});
