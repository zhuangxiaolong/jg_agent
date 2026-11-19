import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContextOptimizer, ContextRetrievalPlanner, defaultPerformanceSettings, indexablePath, PerformanceTelemetry, recommendTests, SafeParallelScheduler, WorkspaceIndexService, type ContextCandidate, type ContextFragment, type PerformanceState, type RegisteredTestCommand, type ScheduledOperation } from '../packages/performance/src';

function fragment(patch: Partial<ContextFragment> = {}): ContextFragment {
  return { workspaceId: 'w', repositoryId: 'r', worktreeId: 't', path: 'src/a.ts', hash: 'a'.repeat(64), indexVersion: 1, startLine: 1, endLine: 3, text: 'export class BuildWidget {}', score: 3, ...patch };
}
test('性能追踪使用单调时钟，记录结构化工具边界而不保存正文', () => {
  let now = 0, saved: PerformanceState | undefined;
  const service = new PerformanceTelemetry({ now: () => now, save: value => { saved = value; } });
  const id = service.startTrace({ sessionId: 's', runtimeKind: 'jinggong', modelId: 'gpt-test', baseUrl: 'https://user:secret@relay.example/v1?api_key=hello' })!;
  const runtime = service.startSpan(id, { stage: 'runtime.initialize', operation: '初始化' }); now = 12; service.endSpan(runtime);
  service.recordRuntimeEvent(id, { type: 'tool', text: '完整命令和用户秘密不应保存', performance: { callId: 'one', phase: 'started', stage: 'command', operation: '执行命令' } });
  now = 55; service.recordRuntimeEvent(id, { type: 'delta', text: 'PRIVATE_USER_CONTENT' });
  now = 80; service.recordRuntimeEvent(id, { type: 'tool', text: 'secret output', performance: { callId: 'one', phase: 'completed', stage: 'command', operation: '执行命令', exitCode: 0 } });
  now = 100; service.recordRuntimeEvent(id, { type: 'status', text: 'completed' });
  const report = service.report('s');
  assert.equal(report.latest!.totalDurationMs, 100); assert.equal(report.latest!.firstVisibleResponseMs, 55);
  assert.equal(report.latest!.spans[1].durationMs, 68); assert.equal(report.latest!.spans[1].status, 'completed');
  assert.equal(report.latest!.endpoint, 'https://relay.example'); assert.equal(saved!.traces.length, 1);
  assert.ok(!JSON.stringify(saved).includes('PRIVATE_USER_CONTENT')); assert.ok(!service.export('s').includes('secret output'));
  assert.equal(report.baselineStatus, 'insufficient_samples'); assert.ok(report.unavailable.length > 0);
});
test('工具未完成或未知退出码不会冒充成功；结束通知没有开始时不造耗时', () => {
  const service = new PerformanceTelemetry(); const id = service.startTrace({ sessionId: 's', runtimeKind: 'codex' });
  service.recordRuntimeEvent(id, { type: 'tool', text: '', performance: { callId: 'missing', phase: 'completed', stage: 'command', operation: '命令', exitCode: 0 } });
  service.recordRuntimeEvent(id, { type: 'tool', text: '', performance: { callId: 'unknown', phase: 'started', stage: 'command', operation: '命令' } });
  service.recordRuntimeEvent(id, { type: 'tool', text: '', performance: { callId: 'unknown', phase: 'completed', stage: 'command', operation: '命令', exitCode: null } });
  const span = service.startSpan(id, { stage: 'file.read', operation: '尚未结束' });
  service.finishTrace(id, 'completed'); const spans = service.report('s').latest!.spans;
  assert.equal(spans.length, 2); assert.equal(spans[0].status, 'unavailable'); assert.equal(spans.find(item => item.id === span)!.status, 'interrupted');
});
test('崩溃恢复不以墙钟差值补造持续时间，关闭总开关可回退', () => {
  let state: PerformanceState | undefined;
  const first = new PerformanceTelemetry({ save: value => { state = value; } });
  const id = first.startTrace({ sessionId: 's', runtimeKind: 'claude_agent_sdk' }); first.startSpan(id, { stage: 'context.build', operation: '组装' }); first.flush();
  const recovered = new PerformanceTelemetry({ load: () => state });
  assert.equal(recovered.report('s').latest!.status, 'interrupted'); assert.equal(recovered.report('s').latest!.totalDurationMs, undefined);
  assert.equal(recovered.report('s').latest!.spans[0].status, 'interrupted'); assert.equal(recovered.report('s').latest!.spans[0].durationMs, undefined);
  recovered.updateSettings({ enabled: false }); assert.equal(recovered.startTrace({ sessionId: 's', runtimeKind: 'codex' }), undefined);
  assert.throws(() => recovered.updateSettings({ maxParallelReadOperations: 10 }));
  recovered.resetSettings(); recovered.updateSettings({ runtimeOverrides: { codex: false }, workspaceOverrides: { blocked: false } });
  assert.equal(recovered.isEnabled('codex', 'w'), false); assert.equal(recovered.isEnabled('jinggong', 'blocked'), false); assert.equal(recovered.isEnabled('jinggong', 'w'), true);
});
test('Runtime 复用策略校验，分开记录首个文本、UI 首绘和预热耗时', () => {
  let now = 0;
  const service = new PerformanceTelemetry({ now: () => now });
  const defaults = service.getSettings();
  assert.equal(defaults.runtimeReuseEnabled, true); assert.equal(defaults.runtimeReuseIdleTtlMs, 300000); assert.equal(defaults.runtimeReuseMaxIdleInstances, 3);
  assert.throws(() => service.updateSettings({ runtimeReuseIdleTtlMs: 999 }));
  assert.throws(() => service.updateSettings({ runtimeReuseMaxIdleInstances: 11 }));
  const id = service.startTrace({ sessionId: 'codex-session', runtimeKind: 'codex' })!;
  service.setRuntimeReuse(id, false, 'idle_instance_unavailable');
  service.markFirstUiRender(id);
  now = 28; service.recordRuntimeEvent(id, { type: 'delta', text: '首段文本' });
  now = 47; service.markFirstUiRender(id);
  service.recordCompletedSpan(id, { stage: 'runtime.spawn', operation: 'codex.app_server_prewarm_spawn', durationMs: 12 });
  const trace = service.report('codex-session').latest!;
  assert.equal(trace.runtimeReuseHit, false); assert.equal(trace.runtimeReuseMissReason, 'idle_instance_unavailable');
  assert.equal(trace.firstAssistantDeltaMs, 28); assert.equal(trace.firstUiRenderMs, 47);
  assert.equal(trace.spans[0].stage, 'runtime.spawn'); assert.equal(trace.spans[0].durationMs, 12);
});
test('索引只解析变更文件，跨重启复用元数据并保留符号检索', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jg-performance-index-')); const cache = await mkdtemp(path.join(os.tmpdir(), 'jg-performance-cache-'));
  try {
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true }); await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n*.generated.ts\n'); await mkdir(path.join(root, 'ignored'));
    await writeFile(path.join(root, 'src', 'a.ts'), 'export class BuildWidget { value = 1; }');
    await writeFile(path.join(root, 'src', 'b.ts'), 'export function KeepWidget() { return 2; }');
    await writeFile(path.join(root, 'ignored', 'never.ts'), 'NEVER_INDEX'); await writeFile(path.join(root, '.env'), 'API_KEY=private');
    await writeFile(path.join(root, 'src', 'accidental.ts'), 'const api_key = "sk-abcdefghijklmnop";');
    await writeFile(path.join(root, 'src', 'skip.generated.ts'), 'DO_NOT_INDEX');
    const identity = { workspaceId: 'w', repositoryId: 'r', worktreeId: 't', root };
    const service = new WorkspaceIndexService({ cacheRoot: cache }); const first = await service.ensureFresh(identity);
    assert.equal(first.state, 'ready'); assert.equal(first.fileCount, 3); assert.equal(first.parsedFiles, 3);
    const second = await service.ensureFresh(identity); assert.equal(second.parsedFiles, 0); assert.equal(second.reusedFiles, 3); assert.equal(second.version, first.version);
    await writeFile(path.join(root, 'src', 'a.ts'), 'export class UpdatedWidget { value = 123; }');
    const third = await service.ensureFresh(identity); assert.equal(third.parsedFiles, 1); assert.equal(third.reusedFiles, 2);
    service.close(); const restarted = new WorkspaceIndexService({ cacheRoot: cache }); const warm = await restarted.ensureFresh(identity);
    assert.equal(warm.parsedFiles, 0); assert.equal(warm.reusedFiles, 3);
    const matches = await restarted.search(identity, 'UpdatedWidget'); assert.equal(matches.length, 1); assert.equal(matches[0].path, 'src/a.ts');
    const secretContext = await restarted.search(identity, 'sk-abcdefghijklmnop'); assert.equal(secretContext.length, 1); assert.ok(secretContext[0].text.includes('sk-abcdefghijklmnop'));
    await unlink(path.join(root, 'src', 'b.ts')); const removed = await restarted.ensureFresh(identity); assert.equal(removed.deletedFiles, 1);
    const separate = { ...identity, workspaceId: 'other' }; assert.equal(restarted.status(separate).state, 'unavailable'); assert.deepEqual(await restarted.search(separate, 'UpdatedWidget'), []);
    restarted.close();
    const files = execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }); assert.ok(!files.includes('never.ts'));
    const cacheText = await Promise.all((await readdir(cache)).map(file => readFile(path.join(cache, file), 'utf8')));
    assert.ok(cacheText.every(text => !text.includes('value = 123') && !text.includes('NEVER_INDEX') && !text.includes('sk-abcdefghijklmnop')));
  } finally { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); }
});
test('检索命中复核文件 hash，凭据正文可进入模型上下文且链接不越界', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jg-performance-read-')); const outside = await mkdtemp(path.join(os.tmpdir(), 'jg-performance-outside-'));
  try {
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true }); await writeFile(path.join(root, 'file.ts'), 'export class QueryWidget {}'); await writeFile(path.join(outside, 'outside.ts'), 'export class OutsideSecret {}');
    let linked = false; try { await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); linked = true; } catch { /* 无链接权限的环境仍验证文件过滤。 */ }
    const identity = { workspaceId: 'w', repositoryId: 'r', worktreeId: 't', root }; const service = new WorkspaceIndexService(); await service.ensureFresh(identity);
    await writeFile(path.join(root, 'file.ts'), 'export class QueryWidget { current = true; }');
    const found = await service.search(identity, 'QueryWidget'); assert.ok(found[0].text.includes('current = true'));
    if (linked) assert.equal((await service.search(identity, 'OutsideSecret')).length, 0);
    await writeFile(path.join(root, 'file.ts'), 'const password = "confidential-password";');
    const secret = await service.search(identity, 'confidential-password'); assert.equal(secret.length, 1); assert.ok(secret[0].text.includes('confidential-password'));
    service.close();
    for (const name of ['.env', 'src/appsettings.Development.json', 'keys/private.pem', 'src/token.json', 'node_modules/a.ts', '../escape.ts', 'C:/escape.ts']) assert.equal(indexablePath(name), false, name);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('重启元数据复用后可全文检索注释，变更hash和ignore即时失效', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jg-performance-fulltext-')); const cache = await mkdtemp(path.join(os.tmpdir(), 'jg-performance-fulltext-cache-'));
  try {
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
    await writeFile(path.join(root, 'a.ts'), 'export class OrdinaryWidget {}\n// commentaryNeedleUnique 交接异常\n');
    await writeFile(path.join(root, 'b.ts'), 'export class AnotherWidget {}\n// unrelated content\n');
    const identity = { workspaceId: 'w', repositoryId: 'r', worktreeId: 't', root };
    const initial = new WorkspaceIndexService({ cacheRoot: cache }); assert.equal((await initial.ensureFresh(identity)).parsedFiles, 2); initial.close();
    const restarted = new WorkspaceIndexService({ cacheRoot: cache }); const warm = await restarted.ensureFresh(identity);
    assert.equal(warm.parsedFiles, 0); assert.equal(warm.reusedFiles, 2);
    const comments = await restarted.search(identity, 'commentaryNeedleUnique'); assert.equal(comments.length, 1); assert.ok(comments[0].text.includes('commentaryNeedleUnique'));
    assert.equal((await restarted.search(identity, '交接')).length, 1);
    const previousHash = comments[0].hash;
    // 新词不在持久化候选位里，也必须通过stat检测变化后按需检索当前文件。
    await writeFile(path.join(root, 'a.ts'), 'export class OrdinaryWidget {}\n// freshReplacementUniqueWord 交接修复\n');
    const updated = await restarted.search(identity, 'freshReplacementUniqueWord'); assert.equal(updated.length, 1); assert.notEqual(updated[0].hash, previousHash);
    assert.equal((await restarted.search(identity, 'commentaryNeedleUnique')).length, 0);
    await writeFile(path.join(root, '.gitignore'), 'a.ts\n'); assert.equal((await restarted.search(identity, 'freshReplacementUniqueWord')).length, 0);
    restarted.close();
    const contents = await Promise.all((await readdir(cache)).map(filename => readFile(path.join(cache, filename), 'utf8')));
    assert.ok(contents.every(content => !content.includes('commentaryNeedleUnique') && !content.includes('freshReplacementUniqueWord') && !content.includes('交接异常')));
  } finally { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); }
});
test('上下文保留需求与验收，去重且预算不足时仅裁剪代码片段', () => {
  const optimizer = new ContextOptimizer(); const one = fragment();
  const first = optimizer.build({ requiredText: '必须完整保留的需求、安全和验收标准', fragments: [one, one, fragment({ path: 'src/b.ts', score: 1, text: 'x'.repeat(4000) })], budgetTokens: 500 });
  assert.ok(first.text.startsWith('必须完整保留的需求')); assert.equal(first.stats.deduplicatedCount, 1); assert.equal(first.stats.trimmedCount, 1); assert.equal(first.stats.fragmentCount, 1); assert.equal(first.stats.tokenMeasurement, 'estimated');
  const warm = optimizer.build({ requiredText: '', fragments: [one], budgetTokens: 500 }); assert.equal(warm.stats.cacheHits, 1);
  const changed = optimizer.build({ requiredText: '', fragments: [fragment({ hash: 'b'.repeat(64), text: 'changed' })], budgetTokens: 500 }); assert.equal(changed.stats.cacheHits, 0);
  const otherWorkspace = optimizer.build({ requiredText: '', fragments: [fragment({ workspaceId: 'other' })], budgetTokens: 500 }); assert.equal(otherWorkspace.stats.cacheHits, 0);
  const over = optimizer.build({ requiredText: '必需标准'.repeat(100), fragments: [one], budgetTokens: 10 }); assert.equal(over.stats.requiredOverBudget, true); assert.equal(over.fragments.length, 0); assert.equal(over.text, '必需标准'.repeat(100));
});
function contextCandidate(patch: Partial<ContextCandidate> = {}): ContextCandidate {
  return { id: 'fact:1', sourceType: 'project_fact', sourceId: '1', scope: 'project', projectId: 'p1', contentHash: 'a'.repeat(64), trust: 'user_confirmed', status: 'confirmed', title: '工单接口约定', text: 'MES5 工单接口必须兼容 Oracle。', ...patch };
}
test('统一检索严格隔离项目、状态与系统，并说明排除原因', () => {
  const settings = defaultPerformanceSettings();
  const planned = new ContextRetrievalPlanner().plan({ sessionId: 's1', projectId: 'p1', workspaceId: 'w1', systemType: 'MES5', query: 'MES5 工单接口' }, [
    contextCandidate(),
    contextCandidate({ id: 'other-project', projectId: 'p2', sourceId: 'other', title: 'MES5 工单接口' }),
    contextCandidate({ id: 'rejected', sourceId: 'rejected', status: 'rejected' }),
    contextCandidate({ id: 'old', sourceId: 'old', status: 'superseded' }),
    contextCandidate({ id: 'wrong-system', sourceId: 'wrong-system', systemType: 'WMS' }),
    contextCandidate({ id: 'global-memory', sourceType: 'memory', scope: 'global', projectId: undefined, trust: 'user_memory', title: '工单接口偏好' }),
  ], settings);
  assert.deepEqual(planned.candidates.map(item => item.id), ['fact:1', 'global-memory']);
  assert.match(planned.excluded.find(item => item.sourceId === 'other')!.reason, /项目范围/);
  assert.match(planned.excluded.find(item => item.sourceId === 'rejected')!.reason, /rejected/);
  assert.match(planned.excluded.find(item => item.sourceId === 'old')?.reason ?? '', /superseded/);
  assert.ok(!planned.candidates.some(item => item.systemType === 'WMS'));
});
test('统一上下文永不裁剪 Required，统计仅含 Hash 与来源元数据', () => {
  const requiredText = '必须完整保留的开发要求与验收条件'.repeat(100);
  const candidate = contextCandidate({ text: 'SENSITIVE_PROJECT_CONTENT_DO_NOT_PERSIST' });
  const bundle = new ContextOptimizer().build({ requiredText, candidates: [candidate], budgetTokens: 128, excluded: [{ sourceType: 'project_fact', sourceId: 'excluded-id', title: '未选事实', reason: '预算不足' }] });
  assert.ok(bundle.text.startsWith(requiredText));
  assert.equal(bundle.stats.requiredOverBudget, true);
  assert.equal(bundle.stats.optionalEstimatedTokens, 0);
  assert.equal(bundle.stats.excluded?.[0].reason, '预算不足');
  assert.ok(!JSON.stringify(bundle.stats).includes('SENSITIVE_PROJECT_CONTENT_DO_NOT_PERSIST'));
  assert.equal(bundle.stats.tokenMeasurement, 'estimated');
});
test('性能设置兼容旧状态并严格校验来源开关与数量上限', () => {
  const telemetry = new PerformanceTelemetry();
  assert.equal(telemetry.getSettings().unifiedContextEnabled, true);
  assert.equal(telemetry.getSettings().contextSources.project_fact, true);
  telemetry.updateSettings({ contextSources: { project_fact: false } as never, maxProjectAssertions: 0 });
  assert.equal(telemetry.getSettings().contextSources.project_fact, false);
  assert.equal(telemetry.getSettings().contextSources.memory, true);
  assert.throws(() => telemetry.updateSettings({ contextSources: { not_a_source: true } as never }));
  assert.throws(() => telemetry.updateSettings({ maxSkillContexts: 11 }));
});
test('实际加载 Skill 只记录名称、版本、Hash 与估算大小', () => {
  let saved: PerformanceState | undefined;
  const telemetry = new PerformanceTelemetry({ save: value => { saved = value; } });
  const traceId = telemetry.startTrace({ sessionId: 'skill-session', runtimeKind: 'jinggong' });
  telemetry.recordLoadedSkill(traceId, { sourceType: 'skill_body', sourceId: 'skill-id', title: 'Skill Name', scope: 'project', contentHash: 'b'.repeat(64), reason: '已校验加载', estimatedTokens: 12, version: '1.2.3', pluginHash: 'c'.repeat(64) });
  const report = telemetry.report('skill-session');
  assert.equal(report.latest!.loadedSkills?.[0].version, '1.2.3');
  assert.ok(!JSON.stringify(report).includes('Skill 正文'));
});
function operation(id: string, patch: Partial<ScheduledOperation> = {}): ScheduledOperation { return { id, parentTaskId: 'parent', workspaceId: 'w', repositoryIds: ['r'], worktreeId: 't', operation: '检索', safety: 'readonly', timeoutMs: 1000, requiresApproval: false, ...patch }; }
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() }; }
test('只读并行且写操作等待同一工作树，禁止跨会话绕锁与审批', async () => {
  const scheduler = new SafeParallelScheduler({ maxParallel: 3, authorize: () => true }); const left = deferred(), right = deferred(); const started: string[] = [];
  const a = scheduler.submit(operation('a'), async () => { started.push('a'); await left.promise; });
  const b = scheduler.submit(operation('b'), async () => { started.push('b'); await right.promise; });
  const write = scheduler.submit(operation('write', { workspaceId: 'another-session', safety: 'workspace_write' }), async () => { started.push('write'); });
  assert.deepEqual(started, ['a', 'b']); assert.deepEqual(scheduler.getStatus().queued, ['write']);
  left.release(); await a; assert.deepEqual(started, ['a', 'b']); right.release(); await Promise.all([b, write]); assert.deepEqual(started, ['a', 'b', 'write']);
  await assert.rejects(scheduler.submit(operation('network', { safety: 'external_side_effect' }), async () => 1), /审批/);
  await assert.rejects(scheduler.submit(operation('approval', { requiresApproval: true }), async () => 1), /审批/);
});
test('取消保留实际运行锁，子任务失败不会被忽略；队列有背压', async () => {
  const scheduler = new SafeParallelScheduler({ maxParallel: 1, maxQueued: 1, authorize: () => true }); const actualExit = deferred();
  const a = scheduler.submit(operation('a'), async () => { await actualExit.promise; });
  const cancelled = assert.rejects(a, /取消/);
  const b = scheduler.submit(operation('b'), async () => 2); const queuedCancelled = assert.rejects(b, /取消/);
  await assert.rejects(scheduler.submit(operation('overflow'), async () => 3), /已满/);
  scheduler.cancelParent('parent'); assert.deepEqual(scheduler.getStatus().cancellationPending, ['a']); assert.deepEqual(scheduler.getStatus().queued, []);
  actualExit.release(); await Promise.all([cancelled, queuedCancelled]); assert.deepEqual(scheduler.getStatus().running, []);
  await assert.rejects(scheduler.submit(operation('failure'), async () => { throw new Error('真实失败'); }), /真实失败/);
});
test('测试分级只建议登记命令，full要求不被路径或文档策略降级', () => {
  const base: RegisteredTestCommand = { id: 'target', repositoryId: 'r', name: '模块测试', level: 'targeted', executable: 'node', args: ['--test'], workingDirectory: '/authorized', timeoutMs: 1000, requiresNetwork: false, requiresDatabase: false, sideEffectLevel: 'local', enabled: true, changedPathPrefixes: ['src/'] };
  const full = { ...base, id: 'all', name: '全量测试', level: 'full' as const };
  const plan = recommendTests({ commands: [full, base, { ...base, id: 'build', level: 'build' }], changedFiles: ['src/widget.ts'], fullRequested: true });
  assert.deepEqual(plan.entries.filter(item => item.selected).map(item => item.command.level), ['targeted', 'build', 'full']); assert.ok(plan.entries.every(item => item.status === 'not_run')); assert.equal(plan.entries.at(-1)!.requiresApproval, true);
  const docs = recommendTests({ commands: [full, base], changedFiles: ['README.md'], fullRequested: true }); assert.equal(docs.entries.find(item => item.command.level === 'full')!.selected, true); assert.equal(docs.entries.find(item => item.command.level === 'targeted')!.selected, false);
  assert.equal(recommendTests({ commands: [], changedFiles: ['src/a.ts'], fullRequested: true }).missingFull, true);
});
