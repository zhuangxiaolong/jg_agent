import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRuntime, buildDeveloperInstructions, type RuntimeEvent } from '../packages/agent-runtime/src';
import { ProjectReadBroker } from '../packages/agent-runtime/src/project-read-broker';
import { GitConnector } from '../packages/git-connector/src';
import { parseChangePlan, planIncludesFile, renderChangePlan } from '../packages/agent-runtime/src/change-plan';

test('真实 Worktree 写入前必须发布本轮方案，方案落入消息后才写入；计划外文件、跨任务和跨会话不能复用', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-plan-'));
  const source = path.join(root, 'source'); await mkdir(source);
  const execute = promisify(execFile);
  const git = (args: string[]) => execute('git', args, { cwd: source, windowsHide: true });
  const events: RuntimeEvent[] = [], replies: any[] = [];
  const apiKey = 'synthetic-plan-test-credential';
  let writes = 0;
  const beforeWrite = async () => { assert.ok(events.some(event => event.type === 'message' && event.text.startsWith('## 代码修改方案'))); writes++; };
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'test', apiKey, mode: 'develop', beforeWrite });
  const state = runtime as any;
  runtime.onEvent(event => events.push(event));
  try {
    await git(['init', '-b', 'main']); await git(['config', 'user.name', '方案回归']); await git(['config', 'user.email', 'plan@example.invalid']); await git(['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(source, 'existing.ts'), 'export const value = 1;\n');
    await git(['add', '.']); await git(['commit', '-m', '建立方案测试样本']);
    const connector = new GitConnector(path.join(root, 'workspaces'));
    const workspace = await connector.createWorkspace(await connector.register(source), 'plan-test');
    const broker = await ProjectReadBroker.create(workspace.path, { mode: 'develop', beforeWrite });
    state.readBrokers.set('thread', broker); state.child = {}; state.write = (message: any) => replies.push(message);
    state.setActive('thread', 'turn-1');
    let seq = 0;
    const call = async (tool: string, args: unknown, threadId = 'thread', turnId = state.active.get(threadId)) => {
      await state.handleReadTool(++seq, { tool, arguments: args, turnId }, threadId);
      return replies.pop().result;
    };
    assert.equal((await call('write_project_file', { path: 'new.ts', content: 'export const next = 2;\n' })).success, false);
    assert.equal(writes, 0); await assert.rejects(readFile(path.join(workspace.path, 'new.ts')), { code: 'ENOENT' });
    const plan = { goal: '补充新文件，跟随现有 TypeScript 写法', changes: [{ path: 'new.ts', change: '新增 next 常量，兼容现有接口。' }], impact: '仅增加新文件；不修改数据库和事务。', validation: ['构建项目并检查新常量。'] };
    assert.equal((await call('publish_change_plan', { ...plan, impact: '' })).success, false);
    assert.equal((await call('publish_change_plan', { ...plan, goal: apiKey })).success, false);
    assert.equal(events.filter(event => event.type === 'message').length, 0);
    const example = '记录失败响应，示例 password="unit-only-password"，Authorization: Bearer synthetic-business-token';
    assert.equal((await call('publish_change_plan', { ...plan, impact: example })).success, true);
    assert.ok(events.find(event => event.type === 'message')!.text.includes(example));
    assert.equal((await call('publish_change_plan', plan)).success, true);
    assert.match(events.find(event => event.type === 'message')!.text, /修改文件与步骤/);
    const initialPlan = { ...plan, stage: 'draft', changes: [], assumptions: ['暂按当前控制器负责记录日志设计，待代码证据确认。'], pendingQuestions: ['确认日志是否必须跟随业务事务回滚。'] };
    assert.equal((await call('publish_change_plan', initialPlan)).success, true);
    const initialMessage = events.filter(event => event.type === 'message').at(-1)!.text;
    assert.match(initialMessage, /初步，待确认/); assert.match(initialMessage, /方案假设/); assert.match(initialMessage, /待确认事项/);
    assert.equal((await call('write_project_file', { path: 'new.ts', content: 'no' })).success, false);
    assert.equal(writes, 0);
    assert.equal((await call('publish_change_plan', { ...initialPlan, changes: plan.changes })).success, true);
    assert.equal((await call('write_project_file', { path: 'new.ts', content: 'no' })).success, false);
    assert.equal((await call('publish_change_plan', { ...initialPlan, stage: 'ready' })).success, false);
    assert.equal((await call('publish_change_plan', { ...initialPlan, stage: 'ready', changes: plan.changes })).success, false);
    assert.equal((await call('publish_change_plan', { ...plan, stage: 'ready' })).success, true);
    // turn/started 和 turn/start 响应可能重复登记同一个 turn，不能清除已发布方案。
    state.setActive('thread', 'turn-1');
    assert.equal((await call('write_project_file', { path: './new.ts', content: 'export const next = 2;\n' })).success, true);
    assert.equal(await readFile(path.join(workspace.path, 'new.ts'), 'utf8'), 'export const next = 2;\n'); assert.equal(writes, 1);
    const current = await broker.call('read_project_file', { path: 'existing.ts' });
    assert.equal((await call('delete_project_file', { path: 'existing.ts', expectedHash: current.hash })).success, false);
    assert.equal(await readFile(path.join(workspace.path, 'existing.ts'), 'utf8'), 'export const value = 1;\n');
    assert.equal((await call('publish_change_plan', { ...plan, changes: [...plan.changes, { path: 'existing.ts', change: '移除旧常量文件，并验证无剩余引用。' }] })).success, true);
    assert.equal((await call('delete_project_file', { path: 'existing.ts', expectedHash: current.hash })).success, true);
    await assert.rejects(readFile(path.join(workspace.path, 'existing.ts')), { code: 'ENOENT' });
    state.readBrokers.set('other-thread', broker); state.setActive('other-thread', 'turn-other');
    assert.equal((await call('write_project_file', { path: 'other.ts', content: 'no' }, 'other-thread')).success, false);
    state.setActive('thread', 'turn-2');
    assert.equal((await call('write_project_file', { path: 'new.ts', content: 'no' })).success, false);
    assert.equal((await call('publish_change_plan', plan, 'thread', 'turn-1')).success, false);
    assert.equal(await readFile(path.join(source, 'existing.ts'), 'utf8'), 'export const value = 1;\n');
    assert.equal((await git(['status', '--porcelain'])).stdout, '');
  } finally { state.child = undefined; await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('旧模式参数兼容完整开发指令，方案工具仍不能绕过未绑定的文件代理', async () => {
  for (const mode of ['develop', 'read'] as const) {
    const instructions = buildDeveloperInstructions({ mode });
    assert.match(instructions, /publish_change_plan/); assert.match(instructions, /验证计划/);
    assert.match(instructions, /条件不完整，也必须先给初步修改方案/);
    assert.match(instructions, /真实项目构建和相关测试/);
    assert.match(instructions, /test-results\/.*agent-test-results/);
    assert.match(instructions, /已执行通过、已执行失败、未执行、环境受阻、仅生成未验证/);
  }
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-read-plan-'));
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'test', mode: 'read' });
  const state = runtime as any, replies: any[] = [];
  try {
    state.child = {}; state.write = (message: any) => replies.push(message);
    state.readBrokers.set('read-thread', await ProjectReadBroker.create(root)); state.setActive('read-thread', 'read-turn');
    const call = async (tool: string, args: unknown) => { await state.handleReadTool(1, { tool, arguments: args, turnId: 'read-turn' }, 'read-thread'); return replies.pop().result; };
    assert.equal((await call('publish_change_plan', { goal: '只提出方案', changes: [{ path: 'new.ts', change: '建议新增文件' }], impact: '待开发模式实施', validation: ['实施后构建'] })).success, true);
    assert.equal((await call('write_project_file', { path: 'new.ts', content: 'no' })).success, false);
    await assert.rejects(readFile(path.join(root, 'new.ts')), { code: 'ENOENT' });
  } finally { state.child = undefined; await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('条件不全可发布无文件的初步方案，渲染具体方向与待确认项但不授予文件修改范围', () => {
  const initial = parseChangePlan({ stage: 'draft', goal: '补充采集日志，先定位现有入口和日志保存调用。', changes: [], assumptions: ['暂按复用原日志表设计，尚未核实。'], pendingQuestions: ['确认失败日志是否独立于业务事务保存。'], impact: '事务边界待核实，确认前不修改采集主流程。', validation: ['定位控制器及日志方法后检查事务与异常边界。', '实施后执行构建和成功、失败、回滚用例；目前尚未执行。'] });
  assert.equal(planIncludesFile(initial, 'AssemblyOperationController.cs'), false);
  const text = renderChangePlan(initial);
  for (const required of ['初步，待确认', '暂定修改范围与步骤', '具体文件与方法尚待定位', '方案假设', '待确认事项', '验证计划', '尚未执行']) assert.ok(text.includes(required));
  assert.throws(() => parseChangePlan({ ...initial, pendingQuestions: [] }), /待确认事项/);
  assert.throws(() => parseChangePlan({ ...initial, stage: 'ready' }), /修改文件|初步方案/);
});
