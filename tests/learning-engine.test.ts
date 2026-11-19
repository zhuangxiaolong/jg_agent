import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAgentTask, createTaskContract, transitionAgentTask } from '../packages/agent-orchestrator/src';
import { LocalStore } from '../packages/storage/src';
import { PluginManagerService } from '../apps/desktop/src/main/plugin-manager';
import { LearningEngineService, scanLearningText } from '../apps/desktop/src/main/learning-engine';
import { TaskEngineeringService } from '../apps/desktop/src/main/task-engineering';

async function fixture(taskType = 'analysis', status: 'COMPLETED' | 'FAILED' = 'COMPLETED', taskDescription = '整理文档流程，sk-abcdefghijklmnop') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jinggong-learning-'));
  const store = await LocalStore.open(path.join(root, 'store.db'));
  const projectId = 'b'.repeat(24); const sessionId = 'learning-session';
  store.saveProject({ id: projectId, name: '学习测试项目', path: root, branch: 'main' });
  store.saveSession({ id: sessionId, projectId, title: '学习测试', workspacePath: root, status: 'idle', createdAt: new Date().toISOString(), model: 'test', runtimeKind: 'codex' });
  const task = createAgentTask({ id: 'learning-task', sessionId, projectId, name: '可复用经验', role: 'documentation', description: taskDescription, runtimeKind: 'codex' });
  store.saveAgentTaskContract(task, createTaskContract(task, { taskType: taskType as 'analysis', outputExpectations: ['文档'], acceptanceCriteria: ['可复核'] }), 0, 'local-user');
  for (const next of ['RUNNING', status] as const) store.saveAgentTasksForSession(sessionId, store.listAgentTasks(sessionId).map(item => item.id === task.id ? transitionAgentTask(item, { status: next }) : item));
  const plugins = new PluginManagerService({ store, dataRoot: path.join(root, 'data'), executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }) });
  const engineering = new TaskEngineeringService(store, path.join(root, 'verification'));
  const service = new LearningEngineService(store, path.join(root, 'data'), plugins, () => engineering, value => value);
  return { root, store, sessionId, taskId: task.id, plugins, service };
}

test('敏感扫描只返回类别和偏移，不暴露命中原文', () => {
  const text = '凭据 sk-abcdefghijklmnop';
  const findings = scanLearningText(text);
  assert.equal(findings[0].code, 'api-key');
  assert.equal(findings[0].position, text.indexOf('sk-'));
  assert.doesNotMatch(findings[0].message, /sk-/);
});

test('代码任务缺少当前真实验证证据时不能生成 Skill 候选', async t => {
  const f = await fixture('implementation'); t.after(async () => { f.store.close(); await rm(f.root, { recursive: true, force: true }); });
  const result = await f.service.eligibility(f.sessionId, f.taskId);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.candidateTypes, []);
  assert.match(result.blockReasons.join(' '), /真实通过/);
});

test('候选 CAS、敏感内容拦截、人工批准及受管项目范围发布完整工作', async t => {
  const f = await fixture(); t.after(async () => { f.store.close(); await rm(f.root, { recursive: true, force: true }); });
  const eligibility = await f.service.eligibility(f.sessionId, f.taskId);
  assert.deepEqual(eligibility.candidateTypes, ['skill']);
  assert.equal(eligibility.requiresManualConfirmation, true);
  const created = await f.service.createCandidate({ sessionId: f.sessionId, taskId: f.taskId, candidateType: 'skill', selectedEvidenceIds: [], manualConfirmation: true });
  assert.doesNotMatch(created.draftSkillMarkdown, /sk-abcdefghijklmnop/);
  assert.equal(created.safetyFindings[0].code, 'api-key');
  assert.throws(() => f.service.updateCandidate({ candidateId: created.id, expectedRevision: created.revision, title: created.title, suggestedSkillName: created.suggestedSkillName, description: created.description, draftSkillMarkdown: `${created.draftSkillMarkdown}\npassword=super-secret-value-123`, systemScope: ['MES6'] }), /秘密信息/);
  const body = `---\nname: reusable-process\ndescription: 'Reusable task process'\n---\n\n# Reusable process\n\n1. Review the task contract.\n2. Verify evidence before reporting success.\n`;
  const updated = f.service.updateCandidate({ candidateId: created.id, expectedRevision: created.revision, title: 'Reusable process', suggestedSkillName: 'reusable-process', description: 'Reusable task process', draftSkillMarkdown: body, systemScope: ['MES6'] });
  assert.throws(() => f.service.updateCandidate({ candidateId: updated.id, expectedRevision: created.revision, title: updated.title, suggestedSkillName: updated.suggestedSkillName, description: updated.description, draftSkillMarkdown: body, systemScope: ['MES6'] }), /版本已变化/);
  assert.equal((await f.service.validateCandidate(updated.id)).valid, true);
  const approved = await f.service.approveCandidate({ candidateId: updated.id, expectedRevision: updated.revision });
  assert.equal(approved.status, 'approved');
  const published = await f.service.publishCandidate({ candidateId: approved.id, expectedRevision: approved.revision, scope: 'project' });
  assert.equal(published.status, 'published');
  assert.match(published.publishedHash ?? '', /^[a-f0-9]{64}$/);
  const plugin = (await f.plugins.listPlugins()).find(item => item.id === published.publishedPluginId);
  assert.equal(plugin?.trustStatus, 'trusted');
  assert.equal(plugin?.enabled, true);
  assert.equal(plugin?.origin, 'learned');
  assert.equal(plugin?.sourceCandidateId, created.id);
  assert.deepEqual(plugin?.sourceTaskIds, [f.taskId]);
  assert.ok(plugin?.publishedAt);
  assert.equal(f.store.getSkillScope(published.publishedSkillId!)?.projectId, 'b'.repeat(24));
});

test('AI 草拟必须显式调用，失败时保留本地候选', async t => {
  const f = await fixture('analysis', 'COMPLETED', '整理可复用流程'); t.after(async () => { f.store.close(); await rm(f.root, { recursive: true, force: true }); });
  let calls = 0;
  let requestBody = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    requestBody = String(init?.body ?? '');
    return new Response('暂不可用', { status: 503 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const aiSettings = {
    profiles: () => [{ id: 'ai-provider', name: '测试模型', baseUrl: 'https://model.example/v1', models: ['test-model'], hasKey: true }],
    credential: () => ({ read: () => 'provider-secret-test-value' }),
  } as any;
  const aiService = new LearningEngineService(f.store, path.join(f.root, 'data'), f.plugins, () => new TaskEngineeringService(f.store, path.join(f.root, 'verification')), value => value, aiSettings);
  const candidate = await aiService.createCandidate({ sessionId: f.sessionId, taskId: f.taskId, candidateType: 'skill', selectedEvidenceIds: [], manualConfirmation: true });
  assert.equal(calls, 0);
  assert.deepEqual(aiService.listAiProviders(), [{ id: 'ai-provider', name: '测试模型', models: ['test-model'] }]);
  await assert.rejects(() => aiService.generateAiDraft({ candidateId: candidate.id, expectedRevision: candidate.revision, providerId: 'ai-provider', model: 'test-model', selectedEvidenceIds: [], selectedExcerpt: '仅发送此片段' }), /HTTP 503/);
  assert.equal(calls, 1);
  assert.match(requestBody, /仅发送此片段/);
  assert.doesNotMatch(requestBody, /provider-secret-test-value/);
  assert.deepEqual(f.store.getLearningCandidate(candidate.id), candidate);
  await assert.rejects(() => aiService.generateAiDraft({ candidateId: candidate.id, expectedRevision: candidate.revision, providerId: 'ai-provider', model: 'test-model', selectedEvidenceIds: [], selectedExcerpt: 'password=super-secret-value-123' }), /疑似凭据/);
  assert.equal(calls, 1);
});

test('AI 草稿仅写入待审核版本并以候选 CAS 防止覆盖', async t => {
  const f = await fixture('analysis', 'COMPLETED', '整理可复用流程'); t.after(async () => { f.store.close(); await rm(f.root, { recursive: true, force: true }); });
  let completeRequest: ((response: Response) => void) | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => await new Promise<Response>(resolve => { completeRequest = resolve; });
  t.after(() => { globalThis.fetch = originalFetch; });
  const aiSettings = {
    profiles: () => [{ id: 'ai-provider', name: '测试模型', baseUrl: 'https://model.example/v1', models: ['test-model'], hasKey: true }],
    credential: () => ({ read: () => 'provider-secret-test-value' }),
  } as any;
  const aiService = new LearningEngineService(f.store, path.join(f.root, 'data'), f.plugins, () => new TaskEngineeringService(f.store, path.join(f.root, 'verification')), value => value, aiSettings);
  const candidate = await aiService.createCandidate({ sessionId: f.sessionId, taskId: f.taskId, candidateType: 'skill', selectedEvidenceIds: [], manualConfirmation: true });
  const pending = aiService.generateAiDraft({ candidateId: candidate.id, expectedRevision: candidate.revision, providerId: 'ai-provider', model: 'test-model', selectedEvidenceIds: [], selectedExcerpt: '仅选中的流程片段' });
  while (!completeRequest) await new Promise(resolve => setTimeout(resolve, 0));
  const edited = aiService.updateCandidate({ candidateId: candidate.id, expectedRevision: candidate.revision, title: candidate.title, suggestedSkillName: candidate.suggestedSkillName, description: candidate.description, draftSkillMarkdown: `${candidate.draftSkillMarkdown}\n人工编辑`, systemScope: candidate.systemScope });
  completeRequest!(new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '---\nname: ai-draft\ndescription: ai draft\n---\n\n# AI 草稿\n\n## 操作步骤\n\n1. 待人工确认。' }] }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => pending, /候选在 AI 请求期间已变化/);
  assert.equal(f.store.getLearningCandidate(candidate.id)?.revision, edited.revision);
  assert.equal(f.store.getLearningCandidate(candidate.id)?.generationMethod, 'user_edited');
});

test('失败任务只提供不可发布的问题复盘候选', async t => {
  const f = await fixture('analysis', 'FAILED'); t.after(async () => { f.store.close(); await rm(f.root, { recursive: true, force: true }); });
  const eligibility = await f.service.eligibility(f.sessionId, f.taskId);
  assert.deepEqual(eligibility.candidateTypes, ['failure_lesson']);
  const candidate = await f.service.createCandidate({ sessionId: f.sessionId, taskId: f.taskId, candidateType: 'failure_lesson', selectedEvidenceIds: [], manualConfirmation: true });
  assert.equal(candidate.evidenceLevel, 'failure_lesson');
  await assert.rejects(() => f.service.approveCandidate({ candidateId: candidate.id, expectedRevision: candidate.revision }), /不能批准/);
});
