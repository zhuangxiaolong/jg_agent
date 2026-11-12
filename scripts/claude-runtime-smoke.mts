import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createClaudeAgentSdkRuntimeAdapter } from '../packages/agent-runtime/src/claude-adapter.ts';

// 使用真实 SDK 和随包二进制，只向本机隔离服务发送虚构凭据。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-claude-smoke-'));
const home = path.join(root, 'home');
await mkdir(home);
const executable = path.resolve(process.env.JINGGONG_CLAUDE_EXE || 'apps/desktop/resources/runtime/claude_agent_sdk/bin/claude.exe');
const key = 'sk-jinggong-runtime-fixture';
const model = 'jinggong-relay-fixture';
const requests: { path: string; model: unknown; authenticated: boolean }[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (!request.url?.includes('/messages')) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
    return;
  }
  requests.push({ path: request.url, model: body.model, authenticated: request.headers['x-api-key'] === key || request.headers.authorization === `Bearer ${key}` });
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: 'msg_local_runtime_smoke', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage };
  if (!body.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: '运行时测试通过' }], stop_reason: 'end_turn' }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const item of [
    { type: 'message_start', message },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '运行时测试通过' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]) response.write(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);
  response.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as { port: number }).port;
const adapter = createClaudeAgentSdkRuntimeAdapter({
  model, apiKey: key, relayBaseUrl: `http://127.0.0.1:${port}/relay/v1`, executablePath: executable, readOnly: true,
  env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', API_TIMEOUT_MS: '15000' },
});
const events: { type: string; text: string }[] = [];
adapter.onEvent(event => events.push({ type: event.type, text: event.text }));
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const health = await adapter.checkRuntime();
  assert.equal(health.available, true, health.detail);
  const id = await adapter.startSession(root);
  timer = setTimeout(() => { void adapter.cancelRun(id); }, 45000);
  await adapter.sendTurn(id, '只回复运行时测试通过，不要使用任何工具。', root);
  assert.ok(requests.length > 0, '真实 SDK 未向指定中转站发出模型请求');
  assert.ok(requests.every(item => item.path.split('?')[0] === '/relay/v1/messages' && item.model === model && item.authenticated), '真实请求的中转站、模型或凭据不匹配');
  assert.ok(events.some(item => ['message', 'delta'].includes(item.type) && item.text.includes('运行时测试通过')), JSON.stringify(events));
  assert.ok(events.some(item => item.type === 'status' && item.text === 'completed'), JSON.stringify(events));
  assert.ok(!events.some(item => item.type === 'error'), JSON.stringify(events));
  await mkdir('test-results', { recursive: true });
  const report = { date: new Date().toISOString(), passed: true, executable, checks: ['真实随包 Claude 二进制成功启动', '真实官方 SDK 向指定中转站路径发送请求', '共享模型 ID 与 API Key 正确传入', '真实流式响应归一化且会话成功完成'], requests, events, scope: '本机 Anthropic-compatible 协议服务；未验证外部中转站可用性' };
  await writeFile('test-results/claude-runtime-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (timer) clearTimeout(timer);
  await adapter.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
