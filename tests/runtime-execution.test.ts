import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { CodexRuntime, runtimeEnvironment } from '../packages/agent-runtime/src';

test('真实原生执行环境可修改大文件、执行命令、调用HTTP并写入本地SQL数据库，旧禁用环境可恢复', { timeout: 45000 }, async t => {
  if (process.platform !== 'win32') return t.skip('Windows 原生运行时验证');
  const executable = path.resolve('apps/desktop/resources/runtime/bin/codex.exe');
  try { await access(executable); } catch { return t.skip('请先准备固定版本 Runtime'); }
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-full-development-'));
  const workspace = path.join(root, '开发测试 空格'); await mkdir(workspace);
  const source = '// 大文件读取修改验证\n'.repeat(20000) + 'const value = 1;\n';
  await writeFile(path.join(workspace, 'large.js'), source);
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    assert.equal(request.method, 'POST');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: '本地 API 调用成功' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const runtime = new CodexRuntime({ executable, home: path.join(root, 'runtime-home'), baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', mode: 'read' });
  const state = runtime as any;
  const seen: any[] = [];
  const actualRequest = state.request.bind(runtime);
  state.request = async (method: string, params: any) => { const result = await actualRequest(method, params); seen.push({ method, params, result }); return result; };
  try {
    const threadId = await runtime.startSession(workspace);
    const started = seen.find(item => item.method === 'thread/start');
    assert.equal(started.result.sandbox.type, 'dangerFullAccess');
    assert.equal(started.result.approvalPolicy, 'never');
    assert.ok(started.result.thread.environments.length > 0);
    const script = `
      const fs = require('node:fs');
      const initSqlJs = require(${JSON.stringify(path.resolve('node_modules/sql.js/dist/sql-wasm.js'))});
      (async () => {
        const original = fs.readFileSync('large.js', 'utf8');
        if (Buffer.byteLength(original) <= 128 * 1024) throw Error('测试文件过小');
        fs.writeFileSync('large.js', original.replace('const value = 1;', 'const value = 2;'));
        const response = await fetch('http://127.0.0.1:${port}/test', { method: 'POST' });
        const api = await response.json();
        if (!response.ok) throw Error('HTTP 请求失败');
        const SQL = await initSqlJs();
        const db = new SQL.Database();
        db.run('CREATE TABLE TEST_LOG (ID INTEGER PRIMARY KEY, MESSAGE TEXT)');
        db.run('BEGIN'); db.run('INSERT INTO TEST_LOG VALUES (?, ?)', [1, api.message]); db.run('COMMIT');
        const rows = db.exec('SELECT ID, MESSAGE FROM TEST_LOG')[0].values;
        fs.writeFileSync('fixture.sqlite', db.export()); db.close();
        console.log(JSON.stringify({ fileChanged: true, httpStatus: response.status, rows }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    // 调用应用实际启动的原生执行服务，不替换命令执行、HTTP 或 SQL 实现，不请求模型。
    const command = await actualRequest('command/exec', { command: [process.execPath, '-e', script], cwd: workspace, disableTimeout: true });
    assert.equal(command.exitCode, 0, command.stderr);
    assert.deepEqual(JSON.parse(command.stdout.trim()), { fileChanged: true, httpStatus: 200, rows: [[1, '本地 API 调用成功']] });
    assert.equal(await readFile(path.join(workspace, 'large.js'), 'utf8'), source.replace('const value = 1;', 'const value = 2;'));
    const syntax = await actualRequest('command/exec', { command: [process.execPath, '--check', 'large.js'], cwd: workspace });
    assert.equal(syntax.exitCode, 0, syntax.stderr);
    const SQL = await initSqlJs(), database = new SQL.Database(await readFile(path.join(workspace, 'fixture.sqlite')));
    try { assert.deepEqual(database.exec('SELECT ID, MESSAGE FROM TEST_LOG')[0].values, [[1, '本地 API 调用成功']]); } finally { database.close(); }
    assert.equal(calls, 1);

    const legacy = await actualRequest('thread/start', { cwd: workspace, sandbox: 'read-only', approvalPolicy: 'on-request', environments: [], ephemeral: false });
    assert.deepEqual(legacy.thread.environments, []);
    await actualRequest('thread/inject_items', { threadId: legacy.thread.id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧会话恢复测试，保留真实用户历史。' }] }] });
    await runtime.close();
    assert.equal(await runtime.resumeSession(legacy.thread.id, workspace), legacy.thread.id);
    const resumed = [...seen].reverse().find(item => item.method === 'thread/resume').result;
    assert.equal(resumed.sandbox.type, 'dangerFullAccess');
    assert.equal(resumed.approvalPolicy, 'never');
    assert.ok(resumed.thread.environments.length > 0);
    assert.ok((await readFile(resumed.thread.path, 'utf8')).includes('旧会话恢复测试'));
  } finally {
    await runtime.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('完整开发保留数据库及工具链环境，命令事件展示真实输出，旧审批不再一律拒绝', () => {
  const previous = process.env.JINGGONG_EXECUTION_FIXTURE;
  process.env.JINGGONG_EXECUTION_FIXTURE = 'test-config';
  try { assert.equal(runtimeEnvironment('fixture').JINGGONG_EXECUTION_FIXTURE, 'test-config'); }
  finally { if (previous === undefined) delete process.env.JINGGONG_EXECUTION_FIXTURE; else process.env.JINGGONG_EXECUTION_FIXTURE = previous; }
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' });
  const state = runtime as any, replies: any[] = [], events: any[] = [];
  state.write = (message: any) => replies.push(message);
  runtime.onEvent(event => events.push(event));
  state.sessions.add('current'); state.setActive('current', 'turn');
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
    state.receive({ id: 1, method, params: { threadId: 'current', turnId: 'turn' } });
    assert.equal(replies.pop().result.decision, 'acceptForSession');
    state.receive({ id: 2, method, params: { threadId: 'other', turnId: 'turn' } });
    assert.equal(replies.pop().result.decision, 'decline');
  }
  state.receive({ method: 'item/completed', params: { threadId: 'current', item: { type: 'commandExecution', command: 'dotnet build', exitCode: 0, aggregatedOutput: 'Build succeeded.' } } });
  assert.match(events.at(-1).text, /dotnet build[\s\S]*退出码：0[\s\S]*Build succeeded/);
});
