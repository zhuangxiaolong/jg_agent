import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiagnosticCase } from '../packages/domain/src/diagnostics';
import type { DeliveryIssue, DeliveryProject } from '../packages/domain/src/delivery-workbench';
import { LocalStore } from '../packages/storage/src';
import { registerDeliveryWorkbenchIpc } from '../apps/desktop/src/main/delivery-workbench-ipc';
import { registerDiagnosticsIpc } from '../apps/desktop/src/main/diagnostics-ipc';
import type { SettingsService } from '../apps/desktop/src/main/settings';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-diagnostics-delivery-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const handlers = new Map<string, (...args: any[]) => any>();
  let runtimeCalls = 0;
  const settings = {
    redactContent: (value: string) => value,
    assertCleanText: () => undefined,
  } as unknown as SettingsService;
  const handle = (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn);
  registerDiagnosticsIpc({
    handle, store, dataRoot: root, settings, manuals: () => undefined, manualEnabled: () => false,
    runtime: () => { runtimeCalls += 1; return { runtimeKind: 'codex', model: 'test-model', baseUrl: 'https://test.invalid', apiKey: 'main-process-fixture' }; },
    secrets: () => [], selectEvidence: async () => [], selectSave: async () => undefined,
  });
  registerDeliveryWorkbenchIpc({
    handle, store, dataRoot: root, selectFile: async () => undefined, selectSave: async () => undefined,
    openPath: async () => '', revealPath: () => undefined,
  });
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve().then(() => {
    const handler = handlers.get(channel);
    assert.ok(handler, `IPC handler missing: ${channel}`);
    return handler(...args) as T;
  });
  return {
    root, store, invoke, runtimeCalls: () => runtimeCalls,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

function project(id: string, status: DeliveryProject['status'] = 'active'): DeliveryProject {
  const timestamp = '2026-11-25T00:00:00.000Z';
  return {
    id, code: 'DEL-01', name: '现场诊断关联项目', customerName: '测试客户', systemType: 'WMS',
    productVersions: ['3.2'], stage: '实施', status, projectManager: '项目经理', members: [],
    createdAt: timestamp, updatedAt: timestamp,
  };
}

function issue(projectId: string, id = randomUUID()): DeliveryIssue {
  const timestamp = '2026-11-25T00:00:00.000Z';
  return {
    id, deliveryProjectId: projectId, title: '库存同步数量不一致', description: '库存同步后数量与业务单据不一致，需要现场核查。',
    type: 'blocker', priority: 'high', status: 'open', discoveredAt: timestamp,
    linkedTaskIds: [], linkedMeetingIds: [], sourceRefs: [], createdAt: timestamp, updatedAt: timestamp,
  };
}

function legacyCase(): DiagnosticCase {
  const timestamp = '2026-11-25T00:00:00.000Z';
  return {
    id: randomUUID(), code: 'ZD-LEGACY-01', title: '未关联项目的历史问题', symptom: '历史诊断档案保留且允许后续补充交付项目归属。',
    product: 'MES6', issueCategory: 'defect', priority: 'medium', status: 'new', planRevision: 0,
    createdAt: timestamp, updatedAt: timestamp,
  };
}

test('诊断档案关联交付项目和工单，归档后保留历史且 Runtime 预检不依赖聊天 Session', async () => {
  const f = await fixture();
  const deliveryProject = project(randomUUID());
  const deliveryIssue = issue(deliveryProject.id);
  try {
    f.store.saveDeliveryProject(deliveryProject);
    f.store.saveDeliveryRecord('delivery_issues', deliveryIssue);

    const imported = await f.invoke<{ item: DiagnosticCase; created: boolean }>('diagnostics:import-issue', deliveryProject.id, deliveryIssue.id);
    const repeated = await f.invoke<{ item: DiagnosticCase; created: boolean }>('diagnostics:import-issue', deliveryProject.id, deliveryIssue.id);
    assert.equal(imported.created, true);
    assert.equal(repeated.created, false);
    assert.equal(repeated.item.id, imported.item.id);
    assert.equal(imported.item.product, 'WMS');
    await assert.rejects(f.invoke('diagnostics:create', {
      title: '重复关联档案', symptom: '交付工单已经有关联诊断档案，需要继续使用现有档案。', product: 'MES6',
      priority: 'high', deliveryProjectId: deliveryProject.id, deliveryIssueId: deliveryIssue.id,
    }), /已关联诊断档案/);

    const legacy = legacyCase();
    f.store.saveDiagnosticBundle({ cases: [legacy] });
    const linkedLegacy = await f.invoke<DiagnosticCase>('diagnostics:update', legacy.id, { deliveryProjectId: deliveryProject.id });
    assert.equal(linkedLegacy.deliveryProjectId, deliveryProject.id);
    assert.equal(linkedLegacy.product, 'WMS');
    const triaged = await f.invoke<{ case: DiagnosticCase }>('diagnostics:apply-triage', legacy.id, { product: 'MES6' });
    assert.equal(triaged.case.product, 'WMS');

    const archivedProject = { ...deliveryProject, status: 'archived' as const, archivedAt: '2026-11-25T01:00:00.000Z', updatedAt: '2026-11-25T01:00:00.000Z' };
    f.store.saveDeliveryProject(archivedProject);
    const overview = await f.invoke<{ projects: Array<{ project: DeliveryProject; cases: DiagnosticCase[] }> }>('diagnostics:overview');
    const archivedSummary = overview.projects.find(value => value.project.id === deliveryProject.id);
    assert.equal(archivedSummary?.project.status, 'archived');
    assert.equal(archivedSummary?.cases.length, 2);
    await assert.rejects(f.invoke('diagnostics:create', {
      title: '归档项目新问题', symptom: '新建档案时不允许选择已归档交付项目。', product: 'WMS',
      priority: 'medium', deliveryProjectId: deliveryProject.id,
    }), /已归档/);

    const preview = await f.invoke<{ model: string; runtimeKind: string }>('diagnostics:preview-analysis', imported.item.id, 'triage');
    assert.equal(preview.model, 'test-model');
    assert.equal(preview.runtimeKind, 'codex');
    assert.equal(f.runtimeCalls(), 1);
    await assert.rejects(f.invoke('delivery-workbench:issue-delete', deliveryProject.id, deliveryIssue.id), /已关联现场诊断/);
    assert.equal(f.store.listDeliveryRecords<DeliveryIssue>('delivery_issues', deliveryProject.id).length, 1);
  } finally {
    await f.close();
  }
});

test('空诊断项目总览仍展示交付主数据', async () => {
  const f = await fixture();
  const deliveryProject = project(randomUUID());
  try {
    f.store.saveDeliveryProject(deliveryProject);
    const overview = await f.invoke<{ projects: Array<{ projectId: string; total: number; cases: DiagnosticCase[] }> }>('diagnostics:overview');
    assert.deepEqual(overview.projects.map(value => value.projectId), [deliveryProject.id]);
    assert.equal(overview.projects[0].total, 0);
    assert.deepEqual(overview.projects[0].cases, []);
  } finally {
    await f.close();
  }
});
