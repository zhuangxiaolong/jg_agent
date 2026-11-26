import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DiagnosticAnalysisPreview, DiagnosticCase, DiagnosticCaseDetails, DiagnosticOverview } from '../packages/domain/src/diagnostics';
import { LocalStore } from '../packages/storage/src';
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

test('无交付项目时，现场问题可独立登记、编辑并预览分析', async () => {
  const f = await fixture();
  try {
    const item = await f.invoke<DiagnosticCase>('diagnostics:create', {
      title: '库存核对失败', symptom: '现场复核后库存数量仍与单据不一致。', priority: 'medium', product: 'WMS',
    });
    assert.equal(item.product, 'WMS');
    assert.equal(item.deliveryProjectId, undefined);
    const edited = await f.invoke<DiagnosticCase>('diagnostics:update', item.id, { product: 'MES5' });
    assert.equal(edited.product, 'MES5');
    const triaged = await f.invoke<DiagnosticCaseDetails>('diagnostics:apply-triage', item.id, { product: 'MES6' });
    assert.equal(triaged.case.product, 'MES6');
    const overview = await f.invoke<DiagnosticOverview>('diagnostics:overview');
    assert.equal(overview.recent[0].id, item.id);
    const preview = await f.invoke<DiagnosticAnalysisPreview>('diagnostics:preview-analysis', item.id, 'triage');
    assert.equal(preview.model, 'test-model');
    assert.equal(f.runtimeCalls(), 1);
  } finally { await f.close(); }
});

test('历史诊断档案可读取归档项目和原工单，编辑后保留来源', async () => {
  const f = await fixture();
  try {
    const projectId = randomUUID(), issueId = randomUUID(), time = '2026-11-25T00:00:00.000Z';
    const project = { id: projectId, name: '旧库房项目', status: 'archived', systemType: 'WMS', productVersions: ['3.2'], stage: '实施', customerName: '测试客户' };
    const issue = { id: issueId, title: '历史库存问题', status: 'open', description: '现场复核发现库存数量异常。' };
    const db = new DatabaseSync(join(f.root, 'agent.db'));
    try {
      db.prepare('INSERT INTO delivery_projects(id, status, updated_at, value) VALUES (?, ?, ?, ?)').run(projectId, project.status, time, JSON.stringify(project));
      db.prepare('INSERT INTO delivery_issues(id, delivery_project_id, status, updated_at, value) VALUES (?, ?, ?, ?, ?)').run(issueId, projectId, issue.status, time, JSON.stringify(issue));
    } finally { db.close(); }
    const item: DiagnosticCase = { id: randomUUID(), code: 'ZD-LEGACY-1', title: issue.title, symptom: issue.description, product: 'WMS',
      issueCategory: 'defect', priority: 'medium', status: 'new', planRevision: 0, deliveryProjectId: projectId, deliveryIssueId: issueId, createdAt: time, updatedAt: time };
    f.store.saveDiagnosticBundle({ cases: [item] });
    await f.invoke('diagnostics:update', item.id, { priority: 'high' });
    const detail = await f.invoke<DiagnosticCaseDetails>('diagnostics:get', item.id);
    assert.equal(detail.case.deliveryIssueId, issueId);
    assert.equal(detail.case.priority, 'high');
    assert.equal(detail.legacyProject?.name, project.name);
    assert.equal(detail.legacyIssue?.title, issue.title);
    const preview = await f.invoke<DiagnosticAnalysisPreview>('diagnostics:preview-analysis', item.id, 'triage');
    assert.ok(preview.sources.some(source => source.name.includes(issue.title)));

    const dbWithHistory = new DatabaseSync(join(f.root, 'agent.db'));
    try {
      dbWithHistory.prepare('DELETE FROM delivery_issues WHERE id = ?').run(issueId);
      dbWithHistory.prepare('DELETE FROM delivery_projects WHERE id = ?').run(projectId);
    } finally { dbWithHistory.close(); }
    await f.invoke('diagnostics:update', item.id, { title: '原项目已删除的档案' });
    const orphan = await f.invoke<DiagnosticCaseDetails>('diagnostics:get', item.id);
    assert.equal(orphan.case.deliveryProjectId, projectId);
    assert.equal(orphan.legacyProject, undefined);
    const orphanPreview = await f.invoke<DiagnosticAnalysisPreview>('diagnostics:preview-analysis', item.id, 'triage');
    assert.ok(orphanPreview.sources.every(source => !source.name.includes(issue.title)));
  } finally { await f.close(); }
});
