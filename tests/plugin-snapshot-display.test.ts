import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('会话时间线不展示内部插件快照信息', () => {
  const renderer = readFileSync('apps/desktop/src/renderer/App.tsx', 'utf8');
  assert.doesNotMatch(renderer, /Codex 插件快照|snapshot hash|此会话明确未选择插件/);
  assert.doesNotMatch(renderer, /getSessionPluginSnapshot/);

  const preload = readFileSync('apps/desktop/src/preload/index.ts', 'utf8');
  assert.match(preload, /getSessionPluginSnapshot/);
});
