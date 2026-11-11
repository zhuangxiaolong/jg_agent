import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRuntime, buildDeveloperInstructions, type RuntimeEvent } from '../packages/agent-runtime/src';
import { ProjectReadBroker } from '../packages/agent-runtime/src/project-read-broker';
import { CHANGE_PLAN_TOOL, parseChangePlan, renderChangePlan } from '../packages/agent-runtime/src/change-plan';

test('代码修改方案是可选记录，未发布、初步方案和范围变化都不会阻止文件操作', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-optional-plan-'));
  const events: RuntimeEvent[] = [], replies: any[] = [];
  const apiKey = 'synthetic-plan-test-credential';
  let writes = 0;
  const beforeWrite = async () => { writes++; };
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'test', apiKey, beforeWrite });
  const state = runtime as any;
  runtime.onEvent(event => events.push(event));
  try {
    await writeFile(path.join(root, 'existing.ts'), 'export const value = 1;\n');
    const broker = await ProjectReadBroker.create(root, { beforeWrite });
    state.readBrokers.set('thread', broker); state.child = {}; state.write = (message: any) => replies.push(message);
    state.setActive('thread', 'turn-1');
    let seq = 0;
    const call = async (tool: string, args: unknown, threadId = 'thread', turnId = state.active.get(threadId)) => {
      await state.handleReadTool(++seq, { tool, arguments: args, turnId }, threadId);
      return replies.pop().result;
    };

    assert.equal((await call('write_project_file', { path: 'new.ts', content: 'export const next = 2;\n' })).success, true);
    assert.equal(writes, 1);
    assert.equal(events.some(event => event.type === 'message'), false, '无需发布方案即可修改');
    const plan = { goal: '补充新文件，跟随现有 TypeScript 写法', changes: [{ path: 'new.ts', change: '新增 next 常量。' }], impact: '仅增加新文件；不修改数据库和事务。', validation: ['构建项目并检查新常量。'] };
    assert.equal((await call('publish_change_plan', { ...plan, impact: '' })).success, false);
    assert.equal((await call('publish_change_plan', { ...plan, goal: apiKey })).success, false);
    const example = '记录失败响应，示例 password="unit-only-password"，Authorization: Bearer synthetic-business-token';
    assert.equal((await call('publish_change_plan', { ...plan, impact: example })).success, true);
    assert.ok(events.find(event => event.type === 'message')!.text.includes(example));

    const initialPlan = { ...plan, stage: 'draft', changes: [], assumptions: ['暂按现有入口设计，待代码证据确认。'], pendingQuestions: ['确认日志是否跟随业务事务回滚。'] };
    assert.equal((await call('publish_change_plan', initialPlan)).success, true);
    assert.match(events.filter(event => event.type === 'message').at(-1)!.text, /开发过程中继续核实/);
    assert.equal((await call('write_project_file', { path: 'unplanned.ts', content: 'export const extra = 3;\n' })).success, true);
    assert.equal(await readFile(path.join(root, 'unplanned.ts'), 'utf8'), 'export const extra = 3;\n');
    assert.equal((await call('publish_change_plan', { ...initialPlan, stage: 'ready' })).success, true);
    const current = await broker.call('read_project_file', { path: 'existing.ts' });
    assert.equal((await call('delete_project_file', { path: 'existing.ts', expectedHash: current.hash })).success, true);
    await assert.rejects(readFile(path.join(root, 'existing.ts')), { code: 'ENOENT' });

    state.setActive('thread', 'turn-2');
    assert.equal((await call('write_project_file', { path: 'next-turn.ts', content: 'export const nextTurn = 4;\n' })).success, true);
    assert.equal((await call('write_project_file', { path: 'stale.ts', content: 'no' }, 'thread', 'turn-1')).success, false);
    assert.equal((await call('write_project_file', { path: 'foreign.ts', content: 'no' }, 'other-thread', 'turn-other')).success, false);
    assert.equal((await call('publish_change_plan', plan, 'thread', 'turn-1')).success, false);
    assert.equal(writes, 4);
  } finally { state.child = undefined; await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('开发指令说明可选方案和真实验证，不包含方案前置门禁', () => {
  const instructions = buildDeveloperInstructions({});
  assert.match(instructions, /publish_change_plan/);
  assert.match(instructions, /可选的，不会阻止文件修改/);
  assert.match(instructions, /真实项目构建和相关测试/);
  assert.match(instructions, /test-results\/.*agent-test-results/);
  assert.match(instructions, /已执行通过、已执行失败、未执行、环境受阻、仅生成未验证/);
  assert.doesNotMatch(instructions, /必须调用 publish_change_plan|本轮正式方案|初步方案不授权/);
  assert.doesNotMatch(CHANGE_PLAN_TOOL.description, /必须给方案|再允许|不允许凭此写入/);
});

test('初步与整理后的方案都可包含未定位文件和待核实内容，方案仍校验路径和格式', () => {
  const initial = parseChangePlan({ stage: 'draft', goal: '补充采集日志，先定位现有入口和日志保存调用。', changes: [], assumptions: ['暂按复用原日志表设计，尚未核实。'], pendingQuestions: ['确认失败日志是否独立于业务事务保存。'], impact: '核实事务边界及失败日志行为。', validation: ['定位控制器及日志方法后检查事务与异常边界。', '实施后执行构建和成功、失败、回滚用例；目前尚未执行。'] });
  const text = renderChangePlan(initial);
  for (const required of ['初步，待确认', '暂定修改范围与步骤', '具体文件与方法尚待定位', '方案假设', '待确认事项', '验证计划', '尚未执行']) assert.ok(text.includes(required));
  assert.doesNotThrow(() => parseChangePlan({ ...initial, pendingQuestions: [] }));
  assert.doesNotThrow(() => parseChangePlan({ ...initial, stage: 'ready' }));
  assert.throws(() => parseChangePlan({ ...initial, changes: [{ path: '../outside.ts', change: '非法路径' }] }), /相对路径/);
  assert.throws(() => parseChangePlan({ ...initial, validation: [] }), /Too small/);
  assert.doesNotMatch(text, /再执行代码修改|授权写入/);
});
