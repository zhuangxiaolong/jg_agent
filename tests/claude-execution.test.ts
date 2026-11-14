import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ReasoningEffort } from '../packages/domain/src';
import { buildClaudeExecutionInstructions, claudeReasoningOptions } from '../packages/agent-runtime/src/claude-execution';
import { ClaudeAgentSdkRuntimeAdapter, type ClaudeSdkQueryOptions } from '../packages/agent-runtime/src/claude-adapter';

test('Claude 项目初读收敛指引保留业务要求、原有查询指引及深入任务优先级', () => {
  const instructions = buildClaudeExecutionInstructions('必须保留的项目规范');
  assert.ok(instructions.startsWith('必须保留的项目规范\n'));
  for (const marker of ['【查询执行效率】', '【项目初读效率】', 'AGENTS.md', '同一轮批量或并行调用', '不额外启动 Explore/Agent', '以该要求为准', '不能用概览规则省略必要工作']) assert.ok(instructions.includes(marker), marker);
});

test('Claude 推理档位遵循官方 SDK 类型，默认不覆盖、显式档位不降档', () => {
  assert.deepEqual(claudeReasoningOptions(), {});
  assert.deepEqual(claudeReasoningOptions('none'), { thinking: { type: 'disabled' } });
  assert.deepEqual(claudeReasoningOptions('minimal'), { effort: 'low' });
  for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
    const native: Pick<Options, 'thinking' | 'effort'> = claudeReasoningOptions(effort);
    assert.deepEqual(native, { effort });
  }
  for (const invalid of ['', 'HIGH', 'max', null, 7]) assert.throws(() => claudeReasoningOptions(invalid as ReasoningEffort), /思考强度无效/);
});

test('Claude 新会话及冷恢复将所选档位与当前指引发给 SDK，不改变原始任务和模型', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'claude-project-overview-'));
  const executablePath = path.join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  try {
    for (const reasoningEffort of [undefined, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
      const calls: Array<{ prompt: unknown; options: ClaudeSdkQueryOptions }> = [];
      const events: Array<{ type: string; text: string }> = [];
      const options = {
        model: 'user-selected-model', reasoningEffort, apiKey: 'synthetic-overview-key', executablePath,
        additionalSystemPrompt: '原有开发规范',
        sdkLoader: async () => ({ query(parameters: { prompt: unknown; options: ClaudeSdkQueryOptions }) {
          calls.push(parameters);
          return { async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'native-overview-session' };
            yield { type: 'result', subtype: 'success', session_id: 'native-overview-session' };
          } };
        } }),
      };
      const first = new ClaudeAgentSdkRuntimeAdapter(options);
      let resumed: ClaudeAgentSdkRuntimeAdapter | undefined;
      try {
        first.onEvent(event => events.push(event));
        const thread = await first.startSession(cwd);
        await first.sendTurn(thread, '读一下这个项目', cwd);
        await first.sendTurn(thread, '深入分析生产过站并修复，按规范构建测试', cwd);
        await first.close();
        resumed = new ClaudeAgentSdkRuntimeAdapter({ ...options, additionalSystemPrompt: '冷恢复后的新规范' });
        resumed.onEvent(event => events.push(event));
        await resumed.resumeSession(thread, cwd, 'native-overview-session');
        await resumed.sendTurn(thread, '继续原任务', cwd);
        assert.deepEqual(calls.map(call => call.prompt), ['读一下这个项目', '深入分析生产过站并修复，按规范构建测试', '继续原任务']);
        assert.deepEqual(calls.map(call => call.options.resume), [undefined, 'native-overview-session', 'native-overview-session']);
        for (const { options: seen } of calls) {
          assert.equal(seen.model, 'user-selected-model');
          assert.equal(seen.effort, claudeReasoningOptions(reasoningEffort).effort);
          assert.deepEqual(seen.thinking, claudeReasoningOptions(reasoningEffort).thinking);
          assert.equal(seen.tools, undefined, '保留深入开发的完整原生工具集');
          assert.equal(seen.systemPrompt?.preset, 'claude_code');
          assert.equal(seen.systemPrompt?.snapshot, false);
          assert.match(seen.systemPrompt?.append ?? '', /【项目初读效率】/);
          assert.equal(Object.hasOwn(seen, 'appendSystemPrompt'), false);
        }
        assert.ok(calls[2].options.systemPrompt?.append.startsWith('冷恢复后的新规范'));
        assert.equal(events.filter(event => event.text.includes('没有 minimal 原生档位')).length, reasoningEffort === 'minimal' ? 3 : 0);
      } finally { await first.close(); await resumed?.close(); }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
