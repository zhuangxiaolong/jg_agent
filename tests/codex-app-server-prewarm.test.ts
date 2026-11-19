import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeAdapter } from '../packages/agent-runtime/src/manager';
import type { RuntimeOptions } from '../packages/agent-runtime/src';
import { CodexAppServerPrewarm } from '../apps/desktop/src/main/codex-app-server-prewarm';

function options(): RuntimeOptions { return { executable: 'codex', home: 'home', baseUrl: 'https://relay.example/v1', model: 'model' }; }

test('App Server 预热按会话和进程配置去重，切换时回收并记录初始化阶段', async () => {
  let starts = 0, closes = 0;
  const prewarm = new CodexAppServerPrewarm({
    processKey: async runtimeOptions => runtimeOptions.model,
    createAdapter: runtimeOptions => ({
      kind: 'codex',
      start: async () => {
        starts++;
        runtimeOptions.onLifecycle?.('app_server_spawn_start'); runtimeOptions.onLifecycle?.('app_server_spawned');
        runtimeOptions.onLifecycle?.('app_server_initialize_start'); runtimeOptions.onLifecycle?.('app_server_initialized');
      },
      close: async () => { closes++; },
    } as unknown as RuntimeAdapter),
  });
  const runtimeOptions = options();
  await prewarm.selectSession('session-one');
  await Promise.all([prewarm.warm(runtimeOptions, 'workspace', 'session-one'), prewarm.warm(runtimeOptions, 'workspace', 'session-one')]);
  assert.equal(starts, 1);
  assert.equal(await prewarm.take(runtimeOptions, 'workspace', 'another-session'), undefined);
  const result = await prewarm.take(runtimeOptions, 'workspace', 'session-one');
  assert.ok(result);
  assert.deepEqual(result.spans.map(span => span.stage), ['runtime.spawn', 'runtime.initialize']);
  assert.ok(result.spans.every(span => span.durationMs >= 0));
  await prewarm.selectSession('session-two');
  assert.equal(closes, 0);
  await prewarm.warm(runtimeOptions, 'workspace', 'session-two');
  await prewarm.selectSession('session-three');
  assert.equal(closes, 1);
  await prewarm.warm(runtimeOptions, 'workspace', 'session-three');
  await prewarm.updatePolicy({ enabled: false, idleTtlMs: 300000, maxIdleInstances: 3 });
  assert.equal(closes, 2);
  assert.equal(await prewarm.take(runtimeOptions, 'workspace', 'session-three'), undefined);
  await prewarm.close();
});

test('App Server 预热失败时清理实例并允许冷启动回退', async () => {
  let closes = 0;
  const prewarm = new CodexAppServerPrewarm({
    processKey: async () => 'process',
    createAdapter: () => ({ kind: 'codex', start: async () => { throw new Error('spawn failed'); }, close: async () => { closes++; } } as unknown as RuntimeAdapter),
  });
  await prewarm.selectSession('session');
  await prewarm.warm(options(), 'workspace', 'session');
  assert.equal(await prewarm.take(options(), 'workspace', 'session'), undefined);
  assert.equal(closes, 1);
  await prewarm.close();
});
