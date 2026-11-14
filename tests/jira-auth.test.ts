import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { JiraConnector, type JiraTransport } from '../packages/jira-connector/src';

// 仅使用合成账号、密码与会话，不访问真实 Jira。
const account = '合成中文账号';
const password = 'synthetic-jira-auth-password';
const sessionValue = 'synthetic-jira-session-secret';
const user = { displayName: '认证回归用户', timeZone: 'Asia/Shanghai' };
const fields = [{ id: 'customfield_11116', name: '日报日期', schema: { type: 'date' } }];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64');
function json(response: ServerResponse, value: unknown, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8' }); response.end(JSON.stringify(value)); }
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('合成 Jira 认证服务启动失败');
  return { base: `http://127.0.0.1:${address.port}/jira`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('中文账号 Basic 使用 UTF-8；服务支持 Basic 时不尝试会话登录', async () => {
  const calls: string[] = [];
  const service = await fixture((request, response) => {
    calls.push(request.url!);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(`${account}:${password}`, 'utf8').toString('base64')}`);
    assert.equal(request.headers.cookie, undefined);
    json(response, request.url!.endsWith('/myself') ? user : fields);
  });
  try {
    assert.equal((await new JiraConnector({ baseUrl: service.base, account, password }).testConnection()).displayName, user.displayName);
    assert.deepEqual(calls.sort(), ['/jira/rest/api/2/field', '/jira/rest/api/2/myself']);
  } finally { await service.close(); }
});

test('Basic 401 后中文账号用 JSON 会话认证，并行查询只登录一次，API 与图片复用内存 Cookie', async () => {
  let logins = 0, basics = 0, authenticated = 0;
  const service = await fixture((request, response) => {
    if (request.url === '/jira/rest/auth/1/session') {
      logins++;
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers['content-type'], 'application/json');
      let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        assert.deepEqual(JSON.parse(body), { username: account, password });
        json(response, { session: { name: 'JSESSIONID', value: sessionValue } });
      });
      return;
    }
    if (request.headers.authorization) { basics++; return json(response, {}, 401); }
    assert.equal(request.headers.cookie, `JSESSIONID=${sessionValue}`);
    authenticated++;
    if (request.url!.endsWith('/myself')) return json(response, user);
    if (request.url!.endsWith('/field')) return json(response, fields);
    if (request.url!.endsWith('/assignee')) { assert.equal(request.method, 'PUT'); response.writeHead(204); return response.end(); }
    if (request.url!.endsWith('/pixel.png')) { response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(png); }
    return json(response, { id: '1', key: 'NEWDEVGROUP-1', fields: { summary: sessionValue, attachment: [] } });
  });
  try {
    const connector = new JiraConnector({ baseUrl: service.base, account, password });
    assert.equal((await connector.testConnection()).fieldType, 'date');
    assert.equal((await connector.getIssue('NEWDEVGROUP-1')).summary, '[已脱敏]');
    await connector.assign('NEWDEVGROUP-1', { id: 'fixture-user', displayName: '合成用户', field: 'name' });
    assert.deepEqual((await connector.downloadImage({ id: '1', name: 'pixel.png', mimeType: 'image/png', size: png.length, url: `${service.base}/secure/attachment/1/pixel.png` })).bytes, png);
    assert.equal(logins, 1); assert.equal(basics, 2); assert.equal(authenticated, 5);
  } finally { await service.close(); }
});

test('会话登录失败仅尝试一次；验证码或权限错误不触发额外密码重试，错误正文不外泄', async () => {
  for (const reason of ['wrong-password', 'captcha', 'permission']) {
    let logins = 0;
    const transport: JiraTransport = async url => {
      if (url.endsWith('/rest/auth/1/session')) { logins++; return Response.json({ errorMessages: [password, sessionValue] }, { status: 401 }); }
      return Response.json({ errorMessages: [password] }, { status: reason === 'permission' ? 403 : 401, headers: reason === 'captcha' ? { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' } : {} });
    };
    const connector = new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account, password }, transport);
    const outcomes = await Promise.allSettled([connector.getIssue('NEWDEVGROUP-1'), connector.getIssue('NEWDEVGROUP-2')]);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') {
        assert.match(outcome.reason.message, reason === 'captcha' ? /验证码/ : reason === 'permission' ? /访问权限/ : /认证失败/);
        assert.ok(!outcome.reason.message.includes(password) && !outcome.reason.message.includes(sessionValue));
      }
    }
    await assert.rejects(connector.getIssue('NEWDEVGROUP-3'));
    assert.equal(logins, reason === 'wrong-password' ? 1 : 0);
  }
});

test('过期会话并发只更新一次，仍被拒绝时不循环登录', async () => {
  let logins = 0;
  let expired = false;
  const transport: JiraTransport = async (url, init) => {
    if (url.endsWith('/rest/auth/1/session')) { logins++; return Response.json({ session: { name: 'JSESSIONID', value: `synthetic-session-${logins}` } }); }
    const cookie = new Headers(init.headers).get('cookie');
    if (!cookie || expired && cookie === 'JSESSIONID=synthetic-session-1') return Response.json({}, { status: 401 });
    return Response.json({ id: '1', key: 'NEWDEVGROUP-1', fields: { summary: '合成任务', attachment: [] } });
  };
  const connector = new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account, password }, transport);
  await connector.getIssue('NEWDEVGROUP-1'); expired = true;
  await Promise.all([connector.getIssue('NEWDEVGROUP-1'), connector.getIssue('NEWDEVGROUP-1')]);
  assert.equal(logins, 2);
  let failedLogins = 0;
  const rejected = new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account, password }, async url => url.endsWith('/session') ? (failedLogins++, Response.json({ session: { name: 'JSESSIONID', value: sessionValue } })) : Response.json({}, { status: 401 }));
  await assert.rejects(rejected.getIssue('NEWDEVGROUP-1'), /认证失败/);
  assert.equal(failedLogins, 1);
});

test('会话响应有界且拒绝无效 Cookie，登录重定向不向其他端口转发凭据', async () => {
  for (const session of [{ name: 'JSESSIONID', value: 'bad;cookie=1' }, { name: 'bad\r\nheader', value: sessionValue }, { name: 'JSESSIONID', value: '' }, { name: 'JSESSIONID', value: 'x'.repeat(4097) }]) {
    const connector = new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account, password }, async url => url.endsWith('/session') ? Response.json({ session }) : Response.json({}, { status: 401 }));
    await assert.rejects(connector.getIssue('NEWDEVGROUP-1'), /有效会话/);
  }
  for (const declared of [false, true]) {
    const connector = new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account, password }, async url => url.endsWith('/session') ? new Response('x'.repeat(16385), { headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': '16385' } : {}) } }) : Response.json({}, { status: 401 }));
    await assert.rejects(connector.getIssue('NEWDEVGROUP-1'), /响应过大/);
  }
  let forwarded = 0;
  const target = await fixture((_request, response) => { forwarded++; json(response, {}); });
  const source = await fixture((request, response) => request.url!.endsWith('/session') ? (response.writeHead(302, { Location: `${target.base}/session` }), response.end()) : json(response, {}, 401));
  try {
    await assert.rejects(new JiraConnector({ baseUrl: source.base, account, password }).getIssue('NEWDEVGROUP-1'), /重定向/);
    assert.equal(forwarded, 0);
  } finally { await source.close(); await target.close(); }
});
