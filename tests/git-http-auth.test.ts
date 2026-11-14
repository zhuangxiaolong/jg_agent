import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitConnector } from '../packages/git-connector/src/index';

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec('git', args, { cwd, windowsHide: true });
const username = 'synthetic-user', password = 'synthetic-http-credential-only';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-git-http-auth-'));
  const oldHome = process.env.HOME, oldXdg = process.env.XDG_CONFIG_HOME;
  const home = join(root, 'home'), repo = join(root, 'source'), bare = join(root, 'remote.git');
  await mkdir(home); await mkdir(repo);
  process.env.HOME = home; process.env.XDG_CONFIG_HOME = home;
  const globalConfig = join(home, '.gitconfig'), helperLog = join(root, 'helper.log');
  const helper = join(root, 'helper.cjs'), malicious = join(root, 'malicious.cjs'), marker = join(root, 'untrusted-helper-ran');
  await writeFile(helper, `const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(helperLog)},[process.argv[2],process.env.GIT_TERMINAL_PROMPT,process.env.GCM_INTERACTIVE,process.env.GCM_GUI_PROMPT].join(':')+'\\n');if(process.argv[2]==='get')process.stdout.write(${JSON.stringify(`username=${username}\npassword=${password}\n\n`)});});`);
  await writeFile(malicious, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'仓库 helper 不应执行');`);
  const helperCommand = (file: string) => `!"${process.execPath.replaceAll('\\', '/')}" "${file.replaceAll('\\', '/')}"`;
  await git(repo, ['config', '--file', globalConfig, '--add', 'credential.helper', '']);
  await git(repo, ['config', '--file', globalConfig, '--add', 'credential.helper', helperCommand(helper)]);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'HTTP 认证测试']); await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(repo, 'code.txt'), '初始代码\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', '建立认证测试基线']);
  await git(root, ['clone', '--bare', repo, bare]); await git(bare, ['config', 'http.receivepack', 'true']);
  const accepted: string[] = [], children = new Set<ReturnType<typeof spawn>>();
  let responseMode: 'git' | 'authentication' | 'repository' | 'unavailable' = 'git';
  const server = createServer((request, response) => {
    if (responseMode === 'repository') { response.writeHead(404); response.end('repository not found'); return; }
    if (responseMode === 'unavailable') { response.writeHead(503); response.end('temporarily unavailable'); return; }
    if (responseMode === 'authentication' || request.headers.authorization !== `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="synthetic-only"' }); response.end('authentication required'); return;
    }
    accepted.push(request.url ?? '');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method ?? 'GET', CONTENT_TYPE: String(request.headers['content-type'] ?? ''), CONTENT_LENGTH: String(request.headers['content-length'] ?? ''), REMOTE_USER: username }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); let buffer = Buffer.alloc(0), headersSent = false;
    request.pipe(child.stdin); child.stdin.on('error', () => undefined); child.stderr.resume();
    child.stdout.on('data', chunk => {
      if (headersSent) { response.write(chunk); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const separator = buffer.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
      const end = buffer.indexOf(separator); if (end < 0) return;
      for (const line of buffer.subarray(0, end).toString().split(/\r?\n/)) {
        const colon = line.indexOf(':'); if (colon < 0) continue;
        const key = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === 'status') response.statusCode = Number(value.slice(0, 3)); else response.setHeader(key, value);
      }
      headersSent = true; response.write(buffer.subarray(end + separator.length));
    });
    child.on('error', () => { if (!headersSent) response.statusCode = 500; response.end(); });
    child.on('close', () => { children.delete(child); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/remote.git`;
  await git(repo, ['remote', 'add', 'origin', url]);
  // 仓库通用和 URL 专用 helper 都不能覆盖用户已配置的管理器。
  await git(repo, ['config', 'credential.helper', helperCommand(malicious)]);
  await git(repo, ['config', `credential.${url}.helper`, helperCommand(malicious)]);
  const connector = new GitConnector(join(root, 'workspaces')), project = await connector.register(repo);
  return { root, repo, bare, url, globalConfig, helperCommand: helperCommand(helper), helperLog, marker, accepted, connector, project,
    mode(value: typeof responseMode) { responseMode = value; },
    async close() {
      for (const child of children) child.kill(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test('HTTP 项目获取、快进拉取及推送复用可信用户凭据管理器，禁止仓库 helper 执行', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'source', 'dirty.txt'), '获取允许未提交文件\n');
    await f.connector.fetchProject(f.project, 'origin');
    await rm(join(f.repo, 'dirty.txt'));
    const peer = join(f.root, 'peer'); await git(f.root, ['clone', f.bare, peer]);
    await git(peer, ['config', 'user.name', 'HTTP 认证测试']); await git(peer, ['config', 'user.email', 'test@example.invalid']);
    await git(peer, ['config', 'core.autocrlf', 'false']);
    await writeFile(join(peer, 'code.txt'), '远程新增代码\n'); await git(peer, ['add', '.']); await git(peer, ['commit', '-m', '远程前进']); await git(peer, ['push', 'origin', 'main']);
    await f.connector.pullProject(f.project, 'origin');
    assert.equal(await readFile(join(f.repo, 'code.txt'), 'utf8'), '远程新增代码\n');
    await writeFile(join(f.repo, 'code.txt'), '项目提交代码\n'); await git(f.repo, ['add', '.']); await git(f.repo, ['commit', '-m', '项目分支前进']);
    await f.connector.pushProject(f.project, 'origin');
    assert.equal((await git(f.repo, ['rev-parse', 'HEAD'])).stdout.trim(), (await git(f.bare, ['rev-parse', 'main'])).stdout.trim());
    assert.ok(f.accepted.some(url => url.includes('git-upload-pack'))); assert.ok(f.accepted.some(url => url.includes('git-receive-pack')));
    const log = await readFile(f.helperLog, 'utf8'); assert.match(log, /get:0:never:false/); assert.ok(!log.includes(password));
    await assert.rejects(access(f.marker));
  } finally { await f.close(); }
});

test('HTTP URL 专用可信 helper 保持有效，拒绝认证时给出安全提示且不泄漏远程地址和凭据', async () => {
  const f = await fixture();
  try {
    await git(f.repo, ['config', '--file', f.globalConfig, '--unset-all', 'credential.helper']);
    await git(f.repo, ['config', '--file', f.globalConfig, 'credential.helper', '']);
    await git(f.repo, ['config', '--file', f.globalConfig, `credential.${f.url}.helper`, f.helperCommand]);
    await f.connector.fetchProject(f.project, 'origin');
    f.mode('authentication');
    await assert.rejects(f.connector.fetchProject(f.project, 'origin'), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /HTTP\(S\) 获取失败.*凭据认证未通过/); assert.ok(!error.message.includes('SSH')); assert.ok(!error.message.includes(password)); assert.ok(!error.message.includes('127.0.0.1')); return true;
    });
    await assert.rejects(access(f.marker));
  } finally { await f.close(); }
});

test('HTTP 无可信 helper 时不会执行仓库 helper 或弹交互认证框，仓库和网络错误分开提示', async () => {
  const f = await fixture();
  try {
    await git(f.repo, ['config', '--file', f.globalConfig, '--unset-all', 'credential.helper']);
    await git(f.repo, ['config', '--file', f.globalConfig, 'credential.helper', '']);
    await assert.rejects(f.connector.fetchProject(f.project, 'origin'), /凭据认证未通过/);
    await assert.rejects(access(f.marker));
    f.mode('repository'); await assert.rejects(f.connector.fetchProject(f.project, 'origin'), /远程仓库不存在或当前账号无访问权限/);
    f.mode('unavailable'); await assert.rejects(f.connector.fetchProject(f.project, 'origin'), /无法连接远程仓库或网络超时/);
  } finally { await f.close(); }
});

test('HTTPS 复用凭据及已配置的证书信任，自签名未信任时明确报告证书错误', async () => {
  const f = await fixture();
  let server: ReturnType<typeof createSecureServer> | undefined;
  try {
    const certificate = join(f.root, 'local-ca.pem'), key = join(f.root, 'local-key.pem');
    const openssl = process.env.JINGGONG_TEST_OPENSSL || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
    await exec(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', certificate], { windowsHide: true });
    server = createSecureServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
      const upstream = httpRequest(new URL(request.url ?? '/', new URL(f.url).origin), { method: request.method, headers: request.headers }, received => {
        response.writeHead(received.statusCode ?? 500, received.headers); received.pipe(response);
      });
      upstream.on('error', () => { response.statusCode = 502; response.end(); }); request.pipe(upstream);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await git(f.repo, ['remote', 'set-url', 'origin', `https://127.0.0.1:${address.port}/remote.git`]);
    await assert.rejects(f.connector.fetchProject(f.project, 'origin'), /服务器证书校验失败/);
    await git(f.repo, ['config', 'http.sslCAInfo', certificate]);
    await git(f.repo, ['config', 'http.schannelUseSSLCAInfo', 'true']);
    await f.connector.fetchProject(f.project, 'origin');
    assert.ok(f.accepted.some(url => url.includes('git-upload-pack')));
    await assert.rejects(access(f.marker));
  } finally {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await f.close();
  }
});
