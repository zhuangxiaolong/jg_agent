import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createConnection, createServer } from 'node:net';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';

// 探针只使用一次性临时目录和无害哨兵，不读取用户配置、认证或真实密钥。
const { runtimeEnvironment } = await tsImport('../../packages/agent-runtime/src/index.ts', import.meta.url);
const firstArgument = process.argv[2];
const kind = firstArgument === 'codex' || firstArgument === 'jinggong' ? firstArgument : 'jinggong';
let nativeRoot = firstArgument && firstArgument !== kind
  ? path.resolve(firstArgument)
  : path.resolve('apps/desktop/resources/runtime', kind);
if (!firstArgument || firstArgument === kind) {
  try {
    await access(path.join(nativeRoot, 'bin', kind === 'jinggong' ? 'jinggong-runtime.exe' : 'codex.exe'));
  } catch {
    if (kind !== 'codex') {
      throw new Error('未找到独立 Jinggong Runtime，请先执行 npm run runtime:build:jinggong 和 npm run stage-runtime');
    }
    nativeRoot = path.resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc');
  }
}
const binary = path.join(nativeRoot, 'bin', kind === 'jinggong' ? 'jinggong-runtime.exe' : 'codex.exe');
// Windows TEMP 常含 ADMINI~1 短路径；先统一为真实路径，避免沙箱根集合被判作两个不同目录。
const probeRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-probe-')));
const runtimeHome = path.join(probeRoot, 'runtime-home');
const workspace = path.join(probeRoot, '工作区 中文 空格');
const outside = path.join(probeRoot, '工作区外');
await mkdir(runtimeHome);
await mkdir(workspace);
await mkdir(outside);
await writeFile(path.join(workspace, 'README.md'), '# 精工 Agent Runtime 协议验证\n', 'utf8');

const sentinelName = `JINGGONG_PROBE_DB_PASSWORD_${randomUUID().replaceAll('-', '')}`;
const sentinelValue = `harmless-probe-${randomUUID()}`;
const previousSentinel = process.env[sentinelName];
process.env[sentinelName] = sentinelValue;
const env = runtimeEnvironment(runtimeHome, sentinelValue);
if (previousSentinel === undefined) delete process.env[sentinelName];
else process.env[sentinelName] = previousSentinel;

const manifest = await readFile(path.join(nativeRoot, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => undefined);
const manifestIntegrity = { checkedFiles: [], missingFiles: [], hashMismatches: [], unsafePaths: [] };
const fileHashes = new Map();
const hashFile = async (file) => {
  const key = path.resolve(file).toLowerCase();
  if (fileHashes.has(key)) return fileHashes.get(key);
  const digest = await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
  fileHashes.set(key, digest);
  return digest;
};
const binarySha256 = await hashFile(binary);
if (Array.isArray(manifest?.files)) {
  for (const entry of manifest.files) {
    const filePath = path.resolve(nativeRoot, entry.path);
    const relativePath = path.relative(nativeRoot, filePath);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      manifestIntegrity.unsafePaths.push(entry.path);
      continue;
    }
    try {
      const digest = await hashFile(filePath);
      manifestIntegrity.checkedFiles.push(entry.path);
      if (digest !== entry.sha256) manifestIntegrity.hashMismatches.push(entry.path);
    } catch {
      manifestIntegrity.missingFiles.push(entry.path);
    }
  }
}
const report = {
  timestamp: new Date().toISOString(),
  runtimeKind: kind,
  runtimeHome,
  workspace,
  binary,
  sha256: binarySha256,
  manifest,
  manifestIntegrity,
  checks: [],
  notifications: [],
  limitations: [
    'command/exec 是协议级独立命令接口，不经过桌面逐项审批回调；本报告只证明显式 sandboxPolicy 和服务端回显，未宣称已实测模型审批 UI。',
    'readiness 只表示 Runtime 自报的 Windows sandbox 状态，不替代文件系统、网络和凭据边界实测。',
    'Windows unelevated 的 networkAccess=false 实测未阻断原始 TCP loopback；上游当前实现通过进程环境代理/离线变量重写实现网络限制，不能据此宣称操作系统级全面禁网。',
  ],
  networkProbe: {
    scope: '仅测试子进程从 command/exec 发起到 127.0.0.1 临时监听端口的原始 TCP 连接，不代表全部外网协议或目标。',
    sourceEvidence: [
      'codex-rust/windows-sandbox-rs/src/spawn_prep.rs:123-143：unelevated legacy spawn 在禁网时调用 apply_no_network_to_env。',
      'codex-rust/windows-sandbox-rs/src/env.rs:122-158：通过 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY、工具离线变量和 PATH stub 重写；默认 NO_PROXY 包含 localhost、127.0.0.1、::1。',
      'codex-rust/windows-sandbox-rs/src/unified_exec/tests.rs:254：managed networking 要求 elevated backend，unelevated 在 spawn 前失败。',
    ],
  },
};
const check = (name, passed, details = {}) => report.checks.push({ name, passed: Boolean(passed), ...details });
const cleanText = (value) => String(value ?? '')
  .replaceAll(sentinelValue, '[REDACTED]')
  .replaceAll(sentinelName, '[SENTINEL_NAME]')
  .replaceAll('JINGGONG_MODEL_API_KEY', '[MODEL_KEY_NAME]');
const compactResult = (result) => ({
  exitCode: result?.exitCode,
  stdout: cleanText(result?.stdout),
  stderr: cleanText(result?.stderr),
});
check('jinggong-manifest-file-hashes', kind !== 'jinggong' || (manifestIntegrity.checkedFiles.length > 0
  && manifestIntegrity.missingFiles.length === 0
  && manifestIntegrity.hashMismatches.length === 0
  && manifestIntegrity.unsafePaths.length === 0), {
  checkedFiles: manifestIntegrity.checkedFiles.length,
  missingFiles: manifestIntegrity.missingFiles,
  hashMismatches: manifestIntegrity.hashMismatches,
  unsafePaths: manifestIntegrity.unsafePaths,
  note: kind === 'jinggong' ? '独立 Runtime manifest 中列出的文件逐项校验 SHA-256。' : 'Codex 基线没有 Jinggong manifest；该项不适用。',
});

const config = {
  model_provider: 'jinggong',
  model: 'probe-no-model',
  'model_providers.jinggong.name': '本地协议探针，不调用模型',
  'model_providers.jinggong.base_url': 'https://probe.invalid',
  'model_providers.jinggong.env_key': 'JINGGONG_MODEL_API_KEY',
  'model_providers.jinggong.requires_openai_auth': false,
  'model_providers.jinggong.wire_api': 'responses',
  sandbox_mode: 'workspace-write',
  approval_policy: 'on-request',
  approvals_reviewer: 'user',
  'sandbox_workspace_write.network_access': false,
  'sandbox_workspace_write.writable_roots': [workspace],
  'sandbox_workspace_write.exclude_tmpdir_env_var': true,
  'sandbox_workspace_write.exclude_slash_tmp': true,
  'windows.sandbox': 'unelevated',
  'shell_environment_policy.inherit': 'core',
  'shell_environment_policy.exclude': ['JINGGONG_MODEL_API_KEY'],
  'analytics.enabled': false,
  'feedback.enabled': false,
  check_for_update_on_startup: false,
  web_search: 'disabled',
  'features.code_mode': false,
  'features.code_mode_host': false,
  'features.plugins': false,
  'features.hooks': false,
  'features.apps': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.skip_host_skill_discovery': true,
};
const args = ['app-server', '--listen', 'stdio://', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
// Windows unelevated 沙箱不接受分裂写根；服务端 cwd 与命令 cwd 必须一致。
const child = spawn(binary, args, { cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 0;
let stderrLength = 0;
let stderrDiagnostic = '';
child.stderr.on('data', (data) => {
  stderrLength += data.length;
  stderrDiagnostic = cleanText(`${stderrDiagnostic}${data}`).slice(-8192);
});
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    check('stdout-jsonl', false, { line: cleanText(line).slice(0, 300) });
    return;
  }
  if (message.id !== undefined && !message.method) {
    const completion = pending.get(message.id);
    if (!completion) return;
    clearTimeout(completion.timer);
    pending.delete(message.id);
    if (message.error) completion.reject(new Error(cleanText(message.error.message)));
    else completion.resolve(message.result);
  } else if (message.method) {
    report.notifications.push(message.method);
    // 探针不执行服务端请求，避免任何模型或工具调用升级权限。
    if (message.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Probe rejects all tool requests' } })}\n`);
    }
  }
});
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const encodedPowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64');
const powerShellLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const workspacePolicy = {
  type: 'workspaceWrite',
  writableRoots: [workspace],
  networkAccess: false,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true,
};
async function execPowerShell(script, policy = workspacePolicy, timeoutMs = 10000) {
  return request('command/exec', {
    command: [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
    timeoutMs,
    cwd: workspace,
    sandboxPolicy: policy,
  });
}
async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
}

try {
  const init = await request('initialize', {
    clientInfo: { name: 'jinggong_agent_probe', title: '精工 Agent 协议验证', version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  const expectedAgent = kind === 'codex'
    ? typeof init?.userAgent === 'string' && /\/0\.156\.1 /.test(init.userAgent) && !init.userAgent.startsWith('jinggong_runtime/')
    : typeof init?.userAgent === 'string' && init.userAgent.startsWith('jinggong_runtime/0.1.0');
  check('initialize', expectedAgent, {
    userAgent: init?.userAgent,
  });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);

  const auth = await request('account/read', { refreshToken: false });
  check('independent-auth', auth?.account === null && auth?.requiresOpenaiAuth === false, {
    accountPresent: auth?.account !== null,
    requiresOpenaiAuth: auth?.requiresOpenaiAuth,
    note: '隔离 CODEX_HOME 且未传真实认证；未读取或输出用户凭据。',
  });

  const threadParams = {
    cwd: workspace,
    model: 'probe-no-model',
    modelProvider: 'jinggong',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    ephemeral: false,
  };
  const threadResponse = await request('thread/start', threadParams);
  const thread = threadResponse?.thread;
  const threadSandbox = threadResponse?.sandbox;
  check('thread/start-policy', Boolean(thread?.id)
    && threadResponse?.approvalPolicy === 'on-request'
    && threadResponse?.approvalsReviewer === 'user'
    && threadSandbox?.type === 'workspaceWrite'
    && threadSandbox?.networkAccess === false
    && path.resolve(threadResponse?.cwd ?? '').toLowerCase() === path.resolve(workspace).toLowerCase(), {
    threadId: thread?.id,
    cwd: threadResponse?.cwd,
    sandbox: threadSandbox,
    approvalPolicy: threadResponse?.approvalPolicy,
    approvalsReviewer: threadResponse?.approvalsReviewer,
    environments: thread?.environments,
  });
  check('thread/start-local-environment', Array.isArray(thread?.environments) && thread.environments.length > 0, {
    environments: thread?.environments,
    note: '确认 app-server 为命令探针提供本地环境；不把环境列表当作安全边界证明。',
  });

  const readiness = await request('windowsSandbox/readiness');
  check('windowsSandbox/readiness', readiness?.status === 'ready', {
    result: readiness,
    note: '仅为 Runtime readiness 自报值，边界以随后真实命令结果为准。',
  });

  const persistedText = '本地协议持久化探针，不调用模型。';
  await request('thread/inject_items', {
    threadId: thread.id,
    items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: persistedText }] }],
  });
  const resumed = await request('thread/resume', {
    threadId: thread.id,
    cwd: workspace,
    model: 'probe-no-model',
    modelProvider: 'jinggong',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  });
  check('thread/resume-policy', resumed?.thread?.id === thread.id
    && resumed?.approvalPolicy === 'on-request'
    && resumed?.approvalsReviewer === 'user'
    && resumed?.sandbox?.type === 'workspaceWrite'
    && resumed?.sandbox?.networkAccess === false, {
    threadId: resumed?.thread?.id,
    cwd: resumed?.cwd,
    sandbox: resumed?.sandbox,
    approvalPolicy: resumed?.approvalPolicy,
    approvalsReviewer: resumed?.approvalsReviewer,
    environments: resumed?.thread?.environments,
  });

  const read = await execPowerShell('Get-Content -Raw -LiteralPath (Join-Path (Get-Location) \'README.md\')');
  check('command/exec-read-workspace', read?.exitCode === 0 && String(read?.stdout).includes('精工 Agent Runtime 协议验证'), compactResult(read));

  const insideFile = path.join(workspace, 'write-proof.txt');
  const write = await execPowerShell("Set-Content -LiteralPath (Join-Path (Get-Location) 'write-proof.txt') -Value 'sandbox-workspace-ok' -NoNewline; Write-Output 'write-completed'");
  check('command/exec-write-workspace', write?.exitCode === 0 && String(write?.stdout).includes('write-completed') && await exists(insideFile), {
    ...compactResult(write),
    hostFilePresent: await exists(insideFile),
  });
  const written = await readFile(insideFile, 'utf8').catch(() => '');
  check('host-observes-workspace-write', written === 'sandbox-workspace-ok', { contentLength: written.length });

  const outsideFile = path.join(outside, 'outside-proof.txt');
  const outsideScript = `$ErrorActionPreference = 'Stop'; $p = ${powerShellLiteral(outsideFile)}; try { Set-Content -LiteralPath $p -Value 'outside-write-should-fail' -NoNewline; Write-Output 'write-completed'; exit 0 } catch { Write-Output ("outside-write-blocked;category={0};error={1}" -f $_.CategoryInfo.Category, $_.FullyQualifiedErrorId); exit 17 }`;
  const outsideResult = await execPowerShell(outsideScript);
  const outsideAccessDenied = /category=PermissionDenied|UnauthorizedAccessException/i.test(String(outsideResult?.stdout));
  check('command/exec-rejects-outside-workspace-write', outsideResult?.exitCode === 17 && outsideAccessDenied && !(await exists(outsideFile)), {
    ...compactResult(outsideResult),
    hostFilePresent: await exists(outsideFile),
    accessDenied: outsideAccessDenied,
    expected: '明确 PermissionDenied / UnauthorizedAccessException，退出码17且工作区外文件不存在',
  });

  const envScript = `$s = $env:${sentinelName}; $m = $env:JINGGONG_MODEL_API_KEY; Write-Output (\"sentinelPresent={0};modelKeyPresent={1}\" -f [bool]$s, [bool]$m)`;
  const envResult = await execPowerShell(envScript);
  check('command/exec-filters-environment-credentials', envResult?.exitCode === 0
    && /sentinelPresent=False/i.test(String(envResult?.stdout))
    && /modelKeyPresent=False/i.test(String(envResult?.stdout)), {
    ...compactResult(envResult),
    expected: 'sentinelPresent=False;modelKeyPresent=False',
  });

  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const networkPort = server.address().port;
  let networkHits = 0;
  server.on('connection', () => { networkHits += 1; });
  const baselineSocket = createConnection({ host: '127.0.0.1', port: networkPort });
  await new Promise((resolve, reject) => {
    baselineSocket.once('connect', resolve);
    baselineSocket.once('error', reject);
  });
  baselineSocket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const baselineHits = networkHits;
  networkHits = 0;
  const networkScript = `if (Test-NetConnection -ComputerName 127.0.0.1 -Port ${networkPort} -InformationLevel Quiet -WarningAction SilentlyContinue) { Write-Output 'connected'; exit 0 } else { Write-Output 'blocked'; exit 17 }`;
  const networkResult = await execPowerShell(networkScript, workspacePolicy, 5000);
  await new Promise((resolve) => server.close(resolve));
  const rawLoopbackBlocked = networkResult?.exitCode !== 0 && networkHits === 0;
  check('command/exec-blocks-raw-loopback-network', baselineHits === 1 && rawLoopbackBlocked, {
    ...compactResult(networkResult),
    baselineClient: 'node:net direct TCP connection from probe parent',
    baselineHits,
    networkHits,
    rawLoopbackBlocked,
    expected: '父进程直连 listener 成功作为正向对照；受测 command/exec 在 networkAccess=false 下无法建立 TCP 连接',
    interpretation: rawLoopbackBlocked
      ? '本机 loopback TCP 被阻断；该结果不证明其他网络路径均被阻断。'
      : '本机 loopback TCP 未被阻断。unelevated 路径主要重写代理/离线环境变量，原始 TCP 探测不经过代理；见 networkProbe.sourceEvidence。',
  });
  const proxyRewriteScript = `$p = [string]$env:HTTP_PROXY; $n = [string]$env:NO_PROXY; $marker = $env:SBX_NONET_ACTIVE -eq '1'; $deniedProxy = $p -eq 'http://127.0.0.1:9'; $loopbackExcluded = $n -match '(^|,)127\.0\.0\.1(,|$)'; Write-Output ("blockMarker={0};deniedProxy={1};loopbackExcluded={2}" -f $marker, $deniedProxy, $loopbackExcluded)`;
  const proxyRewrite = await execPowerShell(proxyRewriteScript);
  check('command/exec-network-proxy-rewrite-observed', proxyRewrite?.exitCode === 0
    && /blockMarker=True/i.test(String(proxyRewrite?.stdout))
    && /deniedProxy=True/i.test(String(proxyRewrite?.stdout))
    && /loopbackExcluded=True/i.test(String(proxyRewrite?.stdout)), {
    ...compactResult(proxyRewrite),
    expected: '实际子进程出现 SBX_NONET_ACTIVE 标记、拒绝代理地址和 loopback NO_PROXY 例外；只说明代理型客户端的约束方式，不是原始 TCP 隔离。',
  });
  report.packageVersion = manifest?.runtimeVersion;
} catch (error) {
  report.error = cleanText(error?.message ?? error);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const cleanExit = await Promise.race([
    new Promise((resolve) => child.once('exit', (code) => resolve({ code, forced: false }))),
    new Promise((resolve) => setTimeout(() => { child.kill(); resolve({ code: null, forced: true }); }, 4000)),
  ]);
  check('stdio-eof-exit', !cleanExit.forced && cleanExit.code === 0, cleanExit);
  report.stderrBytes = stderrLength;
  report.stderrDiagnostic = stderrDiagnostic;
  lines.close();
  for (const completion of pending.values()) clearTimeout(completion.timer);
}
const output = process.argv[3];
if (output) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2), 'utf8');
}
if (report.checks.some((item) => !item.passed)) process.exitCode = 1;
console.log(JSON.stringify(report, null, 2));
