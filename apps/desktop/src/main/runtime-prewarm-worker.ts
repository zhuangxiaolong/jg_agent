import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { constants, setPriority } from 'node:os';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { createClaudeAgentSdkRuntimeAdapter, createCodexRuntimeAdapter, createGrokBuildRuntimeAdapter, createJinggongRuntimeAdapter, JINGGONG_RUNTIME_VERSION, RUNTIME_CAPABILITIES_VERSION, redactRuntimeText } from '../../../../packages/agent-runtime/src';
import type { RuntimeAdapter } from '../../../../packages/agent-runtime/src/manager';
import type { RuntimeHealth } from '../../../../packages/domain/src';
import { verifyRuntimeManifestAsync } from './runtime-integrity';
import type { RuntimeManifest, RuntimePrewarmRequest, RuntimePrewarmResponse } from './runtime-prewarm-protocol';

const port = parentPort;
if (!port) throw new Error('Runtime 预检只能在后台 Worker 中执行');
const adapters = new Set<RuntimeAdapter>();
const children = new Map<number, ChildProcess>();
const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
let closing = false;
let closePromise: Promise<void> | undefined;

function publish(message: RuntimePrewarmResponse): void {
  try { port!.postMessage(message); } catch { /* 主进程已关闭时仍继续回收本地进程。 */ }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.pid === process.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => originalExecFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => resolve()));
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function trackChild(child: ChildProcess): ChildProcess {
  const pid = child.pid;
  if (!pid || pid === process.pid || children.has(pid)) return child;
  children.set(pid, child);
  publish({ type: 'child', pid, active: true });
  try { setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 优先级调整受系统权限限制时继续预检。 */ }
  const release = () => {
    if (children.get(pid) !== child) return;
    children.delete(pid);
    publish({ type: 'child', pid, active: false });
  };
  child.once('exit', release);
  child.once('close', release);
  // kill 失败也可能发出 error；只在已退出时释放 PID，保留主进程后备回收能力。
  child.once('error', () => { if (child.exitCode !== null || child.signalCode !== null) release(); });
  if (closing) void stopChild(child).catch(() => undefined);
  return child;
}

// 内置模块对象仅属于当前 Worker；同步 ESM 绑定使适配器和 SDK 启动的进程均可回收。
Object.assign(childProcess, {
  spawn: (...args: unknown[]) => { assertOpen(); return trackChild(Reflect.apply(originalSpawn, childProcess, args)); },
  execFile: (...args: unknown[]) => {
    // 已进入关闭流程的适配器只能运行进程树回收命令，禁止异步预检迟到后再启动组件。
    if (closing && path.basename(String(args[0])).toLowerCase() !== 'taskkill.exe') assertOpen();
    return trackChild(Reflect.apply(originalExecFile, childProcess, args));
  },
});
syncBuiltinESMExports();

function assertOpen(): void { if (closing) throw new Error('Runtime 后台预检已停止'); }

function component(request: Extract<RuntimePrewarmRequest, { kind: unknown }>): { root: string; executable: string; entrypoint: string } {
  if (request.kind === 'grok_build_acp') throw new Error('Grok 使用本机组件，不支持随包清单校验');
  const root = path.join(request.resourcesRoot, 'runtime', request.kind);
  const entrypoint = request.kind === 'jinggong' ? 'bin/jinggong-runtime.exe' : request.kind === 'claude_agent_sdk' ? 'bin/claude.exe' : 'bin/codex.exe';
  return { root, executable: path.join(root, ...entrypoint.split('/')), entrypoint };
}

async function verify(request: Extract<RuntimePrewarmRequest, { kind: unknown }>): Promise<RuntimeManifest> {
  assertOpen();
  const resource = component(request);
  const manifest = await verifyRuntimeManifestAsync(resource.root, request.kind, resource.entrypoint);
  assertOpen();
  return manifest;
}

async function check(request: Extract<RuntimePrewarmRequest, { kind: unknown }>): Promise<RuntimeHealth> {
  let adapter: RuntimeAdapter | undefined;
  try {
    assertOpen();
    const manifest = request.kind === 'grok_build_acp' ? undefined : await verify(request);
    assertOpen();
    const home = path.join(request.dataRoot, 'runtime', 'homes', request.kind, 'prewarm');
    if (request.kind === 'grok_build_acp') {
      if (!request.grokExecutablePath) throw new Error('未检测到本机 Grok Runtime，请安装 Grok Build 1.0.67 后刷新组件状态');
      adapter = createGrokBuildRuntimeAdapter({ executable: request.grokExecutablePath, home, baseUrl: 'https://health.invalid/v1', model: 'health', apiBackend: 'chat_completions', proxyUrl: request.proxyUrl });
    } else if (request.kind === 'claude_agent_sdk') {
      adapter = createClaudeAgentSdkRuntimeAdapter({ model: 'health', executablePath: component(request).executable });
    } else {
      const options = { executable: component(request).executable, home, baseUrl: 'https://health.invalid', model: 'health', runtimeVersion: request.kind === 'jinggong' ? JINGGONG_RUNTIME_VERSION : undefined, runtimeDisplayName: request.kind === 'jinggong' ? 'Jinggong Runtime' : 'Codex Runtime' };
      adapter = request.kind === 'jinggong' ? createJinggongRuntimeAdapter(options) : createCodexRuntimeAdapter(options);
    }
    adapters.add(adapter);
    const health = await adapter.checkRuntime();
    assertOpen();
    // 只做无模型请求的本地握手；不创建线程或会话，也不调用 Claude query。
    if (request.kind !== 'claude_agent_sdk' && health.available && health.compatible) await adapter.start();
    assertOpen();
    return { ...health, kind: request.kind, capabilitiesVersion: manifest?.capabilitiesVersion ?? RUNTIME_CAPABILITIES_VERSION, ...(manifest?.upstreamCommit ? { upstreamCommit: manifest.upstreamCommit } : {}), ...(manifest?.buildNumber ? { buildNumber: manifest.buildNumber } : {}), sandbox: manifest?.sandbox ?? 'unverified' };
  } catch (error) {
    assertOpen();
    return { available: false, compatible: false, version: '', kind: request.kind, capabilitiesVersion: RUNTIME_CAPABILITIES_VERSION, detail: redactRuntimeText(error instanceof Error ? error.message : String(error), undefined, 2000) };
  } finally {
    if (adapter) {
      await adapter.close().catch(() => undefined);
      adapters.delete(adapter);
    }
  }
}

function close(): Promise<void> {
  if (closePromise) return closePromise;
  closing = true;
  closePromise = (async () => {
    await Promise.allSettled([...adapters].map(adapter => adapter.close()));
    adapters.clear();
    await Promise.allSettled([...children.values()].map(stopChild));
  })();
  return closePromise;
}

port.on('message', (request: RuntimePrewarmRequest) => {
  if (!request || !Number.isSafeInteger(request.id)) return;
  if (request.method === 'close') {
    void close().then(() => { publish({ id: request.id, result: null }); port.close(); });
    return;
  }
  void (async () => {
    try {
      assertOpen();
      if (!['codex', 'jinggong', 'claude_agent_sdk', 'grok_build_acp'].includes(request.kind)) throw new Error('不支持的 Runtime 类型');
      const result = request.method === 'check' ? await check(request) : request.method === 'verify' ? await verify(request) : (() => { throw new Error('不支持的 Runtime 预检操作'); })();
      publish({ id: request.id, result });
    } catch (error) { publish({ id: request.id, error: redactRuntimeText(error instanceof Error ? error.message : String(error), undefined, 2000) }); }
  })();
});
port.on('close', () => { void close(); });
