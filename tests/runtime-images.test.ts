import test from 'node:test';
import assert from 'node:assert/strict';
import { access, link, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexRuntime, runtimeEnvironment } from '../packages/agent-runtime/src';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64');

test('sendTurn将真实本地图片构造为原生localImage输入；参数单元验证不代表模型推理', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-image-input-')));
  const filename = path.join(root, '截图.png'); await writeFile(filename, png);
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', apiKey: 'synthetic-image-fixture-key' });
  const state = runtime as any; state.sessions.add('thread-image-fixture'); state.sessionRoots.set('thread-image-fixture', root);
  const calls: { method: string; params: any }[] = [];
  state.request = async (method: string, params: unknown) => { calls.push({ method, params }); return { turn: { id: 'synthetic-rpc-only-turn', status: 'completed' } }; };
  await runtime.sendTurn('thread-image-fixture', '请分析截图中的生产数量', root, [filename]);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'turn/start');
  assert.deepEqual(calls[0].params.input, [{ type: 'text', text: '请分析截图中的生产数量', text_elements: [] }, { type: 'localImage', path: filename }]);
  assert.equal(calls[0].params.environments, undefined);
  assert.deepEqual(calls[0].params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [root], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  assert.equal(calls[0].params.approvalPolicy, 'never');
  await assert.rejects(runtime.sendTurn('thread-image-fixture', '不应发送', root, ['relative.png']), /路径无效/);
  await writeFile(path.join(root, '伪造.png'), '<html>不是图片</html>');
  await assert.rejects(runtime.sendTurn('thread-image-fixture', '不应发送', root, [path.join(root, '伪造.png')]), /签名/);
  await link(filename, path.join(root, 'hardlink.png'));
  await assert.rejects(runtime.sendTurn('thread-image-fixture', '不应发送', root, [filename]), /链接/);
  assert.equal(calls.length, 1);
  await runtime.close();
});

test('真实固定Windows Runtime生成localImage Schema并接受原生图片RPC，无模型密钥不发起推理', { timeout: 45000 }, async (t) => {
  if (process.platform !== 'win32') return t.skip('仅验证 Windows 原生 Runtime 协议，不证明 Jinggong Runtime 安全边界');
  let executable = path.resolve('apps/desktop/resources/runtime/bin/codex.exe');
  try { await access(executable); } catch { executable = path.resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'); try { await access(executable); } catch { return t.skip('固定Runtime尚未安装'); } }
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-real-image-'));
  const home = path.join(root, 'runtime-home'); await mkdir(home);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const filename = path.join(root, '截图.png'); await writeFile(filename, png);
  const schema = path.join(root, 'schema'); await mkdir(schema);
  await promisify(execFile)(executable, ['app-server', 'generate-ts', '--out', schema], { env: runtimeEnvironment(home), windowsHide: true, timeout: 15000 });
  const inputSchema = await readFile(path.join(schema, 'v2/UserInput.ts'), 'utf8');
  assert.match(inputSchema, /"type": "localImage"[\s\S]*?path: string/);
  assert.match(await readFile(path.join(schema, 'v2/TurnStartParams.ts'), 'utf8'), /effort\?: ReasoningEffort \| null/);
  assert.match(await readFile(path.join(schema, 'ReasoningEffort.ts'), 'utf8'), /ReasoningEffort = string/);
  const runtime = new CodexRuntime({ executable, home, baseUrl: 'https://image-model.example.invalid/v1', model: 'gpt-5.4' });
  const state = runtime as any;
  const messages: any[] = [];
  const originalReceive = state.receive.bind(runtime);
  state.receive = (message: any) => { messages.push(message); return originalReceive(message); };
  let stop: ReturnType<typeof setTimeout> | undefined;
  try {
    const threadId = await runtime.startSession(workspace);
    const failed = new Promise<string>((resolve, reject) => {
      runtime.onEvent(event => { if (event.type === 'error') resolve(event.text); });
      stop = setTimeout(() => reject(new Error('真实Runtime未报告缺少独立模型密钥')), 10000);
    });
    // 绕过应用的无密钥预检查仅验证 Rust 端真实 RPC 反序列化/图片读取；独立环境无任何模型凭据。
    const result = await state.request('turn/start', { threadId, cwd: workspace, model: 'gpt-5.4', effort: 'high', approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, input: [{ type: 'text', text: '本地图片协议验证，不执行真实推理。', text_elements: [] }, { type: 'localImage', path: filename }] });
    assert.equal(typeof result.turn.id, 'string');
    const failure = await failed;
    assert.match(failure, /JINGGONG_MODEL_API_KEY|environment variable|API key|认证|密钥/i);
    assert.ok(messages.some(message => message.method === 'item/started' && message.params?.item?.type === 'userMessage' && message.params.item.content?.some((item: any) => item.type === 'localImage' && item.path === filename)), '原生Runtime应发布包含图片路径的真实userMessage事件');
    await assert.rejects(runtime.sendTurn(threadId, '无密钥不可发起推理', workspace, [filename]), /尚未配置模型 API Key/);
  } finally { if (stop) clearTimeout(stop); await runtime.close(); }
});
