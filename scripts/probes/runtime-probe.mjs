import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// 仅验证真实本机协议；不读取用户全局 Codex 配置、认证或模型密钥。
let nativeRoot = process.argv[2] ?? path.resolve('apps/desktop/resources/runtime');
if (!process.argv[2]) {
  try { await access(path.join(nativeRoot, 'bin/codex.exe')); }
  catch { nativeRoot = path.resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc'); }
}
const binary = path.join(nativeRoot, 'bin/codex.exe');
const probeRoot = await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-probe-'));
const runtimeHome = path.join(probeRoot, 'runtime-home');
const workspace = path.join(probeRoot, '只读项目 空格');
await mkdir(runtimeHome);
await mkdir(workspace);
await writeFile(path.join(workspace, 'README.md'), '# 精工 Agent Runtime 协议验证\n', 'utf8');
const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE']) {
  if (process.env[key]) env[key] = process.env[key];
}
env.CODEX_HOME = runtimeHome;
const report = { timestamp: new Date().toISOString(), runtimeHome, binary, sha256: createHash('sha256').update(await readFile(binary)).digest('hex'), checks: [], notifications: [] };
const child = spawn(binary, ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false'], { cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 0;
let stderrLength = 0;
child.stderr.on('data', (data) => { stderrLength += data.length; });
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { report.checks.push({ name: 'stdout-jsonl', passed: false }); return; }
  if (message.id !== undefined && !message.method) {
    const completion = pending.get(message.id);
    if (!completion) return;
    clearTimeout(completion.timer);
    pending.delete(message.id);
    if (message.error) completion.reject(new Error(message.error.message));
    else completion.resolve(message.result);
  } else if (message.method) {
    report.notifications.push(message.method);
    // 验证期间永远拒绝服务端请求，禁止升级为可执行权限。
    if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Probe rejects all tool requests' } })}\n`);
  }
});
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
try {
  const init = await request('initialize', { clientInfo: { name: 'jinggong_agent_probe', title: '精工 Agent 协议验证', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  report.checks.push({ name: 'initialize', passed: true, result: init });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const auth = await request('account/read', { refreshToken: false });
  report.checks.push({ name: 'independent-auth', passed: auth.account === null, accountPresent: auth.account !== null, requiresOpenaiAuth: auth.requiresOpenaiAuth });
  const dynamicTools = ['list_project_files', 'read_project_file'].map((name) => ({ type: 'function', name, description: '项目内受控只读工具协议验证', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }));
  const thread = await request('thread/start', { cwd: workspace, approvalPolicy: 'on-request', sandbox: 'read-only', ephemeral: false, environments: [], dynamicTools });
  report.checks.push({ name: 'thread/start', passed: Boolean(thread.thread.id), threadId: thread.thread.id, cwd: thread.cwd, sandbox: thread.sandbox });
  report.checks.push({ name: 'dynamic-read-tools/no-built-in-environment', passed: Array.isArray(thread.thread.environments) && thread.thread.environments.length === 0, toolNames: dynamicTools.map((tool) => tool.name), environments: thread.thread.environments });
  const readiness = await request('windowsSandbox/readiness');
  report.checks.push({ name: 'windowsSandbox/readiness', passed: true, result: readiness });
  try {
    await request('turn/interrupt', { threadId: thread.thread.id, turnId: 'probe-no-active-turn' });
    report.checks.push({ name: 'turn/interrupt-without-active-turn', passed: true });
  } catch (error) {
    report.checks.push({ name: 'turn/interrupt-without-active-turn', passed: /not found|no active|no turn|not running/i.test(error.message), result: error.message });
  }
  try {
    const resumed = await request('thread/resume', { threadId: thread.thread.id, cwd: workspace, sandbox: 'read-only', approvalPolicy: 'untrusted' });
    report.checks.push({ name: 'empty-thread/resume', passed: resumed.thread.id === thread.thread.id });
  } catch (error) {
    report.checks.push({ name: 'empty-thread/resume', passed: /no rollout found/.test(error.message), limitation: error.message });
  }
  try {
    // 追加实际探针用户输入以测试持久化；不注入或伪造模型答复，不触发模型请求。
    await request('thread/inject_items', { threadId: thread.thread.id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '本地协议持久化探针，不调用模型。' }] }] });
    const resumed = await request('thread/resume', { threadId: thread.thread.id, cwd: workspace, sandbox: 'read-only', approvalPolicy: 'on-request' });
    report.checks.push({ name: 'persisted-user-input/resume', passed: resumed.thread.id === thread.thread.id && Array.isArray(resumed.thread.environments) && resumed.thread.environments.length === 0, environments: resumed.thread.environments, note: '动态工具未经真实模型调用，恢复后的工具调用仍待专用凭据验证' });
  } catch (error) {
    report.checks.push({ name: 'persisted-user-input/resume', passed: false, limitation: error.message });
  }
  try {
    const command = await request('command/exec', { command: [process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'type README.md'], processId: 'jinggong-read-probe', streamStdoutStderr: true, timeoutMs: 3000, cwd: workspace, sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    report.checks.push({ name: 'standalone-read-command', passed: true, result: command });
  } catch (error) {
    report.checks.push({ name: 'standalone-read-command', passed: false, limitation: error.message });
  }
  const version = await readFile(path.resolve(nativeRoot, '../../package.json'), 'utf8').then(JSON.parse).catch(() => null);
  report.packageVersion = version?.version;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const cleanExit = await Promise.race([new Promise((resolve) => child.once('exit', (code) => resolve({ code, forced: false }))), new Promise((resolve) => setTimeout(() => { child.kill(); resolve({ code: null, forced: true }); }, 4000))]);
  report.checks.push({ name: 'stdio-eof-exit', passed: !cleanExit.forced && cleanExit.code === 0, ...cleanExit });
  report.stderrBytes = stderrLength;
  lines.close();
  for (const completion of pending.values()) clearTimeout(completion.timer);
}
const output = process.argv[3];
if (output) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
