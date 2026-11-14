import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { tsImport } from 'tsx/esm/api';

// 真实本机 Runtime + 回环合成 Responses 服务；不读取用户凭据，不访问外部模型或天气接口。
// 用法：node scripts/runtime-execution-rules-smoke.mjs
// 可用 JINGGONG_RUNTIME_ARTIFACT_ROOT 指定项目外的报告根目录。
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CodexRuntime, buildDeveloperInstructions, runtimeEnvironment, runtimeConfigOverrides } = await tsImport('../packages/agent-runtime/src/index.ts', import.meta.url);
const { buildRuntimeExecutionInstructions, RUNTIME_EXECUTION_RULES_VERSION } = await tsImport('../packages/agent-runtime/src/execution-instructions.ts', import.meta.url);
const reportRoot = path.resolve(process.env.JINGGONG_RUNTIME_ARTIFACT_ROOT ?? path.join(process.env.LOCALAPPDATA ?? tmpdir(), 'JinggongAgent', 'verification', 'runtime-query-switch-20261113'));
const relative = path.relative(repository, reportRoot);
if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw new Error('回归产物必须保存到目标项目之外');
await mkdir(reportRoot, { recursive: true });
const runDirectory = await mkdtemp(path.join(reportRoot, 'execution-rules-smoke-'));
const fixtureRoot = path.join(runDirectory, 'fixtures');
const syntheticKey = 'synthetic-runtime-rules-test-not-a-real-key';
const model = 'gpt-5.4';
const effort = 'high';
const prompt = '只回复 SYNTHETIC_QUERY_OK；本轮是协议回归，不查询天气、不运行工具。';
const oldRule = 'OLD_RULE_SENTINEL：保留原业务约束。';
const newRule = 'NEW_RULE_SENTINEL：新 builder 的业务约束。';
const sharedRules = buildRuntimeExecutionInstructions();
const report = {
  startedAt: new Date().toISOString(), runDirectory, platform: process.platform,
  scope: '真实 Codex/Jinggong JSONL 协议与实际回环模型载荷；纯合成响应，不证明外部模型或天气性能。',
  transport: '测试通过原生 app-server 的回环 HTTP 配置访问本地服务；正式 CodexRuntime 的恢复/迁移/发送方法不做替换，仅将 start/request 接到该真实协议连接。生产 HTTPS 校验保持不变。',
  model, effort, prompt, executionRulesVersion: RUNTIME_EXECUTION_RULES_VERSION, runtimes: [],
};

class NativeClient {
  constructor(kind, home, workspace, baseUrl) {
    this.kind = kind; this.home = home; this.workspace = workspace; this.baseUrl = baseUrl;
    this.pending = new Map(); this.nextId = 1; this.requests = []; this.diagnostics = '';
  }
  async start() {
    const executable = path.join(repository, 'apps', 'desktop', 'resources', 'runtime', this.kind, 'bin', this.kind === 'codex' ? 'codex.exe' : 'jinggong-runtime.exe');
    const config = {
      ...runtimeConfigOverrides({}), model_provider: 'jinggong', model,
      'model_providers.jinggong.name': '本地合成协议回归',
      'model_providers.jinggong.base_url': this.baseUrl,
      'model_providers.jinggong.env_key': 'JINGGONG_MODEL_API_KEY',
      'model_providers.jinggong.requires_openai_auth': false,
      'model_providers.jinggong.wire_api': 'responses',
      'model_providers.jinggong.supports_websockets': false,
      'model_providers.jinggong.request_max_retries': 0,
      'model_providers.jinggong.stream_max_retries': 0,
      'model_providers.jinggong.stream_idle_timeout_ms': 15000,
    };
    this.executable = executable;
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])], {
      cwd: this.home, env: runtimeEnvironment(this.home, syntheticKey), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rejectPending = error => { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); } this.pending.clear(); this.turnWaiter?.reject(error); };
    this.child.on('error', rejectPending);
    this.child.on('exit', (code, signal) => rejectPending(new Error(`本地 ${this.kind} 进程退出：${code ?? signal}`)));
    this.child.stdin.on('error', rejectPending);
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => { this.diagnostics = (this.diagnostics + text).replaceAll(syntheticKey, '[合成凭据]').slice(-16384); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { rejectPending(new Error('原生 Runtime 返回非 JSONL 数据')); return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else if (message.method) {
        if (message.id !== undefined) this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: '合成回归禁止任何工具执行' } }) + '\n');
        else {
          this.onNotification?.(message);
          if (message.method === 'turn/completed') this.turnWaiter?.resolve(message.params.turn);
        }
      }
    });
    this.initializeResult = await this.request('initialize', { clientInfo: { name: 'jinggong_execution_rules_smoke', version: '1.0' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  request(method, params) {
    this.requests.push({ method });
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async runTurn(send) {
    assert.equal(this.turnWaiter, undefined, '协议回归每次只运行一个轮次');
    let timer;
    const completed = new Promise((resolve, reject) => {
      this.turnWaiter = { resolve, reject };
      timer = setTimeout(() => reject(new Error('原生 turn/completed 超时')), 20000);
    });
    // 发送失败时也消费完成 Promise 的拒绝，避免清理过程出现未处理异常。
    completed.catch(() => undefined);
    try { await send(); const turn = await completed; assert.equal(turn.status, 'completed', JSON.stringify(turn.error ?? turn.status)); return turn; }
    finally { clearTimeout(timer); this.turnWaiter = undefined; }
  }
  async close() {
    const child = this.child;
    if (!child) return;
    this.onNotification = undefined;
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 2500);
    await exited; clearTimeout(timeout); this.lines?.close(); this.child = undefined;
  }
}

function rawTurn(client, threadId) {
  return client.runTurn(() => client.request('turn/start', { threadId, cwd: client.workspace, model, effort, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, input: [{ type: 'text', text: prompt, text_elements: [] }] }));
}
function nativeRuntime(client, executionRulesVersion) {
  const runtime = new CodexRuntime({ executable: client.executable, home: client.home, baseUrl: 'https://synthetic.invalid/v1', model, apiKey: syntheticKey, reasoningEffort: effort, developerInstructions: newRule, executionRulesVersion });
  // 仅适配本地 HTTP 试验的 transport，保留正式 resumeSession/ensureExecutionRules/sendTurn 实现。
  runtime.start = async () => undefined;
  runtime.request = (method, params) => client.request(method, params);
  client.onNotification = message => runtime.receive(message);
  return runtime;
}

async function verifyKind(kind) {
  const evidenceDirectory = path.join(runDirectory, kind);
  const home = path.join(fixtureRoot, kind, 'home'), workspace = path.join(fixtureRoot, kind, 'workspace');
  await mkdir(evidenceDirectory, { recursive: true }); await mkdir(home, { recursive: true }); await mkdir(workspace, { recursive: true });
  const result = { kind, status: 'running', checks: [], captures: [], evidenceDirectory, rpcCalls: [] };
  report.runtimes.push(result);
  let phase = '01-old-start', client, runtime;
  const writes = [];
  const check = (name, condition) => { result.checks.push({ name, passed: Boolean(condition) }); assert.ok(condition, name); };
  const server = createServer((request, response) => {
    if (request.url !== '/v1/responses' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 8 * 1024 * 1024) request.destroy(new Error('合成请求超过限制')); });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const developers = payload.input?.filter(item => item.role === 'developer') ?? [];
        const developerText = developers.flatMap(item => item.content ?? []).map(item => item.text ?? '').join('\n');
        const users = payload.input?.filter(item => item.role === 'user') ?? [];
        const lastUserText = (users.at(-1)?.content ?? []).map(item => item.text ?? '').join('');
        const requestNumber = result.captures.length + 1;
        const filename = path.join(evidenceDirectory, `${phase}-request-${requestNumber}.json`);
        const capture = { phase, file: filename, model: payload.model, effort: payload.reasoning?.effort, lastUserText,
          oldRuleIncluded: developerText.includes(oldRule), newBusinessRuleIncluded: developerText.includes(newRule), sharedRulesIncluded: developerText.includes(sharedRules),
          sharedRulesOccurrences: developerText.split(sharedRules).length - 1, webSearchAvailable: payload.tools?.some(tool => tool.type === 'web_search' || tool.type === 'web_search_preview') ?? false };
        result.captures.push(capture);
        // 请求正文只含本脚本合成内容；不记录 HTTP headers 或 Authorization。
        writes.push(writeFile(filename, JSON.stringify(payload, null, 2), 'utf8'));
        const id = `${kind}-synthetic-${requestNumber}`;
        const events = [{ type: 'response.created', response: { id } },
          { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message-${requestNumber}`, content: [{ type: 'output_text', text: 'SYNTHETIC_QUERY_OK' }] } },
          { type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } }];
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } catch { response.writeHead(400); response.end('合成请求格式无效'); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const openClient = async () => { client = new NativeClient(kind, home, workspace, baseUrl); await client.start(); result.userAgent ??= client.initializeResult.userAgent; };
  const closeClient = async () => {
    if (runtime) { await runtime.close(); runtime = undefined; }
    if (client) { result.rpcCalls.push({ phase, methods: client.requests.map(item => item.method) }); await writeFile(path.join(evidenceDirectory, `${phase}-stderr.log`), client.diagnostics, 'utf8'); await client.close(); client = undefined; }
  };
  const captureFor = currentPhase => { const captures = result.captures.filter(item => item.phase === currentPhase); check(`${currentPhase} 只调用一次合成模型`, captures.length === 1); return captures[0]; };
  const assertUnchanged = capture => {
    check(`${capture.phase} 保留用户原问题`, capture.lastUserText === prompt);
    check(`${capture.phase} 保留模型`, capture.model === model);
    check(`${capture.phase} 保留推理强度`, capture.effort === effort);
    check(`${capture.phase} 保留原生实时搜索工具`, capture.webSearchAvailable);
    check(`${capture.phase} 保留旧业务上下文`, capture.oldRuleIncluded);
  };
  try {
    const startedAt = performance.now(); await openClient();
    const started = await client.request('thread/start', { cwd: workspace, model, modelProvider: 'jinggong', sandbox: 'danger-full-access', approvalPolicy: 'never', developerInstructions: oldRule, ephemeral: false });
    const threadId = started.thread.id; result.threadId = threadId; result.coldStartMs = Math.round(performance.now() - startedAt);
    await rawTurn(client, threadId);
    const original = captureFor(phase); assertUnchanged(original); check('旧会话尚无共享新指引', !original.sharedRulesIncluded);
    await closeClient();

    phase = '02-cold-resume-builder-only'; await openClient();
    await client.request('thread/resume', { threadId, cwd: workspace, model, modelProvider: 'jinggong', sandbox: 'danger-full-access', approvalPolicy: 'never', developerInstructions: buildDeveloperInstructions({ developerInstructions: newRule }) });
    await rawTurn(client, threadId);
    const unchanged = captureFor(phase); assertUnchanged(unchanged);
    check('对照组确认仅改恢复 builder 不会更新旧 developer 消息', !unchanged.newBusinessRuleIncluded && !unchanged.sharedRulesIncluded);
    await closeClient();

    phase = '03-formal-resume-auto-migration'; await openClient(); runtime = nativeRuntime(client, 0);
    check('正式 resumeSession 保留原生线程', await runtime.resumeSession(threadId, workspace) === threadId);
    check('旧版本恢复只自动注入一次开发消息', client.requests.filter(item => item.method === 'thread/inject_items').length === 1);
    await client.runTurn(() => runtime.sendTurn(threadId, prompt, workspace));
    const migrated = captureFor(phase); assertUnchanged(migrated); check('真实载荷含完整共享查询指引', migrated.sharedRulesIncluded); check('共享指引没有重复累计', migrated.sharedRulesOccurrences === 1);
    await closeClient();

    phase = '04-current-version-cold-resume'; await openClient(); runtime = nativeRuntime(client, RUNTIME_EXECUTION_RULES_VERSION);
    check('当前版本冷恢复保留原生线程', await runtime.resumeSession(threadId, workspace) === threadId);
    check('当前版本冷恢复不再注入', !client.requests.some(item => item.method === 'thread/inject_items'));
    await client.runTurn(() => runtime.sendTurn(threadId, prompt, workspace));
    const persisted = captureFor(phase); assertUnchanged(persisted); check('再次冷恢复仍有持久化共享指引', persisted.sharedRulesIncluded); check('再次冷恢复没有累计重复指引', persisted.sharedRulesOccurrences === 1);
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = error instanceof Error ? error.stack : String(error); }
  finally {
    await closeClient(); await Promise.all(writes); await new Promise(resolve => server.close(resolve));
    await writeFile(path.join(evidenceDirectory, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  }
}

try {
  if (process.platform !== 'win32') throw new Error('该脚本只验证仓库部署的 Windows 原生 Runtime');
  for (const kind of ['codex', 'jinggong']) await verifyKind(kind);
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); }
finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(error => { report.cleanupError = String(error); });
  report.endedAt = new Date().toISOString();
  report.status = !report.error && report.runtimes.length === 2 && report.runtimes.every(item => item.status === 'passed') && !report.cleanupError ? 'passed' : 'failed';
  await writeFile(path.join(runDirectory, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  const lines = ['# Runtime 执行指引原生回归', '', `结果：${report.status}`, `时间：${report.startedAt}`, '', report.scope, '', report.transport, '',
    ...report.runtimes.flatMap(result => [`## ${result.kind}`, '', `结果：${result.status}；通过 ${result.checks.filter(item => item.passed).length}/${result.checks.length} 项；合成环境冷启动 ${result.coldStartMs ?? '未完成'}ms。`,
      `证据目录：${result.evidenceDirectory}`, '', ...result.checks.map(item => `- ${item.passed ? '通过' : '失败'}：${item.name}`), '', ...(result.error ? ['```text', result.error, '```', ''] : [])]),
    ...(report.error ? ['## 脚本错误', '', '```text', report.error, '```', ''] : []),
    '限制：没有调用真实模型、外部搜索或天气服务；没有测量真实用户查询的端到端耗时；不证明正式客户端界面的切换行为。临时原生 home/workspace 已清理，保留合成载荷和诊断日志用于复核。', ''];
  await writeFile(path.join(runDirectory, 'report.md'), lines.join('\n'), 'utf8');
  console.log(JSON.stringify({ status: report.status, reportDirectory: runDirectory, runtimes: report.runtimes.map(result => ({ kind: result.kind, status: result.status, passed: result.checks.filter(item => item.passed).length, total: result.checks.length })) }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}
