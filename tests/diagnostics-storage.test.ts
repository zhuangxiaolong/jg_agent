import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDiagnosticTriage, saveDiagnosticTriageProposal, type DiagnosticCase, type DiagnosticTriage } from '../packages/domain/src/diagnostics';
import type { DeliveryProject } from '../packages/domain/src/delivery-workbench';
import { LocalStore } from '../packages/storage/src/index';

test('诊断档案支持负责人、创建人筛选、严重程度排序和交付工单反查', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-diagnostics-storage-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const projectId = randomUUID();
  const issueId = randomUUID();
  const now = '2026-11-24T00:00:00.000Z';
  const project: DeliveryProject = {
    id: projectId, name: '诊断测试项目', customerName: '测试客户', systemType: 'MES6', productVersions: [],
    stage: '实施', status: 'active', members: [], createdAt: now, updatedAt: now,
  };
  const makeCase = (input: Pick<DiagnosticCase, 'priority' | 'assigneeLabel' | 'reporterLabel' | 'updatedAt'> & Partial<Pick<DiagnosticCase, 'deliveryIssueId' | 'issueCategory'>>): DiagnosticCase => ({
    id: randomUUID(), code: `ZD-${randomUUID().slice(0, 8)}`, title: '过站校验异常', symptom: '工单过站时出现了与预期不一致的校验结果。',
    product: 'MES6', module: 'ProductionManagement', issueCategory: 'defect', status: 'new', planRevision: 0,
    deliveryProjectId: projectId, createdAt: now, ...input,
  });
  const records = [
    makeCase({ priority: 'medium', assigneeLabel: '张工', reporterLabel: '李工', updatedAt: '2026-11-23T00:00:00.000Z', deliveryIssueId: issueId }),
    makeCase({ priority: 'critical', assigneeLabel: '王工', reporterLabel: '李工', updatedAt: '2026-11-22T00:00:00.000Z' }),
    makeCase({ priority: 'high', assigneeLabel: '张工', reporterLabel: '赵工', updatedAt: '2026-11-21T00:00:00.000Z', issueCategory: 'configuration' }),
  ];

  try {
    store.saveDeliveryProject(project);
    store.saveDiagnosticBundle({ cases: records });

    assert.deepEqual(store.queryDiagnosticCases({ assigneeLabel: '张工', reporterLabel: '李工', deliveryProjectId: projectId }).map(item => item.id), [records[0].id]);
    assert.equal(store.queryDiagnosticCases({ module: 'Production', issueCategory: 'defect' }).length, 2);
    assert.deepEqual(store.queryDiagnosticCases({ sortBy: 'priority' }).map(item => item.priority), ['critical', 'high', 'medium']);
    assert.equal(store.findDiagnosticCaseByDeliveryIssue(projectId, issueId)?.id, records[0].id);
    assert.equal(store.findDiagnosticCaseByDeliveryIssue(projectId, randomUUID()), undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('AI 分诊先保存为草稿，只有人工选择后才更新档案字段', () => {
  const item: DiagnosticCase = {
    id: randomUUID(), code: 'ZD-TRIAGE-01', title: '过站校验异常', symptom: '工单过站时出现了与预期不一致的校验结果。',
    product: 'MES6', productVersion: '6.2', module: 'ProductionManagement', businessProcess: '工单过站',
    issueCategory: 'defect', priority: 'medium', impactScope: '单工位', status: 'triaging', planRevision: 0,
    createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z',
  };
  const proposal: DiagnosticTriage = {
    summary: '可能是参数配置异常', product: 'MES5', productVersion: '5.8', module: 'SFCS', businessProcess: '生产报工',
    issueCategory: 'configuration', prioritySuggestion: 'high', impactScopeSuggestion: '单项目',
    knownFacts: [], missingInformation: [], hypotheses: [],
  };
  const draft = saveDiagnosticTriageProposal(item, proposal, 'diagnosing', 'run-1', '2026-11-24T00:01:00.000Z');

  assert.deepEqual(
    [draft.product, draft.productVersion, draft.module, draft.businessProcess, draft.issueCategory, draft.priority, draft.impactScope],
    ['MES6', '6.2', 'ProductionManagement', '工单过站', 'defect', 'medium', '单工位'],
  );
  assert.equal(draft.triage?.product, 'MES5');

  const confirmed = applyDiagnosticTriage(draft, { priority: 'high', module: 'SFCS' }, '2026-11-24T00:02:00.000Z');
  assert.equal(confirmed.priority, 'high');
  assert.equal(confirmed.module, 'SFCS');
  assert.equal(confirmed.product, 'MES6');
  assert.equal(confirmed.productVersion, '6.2');
  assert.equal(confirmed.businessProcess, '工单过站');
  assert.equal(confirmed.issueCategory, 'defect');
  assert.equal(confirmed.impactScope, '单工位');
  assert.equal(confirmed.triage?.product, 'MES5');
});
