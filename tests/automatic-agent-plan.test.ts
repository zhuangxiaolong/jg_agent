import test from 'node:test';
import assert from 'node:assert/strict';
import { inferAutomaticAgentTaskPlan } from '../apps/desktop/src/main/agent-tasks';
import { automaticAgentTaskAvailability } from '../packages/agent-orchestrator/src/runtime-capabilities';

test('自动计划将前端和后端拆为可并行的独立开发分析任务', () => {
  const plans = inferAutomaticAgentTaskPlan('请实现前端页面和后端接口，并补充测试与兼容性审查');
  assert.deepEqual(plans.map(item => item.name), [
    '前端工作面分析',
    '后端工作面分析',
    '验证工作面分析',
  ]);
  assert.equal(plans[0].role, 'developer');
  assert.equal(plans[1].role, 'developer');
  assert.ok(plans.every(item => item.acceptanceCriteria.some(value => value.includes('由主 Agent 汇总实施'))));
  assert.ok(plans.every(item => !/只读|禁止修改|只允许读取/.test(item.description + item.acceptanceCriteria.join('；'))));
});

test('普通短聊天不会创建无关的自动子 Agent', () => {
  assert.deepEqual(inferAutomaticAgentTaskPlan('今天天气怎么样'), []);
});

test('单一工作面留给主 Agent，避免简单任务制造额外子 Agent', () => {
  const plans = inferAutomaticAgentTaskPlan('请帮我优化一下项目结构');
  assert.deepEqual(plans, []);
  assert.deepEqual(inferAutomaticAgentTaskPlan('请修复前端页面的按钮'), []);
});

test('用户明确需要子 Agent 时允许一个专门工作面', () => {
  const plans = inferAutomaticAgentTaskPlan('请使用子 Agent 分析项目结构');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].name, '需求拆分分析');
});

test('三个 Runtime 自动子 Agent 可用性如实反映严格治理缺口', () => {
  for (const kind of ['codex', 'jinggong', 'claude_agent_sdk'] as const) {
    const result = automaticAgentTaskAvailability(kind);
    assert.equal(result.available, false);
    assert.ok(result.reason);
    if (kind !== 'claude_agent_sdk') assert.match(result.reason!, /工具权限拦截.*模型请求限额/);
  }
});
