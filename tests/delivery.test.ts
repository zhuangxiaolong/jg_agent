import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strFromU8, unzipSync } from 'fflate';
import { buildDeliveryPackage, deliveryHash, nextDeliveryRevision } from '../packages/delivery/src';
import type { DeliverySnapshot } from '../packages/domain/src/delivery';
import type { DeliveryPackageRecord, JiraIssue, JiraWritebackRecord, TaskEvidenceRecord } from '../packages/domain/src';
import { registerDeliveryIpc, type DeliveryIpcDependencies } from '../apps/desktop/src/main/delivery-ipc';
import { JiraConnector, type JiraTransport } from '../packages/jira-connector/src';

const project = { id: '123456789012345678901234', name: '合成交付项目', path: 'D:\\synthetic-project', branch: 'test' };
const issue: JiraIssue = { id: '1001', key: 'MES6-123', summary: '合成任务', description: '明确合成的离线回归数据', status: '进行中', issueType: '任务', updated: '2026-11-15T01:00:00Z', url: 'https://jira.example.invalid/browse/MES6-123', attachments: [], fetchedAt: '2026-11-15T01:00:00Z' };
function snapshot(): DeliverySnapshot { return { schemaVersion: 1, project: { id: project.id, name: project.name }, taskId: 'task-1', goal: '完成物料校验', implementationNotes: '测试 999 项通过（仅为用户自述）', remainingItems: '待客户确认业务范围', tasks: [], plans: [], evidence: [], verificationRuns: [], impacts: [], reviews: [], capturedAt: '2026-11-15T01:00:00Z' }; }

test('交付 ZIP 离线可读，缺失验证保持未知且 manifest 对每个文件记录真实 SHA256', () => {
  const result = buildDeliveryPackage(snapshot(), { revision: 1 });
  const files = unzipSync(result.bytes);
  assert.equal(result.sha256, deliveryHash(result.bytes));
  assert.match(strFromU8(files['验证报告/验证汇总.md']), /未提供 \/ 未执行/);
  assert.doesNotMatch(strFromU8(files['验证报告/验证汇总.md']), /999|passed/);
  assert.match(result.markdown, /用户补充说明（未经平台验证）/);
  for (const file of result.manifest.files) { assert.equal(deliveryHash(files[file.name]), file.sha256); assert.equal(files[file.name].byteLength, file.size); }
  assert.equal(result.manifest.sourceSnapshotSha256, deliveryHash(files['evidence-snapshot.json']));
  assert.equal(buildDeliveryPackage(snapshot(), { revision: 1 }).sha256, result.sha256);
});

test('真实验证 Run 的状态和解析计数逐项保留，失败、未知和静态建议不变成通过', () => {
  const source = snapshot();
  source.verificationRuns.push({ runId: 'real-run', projectId: project.id, projectName: project.name, sessionId: 's1', runType: 'test', status: 'failed', processStatus: 'completed', exitCode: 1, startedAt: source.capturedAt, finishedAt: source.capturedAt, durationMs: 20, stdoutBytes: 10, stderrBytes: 10, stdoutTruncated: false, stderrTruncated: false, limitations: ['仅合成测试'], headSha: 'a'.repeat(40), testReport: { total: 3, passed: 1, failed: 1, skipped: 1, errors: 0, status: 'parsed' } });
  const output = buildDeliveryPackage(source, { revision: 1 });
  const report = strFromU8(unzipSync(output.bytes)['验证报告/验证汇总.md']);
  assert.match(report, /real-run.*failed.*退出码 1.*总数 3 \/ 通过 1 \/ 失败 1 \/ 跳过 1/);
  assert.match(report, new RegExp('a'.repeat(40)));
  source.verificationRuns[0].status = 'stale';
  source.evidence.push({ id: 'historical-evidence', evidenceType: 'build', source: 'process', status: 'passed', integrityVerified: true, exitCode: 0 } as TaskEvidenceRecord);
  const historical = strFromU8(unzipSync(buildDeliveryPackage(source, { revision: 2 }).bytes)['验证报告/验证汇总.md']);
  assert.match(historical, /real-run.*stale/);
  assert.match(historical, /历史证据 historical-evidence.*入库时状态 passed.*当前适用性未复核，不代表当前代码通过/);
});

test('附件默认排除，凭据与路径穿越始终排除，客户文件须单独勾选', () => {
  const attachments = [{ name: '客户原始物料.xlsx', bytes: Buffer.from('synthetic'), kind: 'customer_source' as const }, { name: '.env', bytes: Buffer.from('synthetic'), kind: 'report' as const }, { name: '../escape', bytes: Buffer.from('synthetic'), kind: 'report' as const }, { name: '测试报告.txt', bytes: Buffer.from('synthetic'), kind: 'report' as const }];
  const defaults = buildDeliveryPackage(snapshot(), { revision: 1 }, attachments);
  assert.equal(defaults.manifest.excluded.length, 4);
  const explicit = buildDeliveryPackage(snapshot(), { revision: 2, includeAttachments: true }, attachments);
  assert.deepEqual(Object.keys(unzipSync(explicit.bytes)).filter(name => name.startsWith('附件/')), ['附件/测试报告.txt']);
  assert.equal(explicit.manifest.excluded.length, 3);
  assert.throws(() => buildDeliveryPackage(snapshot(), { revision: 0 }), /修订/);
  assert.equal(nextDeliveryRevision([{ taskId: 'task-1', revision: 2 }, { taskId: 'other', revision: 100 }] as DeliveryPackageRecord[], 'task-1'), 3);
});

function setup(root: string) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const packages: DeliveryPackageRecord[] = [];
  const records: JiraWritebackRecord[] = [];
  const mutations: Array<{ kind: string; key: string; content: string }> = [];
  let currentIssue = structuredClone(issue); let scope = 'synthetic-account-scope'; let offline = false; let target = ''; let fingerprint = 'synthetic-diff'; let mutationError = '';
  const store: DeliveryIpcDependencies['store'] = {
    listSessions: () => [], listAgentTasks: () => [], listTaskEvidence: () => [], listTaskPlans: () => [], listTaskPlanSteps: () => [], listImpactReports: () => [], listReviewRuns: () => [], listReviewFindings: () => [],
    listDeliveryPackages: taskId => packages.filter(item => !taskId || item.taskId === taskId), saveDeliveryPackage: value => { const index = packages.findIndex(item => item.id === value.id); if (index >= 0) packages[index] = structuredClone(value); else packages.unshift(structuredClone(value)); },
    listJiraWritebackRecords: key => records.filter(item => !key || item.jiraKey === key), saveJiraWritebackRecord: value => { const index = records.findIndex(item => item.id === value.id); if (index >= 0) records[index] = structuredClone(value); else records.unshift(structuredClone(value)); },
    getJira: () => ({ baseUrl: 'https://jira.example.invalid', account: '合成执行账号', hasPassword: true }),
  };
  registerDeliveryIpc({ handle: (channel, fn) => handlers.set(channel, fn), store, project: value => { if (value !== project.id) throw new Error('项目不存在'); return project; }, git: { projectState: async () => ({ branch: 'test', commits: [{ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'fixture', date: '2026-11-15', message: '合成提交' }], remotes: [], dirty: true }), changesSince: async () => ({ baseCommit: 'a'.repeat(40), head: 'a'.repeat(40), baseIsAncestor: true, changes: [], truncated: false, fingerprint }) }, selectOutput: async name => { target = join(root, name); return target; }, jira: () => ({ getIssue: async () => { if (offline) throw new Error('合成离线'); return structuredClone(currentIssue); }, addComment: async (key, content) => { mutations.push({ kind: 'comment', key, content }); if (mutationError) throw new Error(mutationError); return { id: 'comment-123' }; }, uploadAttachment: async (key, name) => { mutations.push({ kind: 'attachment', key, content: name }); return { id: 'attachment-456', name }; } }), jiraScope: () => scope, assertJiraScope: checked => { if (scope !== checked) throw new Error('连接已变化'); }, assertCleanText: value => { if (value.includes('synthetic-secret-should-block')) throw new Error('检测到合成密钥'); } });
  return { call: async (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args), packages, records, mutations, offline: () => { offline = true; }, updateIssue: () => { currentIssue = { ...currentIssue, updated: '2026-11-15T02:00:00Z' }; }, changeScope: () => { scope = 'another-synthetic-account'; }, changeDiff: () => { fingerprint = 'changed-diff'; }, failWrite: () => { mutationError = 'synthetic-secret-should-block'; }, target: () => target };
}

test('本地 IPC 离线仍能生成独立版本，默认不依赖 Jira、不覆盖历史 ZIP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-delivery-'));
  try {
    const fixture = setup(root); fixture.offline();
    const preview = await fixture.call('delivery:preview', { projectId: project.id, jiraKey: issue.key });
    assert.match(preview.snapshot.jiraWarning, /离线/);
    const first = await fixture.call('delivery:export', preview.id);
    const second = await fixture.call('delivery:export', preview.id);
    assert.equal(first.revision, 1); assert.equal(second.revision, 2); assert.notEqual(first.outputPath, second.outputPath);
    assert.equal(deliveryHash(await readFile(first.outputPath)), first.outputSha256);
    assert.equal(fixture.packages.length, 2); assert.equal(fixture.mutations.length, 0);
    await assert.rejects(fixture.call('delivery:preview', { projectId: project.id, verificationRuns: [{ status: 'passed' }] }), /unrecognized|Unrecognized/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Jira 预览不写入，逐项显式确认后只写一次，并保存真实回执', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-delivery-confirm-'));
  try {
    const fixture = setup(root);
    const preview = await fixture.call('delivery:preview', { projectId: project.id, jiraKey: issue.key });
    const confirmation = await fixture.call('delivery:jira-preview', { previewId: preview.id, operation: 'comment', comment: '合成评论：仅本地 fixture' });
    assert.equal(fixture.mutations.length, 0);
    await assert.rejects(fixture.call('delivery:jira-confirm', { recordId: confirmation.record.id, requestHash: confirmation.record.requestHash, confirmed: false }));
    const result = await fixture.call('delivery:jira-confirm', { recordId: confirmation.record.id, requestHash: confirmation.record.requestHash, confirmed: true });
    assert.equal(result.resultStatus, 'success'); assert.equal(result.responseId, 'comment-123'); assert.equal(fixture.mutations.length, 1);
    await assert.rejects(fixture.call('delivery:jira-confirm', { recordId: confirmation.record.id, requestHash: confirmation.record.requestHash, confirmed: true }), /已使用/);
    assert.equal(fixture.mutations.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Jira 需求或账号在预览后变化会阻断回写，本地交付包保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-delivery-stale-'));
  try {
    for (const mutate of ['updateIssue', 'changeScope'] as const) {
      const fixture = setup(root);
      const preview = await fixture.call('delivery:preview', { projectId: project.id, jiraKey: issue.key });
      const record = await fixture.call('delivery:export', preview.id);
      const confirmation = await fixture.call('delivery:jira-preview', { previewId: preview.id, operation: 'comment', comment: '合成评论' });
      fixture[mutate]();
      const result = await fixture.call('delivery:jira-confirm', { recordId: confirmation.record.id, requestHash: confirmation.record.requestHash, confirmed: true });
      assert.equal(result.resultStatus, 'failed'); assert.match(result.errorMessage, /保留/); assert.equal(fixture.mutations.length, 0);
      assert.equal(deliveryHash(await readFile(record.outputPath)), record.outputSha256);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('并发确认同一预览只发送一次；敏感评论和错误明细不进入回写记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-delivery-concurrent-'));
  try {
    const fixture = setup(root);
    const preview = await fixture.call('delivery:preview', { projectId: project.id, jiraKey: issue.key });
    await assert.rejects(fixture.call('delivery:jira-preview', { previewId: preview.id, operation: 'comment', comment: 'synthetic-secret-should-block' }), /密钥/);
    assert.equal(fixture.records.length, 0);
    const confirmation = await fixture.call('delivery:jira-preview', { previewId: preview.id, operation: 'comment', comment: '合成并发评论' });
    const input = { recordId: confirmation.record.id, requestHash: confirmation.record.requestHash, confirmed: true };
    const results = await Promise.allSettled([fixture.call('delivery:jira-confirm', input), fixture.call('delivery:jira-confirm', input)]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1); assert.equal(fixture.mutations.length, 1);
    const failed = await fixture.call('delivery:jira-preview', { previewId: preview.id, operation: 'comment', comment: '合成失败评论' });
    fixture.failWrite();
    const result = await fixture.call('delivery:jira-confirm', { recordId: failed.record.id, requestHash: failed.record.requestHash, confirmed: true });
    assert.equal(result.resultStatus, 'failed'); assert.match(result.errorMessage, /敏感错误明细已隐藏/); assert.doesNotMatch(JSON.stringify(fixture.records), /synthetic-secret-should-block/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('包文件被替换不得上传；Git 指纹变化不得导出旧预览；取消不发送 Jira', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-delivery-integrity-'));
  try {
    const fixture = setup(root);
    const preview = await fixture.call('delivery:preview', { projectId: project.id, jiraKey: issue.key });
    const record = await fixture.call('delivery:export', preview.id);
    const confirmation = await fixture.call('delivery:jira-preview', { previewId: preview.id, operation: 'attachment', packageId: record.id });
    await writeFile(record.outputPath, '合成篡改');
    const result = await fixture.call('delivery:jira-confirm', { recordId: confirmation.record.id, requestHash: confirmation.record.requestHash, confirmed: true });
    assert.equal(result.resultStatus, 'failed'); assert.match(result.errorMessage, /发生变化/); assert.equal(fixture.mutations.length, 0);
    const cancel = await fixture.call('delivery:jira-preview', { previewId: preview.id, operation: 'comment', comment: '合成评论' });
    assert.equal((await fixture.call('delivery:jira-cancel', cancel.record.id)).resultStatus, 'cancelled');
    fixture.changeDiff(); await assert.rejects(fixture.call('delivery:export', preview.id), /Git 变更已更新/);
    assert.equal(fixture.mutations.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('JiraConnector 独立评论复用认证传输，仅合成 transport，必须返回真实评论 ID', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const transport: JiraTransport = async (url, init) => { requests.push({ url: String(url), init }); return new Response(JSON.stringify({ id: '601' }), { status: 201, headers: { 'content-type': 'application/json' } }); };
  const connector = new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password: 'synthetic-fixture-password', projectKey: 'MES6' }, transport);
  assert.deepEqual(await connector.addComment('MES6-123', '合成评论'), { id: '601' });
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://jira.example.invalid/rest/api/2/issue/MES6-123/comment');
  assert.equal(requests[0].init?.method, 'POST'); assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { body: '合成评论' });
  await assert.rejects(connector.addComment('bad/key', '合成评论'));
  const missing = new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password: 'synthetic-fixture-password' }, async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(missing.addComment('MES6-123', '合成评论'), /未返回评论 ID/);
});
