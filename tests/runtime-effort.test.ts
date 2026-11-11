import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexRuntime } from '../packages/agent-runtime/src';
import type { ReasoningEffort } from '../packages/domain/src';

test('思考强度逐档原样传turn/start.effort，默认不传，服务端不支持时明确失败且不降档', async () => {
  for (const effort of [undefined, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
    const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', apiKey: 'synthetic-effort-fixture-key', reasoningEffort: effort });
    const state = runtime as any; state.sessions.add('thread-effort'); state.sessionRoots.set('thread-effort', path.resolve('D:\\fixture'));
    const calls: any[] = [];
    state.request = async (method: string, params: any) => {
      assert.equal(method, 'turn/start'); calls.push(params);
      return { turn: { id: 'synthetic-parameter-only', status: 'completed' } };
    };
    await runtime.sendTurn('thread-effort', '参数单元验证，不执行模型推理', 'D:\\fixture');
    assert.equal(Object.hasOwn(calls[0], 'effort'), effort !== undefined);
    assert.equal(calls[0].effort, effort);
    assert.equal(Object.hasOwn(calls[0], 'reasoningEffort'), false);
    assert.equal(Object.hasOwn(calls[0], 'reasoning_effort'), false);
    state.request = async () => { calls.push('rejected'); throw new Error('合成服务明确不支持所选强度'); };
    await assert.rejects(runtime.sendTurn('thread-effort', '不允许静默重试', 'D:\\fixture'), /不支持所选强度/);
    assert.equal(calls.length, 2);
    await runtime.close();
  }
});

test('未知思考档位在发送RPC前拒绝', async () => {
  for (const value of ['max', 'HIGH', '', null, 7]) {
    const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', apiKey: 'synthetic-effort-fixture-key', reasoningEffort: value as ReasoningEffort });
    const state = runtime as any; state.sessions.add('thread-effort'); state.sessionRoots.set('thread-effort', path.resolve('D:\\fixture'));
    let called = false; state.request = async () => { called = true; throw new Error('不应发送'); };
    await assert.rejects(runtime.sendTurn('thread-effort', '参数验证', 'D:\\fixture'), /思考强度无效/);
    assert.equal(called, false);
    await runtime.close();
  }
});
