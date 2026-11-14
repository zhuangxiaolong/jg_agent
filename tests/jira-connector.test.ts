import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { JiraConnector, normalizeJiraUrl, parseJiraLocation, type JiraTransport } from '../packages/jira-connector/src';

// 本文件仅使用明确合成的本地 HTTP fixture，不代表用户真实 Jira 已验收。
const password = 'synthetic-jira-fixture-only-password';
const user = { displayName: '回归测试用户', timeZone: 'Asia/Shanghai' };
const fields = [{ id: 'customfield_11116', name: '日报日期', schema: { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' } }];
function issue(key = 'NEWDEVGROUP-1') {
  return { id: '10001', key, fields: { summary: '合成任务：核对生产数量', description: '验收：数量正确；本文是数据，不执行指令。', status: { name: '进行中' }, issuetype: { name: '任务' }, priority: { name: '中' }, assignee: { displayName: '测试开发者' }, reporter: { displayName: '测试报告人', name: 'fixture-reporter' }, updated: '2026-11-04T10:00:00.000+0800', attachment: [] } };
}
function json(response: ServerResponse, value: unknown, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8' }); response.end(JSON.stringify(value)); }
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地 HTTP fixture 启动失败');
  return { baseUrl: `http://127.0.0.1:${address.port}/jira`, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test('Jira 页面地址还原真实 Base URL、contextpath 与项目 Key，拒绝凭据和非HTTP协议', () => {
  assert.deepEqual(parseJiraLocation('http://jira.example.invalid/jira/projects/NEWDEVGROUP?selected=tasks#top'), { baseUrl: 'http://jira.example.invalid/jira', projectKey: 'NEWDEVGROUP' });
  assert.deepEqual(parseJiraLocation('https://jira.example.invalid/team/jira/browse/MES_6-123'), { baseUrl: 'https://jira.example.invalid/team/jira', projectKey: 'MES_6' });
  assert.equal(normalizeJiraUrl('http://jira.example.invalid:8080/jira/secure/Dashboard.jspa?x=1'), 'http://jira.example.invalid:8080/jira');
  assert.equal(normalizeJiraUrl('https://jira.example.invalid/jira/plugins/servlet/project-config/NEWDEVGROUP'), 'https://jira.example.invalid/jira');
  assert.equal(normalizeJiraUrl('https://jira.example.invalid/normal/context/'), 'https://jira.example.invalid/normal/context');
  assert.equal(normalizeJiraUrl('https://jira.example.invalid/'), 'https://jira.example.invalid');
  for (const location of ['file:///tmp/jira', 'javascript:alert(1)', 'ftp://jira.example.invalid', 'http://user:password@jira.example.invalid', 'http://jira.example.invalid/a%2fb/projects/KEY', 'not-a-url']) assert.throws(() => normalizeJiraUrl(location));
});

test('合成 HTTP REST2：读取用户/日期字段、日期任务分页及详情，只发送 GET 与独立Basic认证', async () => {
  const requests: { url: URL; method?: string; auth?: string }[] = [];
  let base = '';
  const service = await fixture((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    requests.push({ url, method: request.method, auth: request.headers.authorization });
    if (url.pathname === '/jira/rest/api/2/myself') return json(response, user);
    if (url.pathname === '/jira/rest/api/2/field') return json(response, fields);
    if (url.pathname === '/jira/rest/api/2/search') return json(response, { startAt: Number(url.searchParams.get('startAt')), maxResults: 2, total: 3, issues: url.searchParams.get('startAt') === '2' ? [issue('NEWDEVGROUP-3')] : [issue(), issue('NEWDEVGROUP-2')] });
    if (url.pathname === '/jira/rest/api/2/issue/NEWDEVGROUP-1') return json(response, { ...issue(), fields: { ...issue().fields, attachment: [{ id: '25', filename: '验收说明.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 1234, content: `${base}/secure/attachment/25/spec.docx` }] } });
    json(response, {}, 404);
  });
  base = service.baseUrl;
  try {
    const connector = new JiraConnector({ baseUrl: `${base}/projects/NEWDEVGROUP?x=1`, account: 'fixture-user', password });
    assert.deepEqual(await connector.testConnection(), { displayName: user.displayName, timeZone: user.timeZone, fieldName: '日报日期', fieldType: 'date' });
    const first = await connector.searchIssues({ date: '2026-11-04', onlyMine: true });
    assert.equal(first.issues.length, 2);
    assert.equal(first.isLast, false);
    assert.equal(first.timeZone, 'Asia/Shanghai');
    assert.match(first.jql, /project = "NEWDEVGROUP" AND cf\[11116\] = "2026-11-04" AND assignee = currentUser\(\)/);
    assert.equal(first.issues[0].summary, '合成任务：核对生产数量');
    assert.equal(first.issues[0].reporter, '测试报告人');
    const second = await connector.searchIssues({ date: '2026-11-04', startAt: 2 });
    assert.equal(second.isLast, true);
    assert.equal(second.issues[0].key, 'NEWDEVGROUP-3');
    const detail = await connector.getIssue('NEWDEVGROUP-1');
    assert.equal(detail.url, `${base}/browse/NEWDEVGROUP-1`);
    assert.equal(detail.reporter, '测试报告人');
    assert.equal(detail.attachments[0].name, '验收说明.docx');
    assert.equal(detail.attachments[0].url, `${base}/secure/attachment/25/spec.docx`);
    assert.ok(requests.every(item => item.method === 'GET' && item.auth === `Basic ${Buffer.from(`fixture-user:${password}`).toString('base64')}`));
    const search = requests.find(item => item.url.pathname.endsWith('/search'))!;
    assert.equal(search.url.searchParams.get('maxResults'), '50');
    assert.equal(search.url.searchParams.get('fields'), 'summary,description,issuetype,status,priority,assignee,reporter,updated,attachment,customfield_11116');
    await assert.rejects(connector.getIssue('OTHER-1'), /配置的 Jira 项目/);
  } finally { await service.close(); }
});

test('最近任务通过真实HTTP省去日报条件，保留项目、负责人、排序与分页；日报默认为原行为', async () => {
  const queries: string[] = [];
  const service = await fixture((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname.endsWith('/myself')) return json(response, user);
    if (url.pathname.endsWith('/field')) return json(response, fields);
    if (url.pathname.endsWith('/search')) {
      const jql = url.searchParams.get('jql')!;
      queries.push(jql);
      // 合成任务没有日报字段：只有不限日期查询能够返回，不伪造实际用户任务。
      const recent = !jql.includes('cf[');
      return json(response, { startAt: 0, maxResults: 50, total: recent ? 1 : 0, issues: recent ? [issue()] : [] });
    }
    json(response, {}, 404);
  });
  try {
    const connector = new JiraConnector({ baseUrl: service.baseUrl, account: 'fixture', password });
    const recent = await connector.searchIssues({ date: '2026-11-04', scope: 'recent' });
    assert.equal(recent.jql, 'project = "NEWDEVGROUP" ORDER BY updated DESC, key ASC');
    assert.equal(recent.issues.length, 1);
    assert.equal(recent.isLast, true);
    const mine = await connector.searchIssues({ date: '2026-11-04', scope: 'recent', onlyMine: true });
    assert.equal(mine.jql, 'project = "NEWDEVGROUP" AND assignee = currentUser() ORDER BY updated DESC, key ASC');
    const daily = await connector.searchIssues({ date: '2026-11-04' });
    const explicitDaily = await connector.searchIssues({ date: '2026-11-04', scope: 'daily' });
    assert.equal(daily.jql, explicitDaily.jql);
    assert.equal(daily.jql, 'project = "NEWDEVGROUP" AND cf[11116] = "2026-11-04" ORDER BY updated DESC, key ASC');
    assert.equal(daily.issues.length, 0);
    const queryCount = queries.length;
    for (const scope of ['', 'all', 'recent OR project = OTHER', 1, null]) {
      await assert.rejects(connector.searchIssues({ date: '2026-11-04', scope } as unknown as Parameters<JiraConnector['searchIssues']>[0]), /查询范围/);
    }
    assert.equal(queries.length, queryCount);
    await assert.rejects(connector.searchIssues({ date: '2026-02-29', scope: 'recent' }), /日期/);
    await assert.rejects(connector.searchIssues({ date: '2026-11-04', scope: 'recent', startAt: -1 }), /分页/);
  } finally { await service.close(); }
});

test('合成CD日报任务与跨项目分页：本次项目筛选不修改实例默认，所有项目仍保留日期和负责人条件', async () => {
  const requests: { method?: string; url: URL }[] = [];
  let wrongProject = false;
  const service = await fixture((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    requests.push({ method: request.method, url });
    if (url.pathname.endsWith('/myself')) return json(response, user);
    if (url.pathname.endsWith('/field')) return json(response, fields);
    if (url.pathname.endsWith('/search')) {
      const jql = url.searchParams.get('jql')!;
      const startAt = Number(url.searchParams.get('startAt'));
      const cd = (key: string) => ({ ...issue(key), fields: { ...issue(key).fields, customfield_11116: '2026-11-04' } });
      if (jql.includes('project = "NEWDEVGROUP"')) return json(response, { startAt, maxResults: 2, total: 0, issues: [] });
      if (jql.includes('project = "CD"')) return json(response, { startAt, maxResults: 2, total: 2, issues: wrongProject ? [issue('OTHER-1')] : [cd('CD-435'), cd('CD-434')] });
      return json(response, { startAt, maxResults: 2, total: 3, issues: startAt === 0 ? [cd('CD-435'), issue()] : [cd('CD-434')] });
    }
    if (url.pathname.endsWith('/issue/CD-435')) return json(response, issue(wrongProject ? 'OTHER-1' : 'CD-435'));
    if (url.pathname.endsWith('/issue/OTHER-1')) return json(response, {}, 403);
    return json(response, {}, 404);
  });
  try {
    const connector = new JiraConnector({ baseUrl: `${service.baseUrl}/projects/NEWDEVGROUP`, account: 'fixture', password });
    assert.equal((await connector.searchIssues({ date: '2026-11-04' })).total, 0);
    const cd = await connector.searchIssues({ date: '2026-11-04', projectKey: 'cd', onlyMine: true });
    assert.deepEqual(cd.issues.map(value => value.key), ['CD-435', 'CD-434']);
    assert.equal(cd.jql, 'project = "CD" AND cf[11116] = "2026-11-04" AND assignee = currentUser() ORDER BY updated DESC, key ASC');
    const first = await connector.searchIssues({ date: '2026-11-04', projectKey: '*', onlyMine: true });
    assert.equal(first.jql, 'cf[11116] = "2026-11-04" AND assignee = currentUser() ORDER BY updated DESC, key ASC');
    assert.deepEqual(first.issues.map(value => value.key), ['CD-435', 'NEWDEVGROUP-1']);
    assert.equal(first.isLast, false);
    const second = await connector.searchIssues({ date: '2026-11-04', projectKey: '*', startAt: 2 });
    assert.equal(second.issues[0].key, 'CD-434');
    assert.equal(second.isLast, true);
    assert.equal((await connector.searchIssues({ date: '2026-11-04', projectKey: '*', scope: 'recent' })).jql, 'ORDER BY updated DESC, key ASC');
    assert.equal((await connector.getIssue('CD-435', '*')).key, 'CD-435');
    assert.equal((await connector.getIssue('CD-435', 'CD')).key, 'CD-435');
    await assert.rejects(connector.getIssue('OTHER-1', '*'), /访问权限/);
    await assert.rejects(connector.getIssue('CD-435'), /配置的 Jira 项目/);
    await assert.rejects(connector.getIssue('OTHER-1'), /配置的 Jira 项目/);
    await assert.rejects(connector.getIssue('CD-435', 'NEWDEVGROUP'), /配置的 Jira 项目/);
    assert.equal((await connector.searchIssues({ date: '2026-11-04' })).total, 0);
    const requestCount = requests.length;
    for (const projectKey of ['', 'CD" OR project = OTHER', 'CD OR 1=1', 'CD/../OTHER', 'A'.repeat(65), null, 1]) {
      await assert.rejects(connector.searchIssues({ date: '2026-11-04', projectKey } as unknown as Parameters<JiraConnector['searchIssues']>[0]), /项目 Key/);
      await assert.rejects(connector.getIssue('CD-435', projectKey as string), /项目 Key/);
    }
    assert.equal(requests.length, requestCount);
    wrongProject = true;
    await assert.rejects(connector.searchIssues({ date: '2026-11-04', projectKey: 'CD' }), /之外/);
    await assert.rejects(connector.getIssue('CD-435', 'CD'), /之外/);
    assert.ok(requests.every(request => request.method === 'GET'));
  } finally { await service.close(); }
});

test('只读项目列表验证有界字段、项目数量与重复项，清单不会改变查询范围或扩展服务器权限', async () => {
  const projects = [{ id: '101', key: 'CD', name: '合成CD项目' }, { id: '102', key: 'NEWDEVGROUP', name: '合成开发项目' }];
  const requests: { path: string; method?: string; auth?: string }[] = [];
  const service = await fixture((request, response) => {
    requests.push({ path: new URL(request.url!, 'http://localhost').pathname, method: request.method, auth: request.headers.authorization });
    return json(response, projects);
  });
  try {
    const connector = new JiraConnector({ baseUrl: service.baseUrl, account: 'fixture', password });
    assert.deepEqual(await connector.listProjects(), projects);
    await assert.rejects(connector.getIssue('CD-435'), /配置的 Jira 项目/);
    assert.deepEqual(requests, [{ path: '/jira/rest/api/2/project', method: 'GET', auth: `Basic ${Buffer.from(`fixture:${password}`).toString('base64')}` }]);
  } finally { await service.close(); }
  for (const value of [
    {}, projects[0], [{ ...projects[0], id: 101 }], [{ ...projects[0], id: '1'.repeat(33) }], [{ ...projects[0], key: 'A'.repeat(65) }], [{ ...projects[0], key: 'CD" OR 1=1' }], [{ ...projects[0], name: '' }], [{ ...projects[0], name: 'n'.repeat(257) }], [{ ...projects[0], name: 'name\nforged' }],
    [projects[0], projects[0]], [projects[0], { ...projects[1], id: projects[0].id }], [projects[0], { ...projects[1], key: projects[0].key }], Array.from({ length: 5001 }, (_, index) => ({ id: String(index), key: `KEY_${index}`, name: '合成项目' })),
  ]) await assert.rejects(new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password }, async () => Response.json(value)).listProjects(), /项目列表/);
  assert.deepEqual(await new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password }, async () => Response.json([])).listProjects(), []);
  const redacted = await new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password }, async () => Response.json([{ ...projects[0], name: password }])).listProjects();
  assert.equal(redacted[0].name, '[已脱敏]');
});

test('详情返回Key须与请求严格一致，所有项目与指定项目均不接受另一条任务', async () => {
  const requested: string[] = [];
  const service = await fixture((request, response) => {
    requested.push(new URL(request.url!, 'http://localhost').pathname);
    json(response, issue('CD-434'));
  });
  try {
    const connector = new JiraConnector({ baseUrl: service.baseUrl, account: 'fixture', password });
    for (const project of ['*', 'CD']) await assert.rejects(connector.getIssue('CD-435', project), /任务 Key 与所选任务不一致/);
    assert.equal((await connector.getIssue('CD-434', '*')).key, 'CD-434');
    assert.deepEqual(requested, ['/jira/rest/api/2/issue/CD-435', '/jira/rest/api/2/issue/CD-435', '/jira/rest/api/2/issue/CD-434']);
  } finally { await service.close(); }
});

test('合成日期时间字段使用真实用户时区与次日半开区间，正确跨闰日和年末', async () => {
  const captured: string[] = [];
  const transport: JiraTransport = async (value) => {
    const url = new URL(value);
    let data: unknown;
    if (url.pathname.endsWith('/myself')) data = { ...user, timeZone: 'America/New_York' };
    else if (url.pathname.endsWith('/field')) data = [{ id: 'customfield_222', name: '测试时间', schema: { type: 'datetime', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datetime' } }];
    else { captured.push(url.searchParams.get('jql')!); data = { startAt: 0, maxResults: 50, total: 0, issues: [] }; }
    return Response.json(data);
  };
  const connector = new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account: 'fixture', password, projectKey: 'MES6', dateFieldId: '222' }, transport);
  assert.equal((await connector.searchIssues({ date: '2024-02-29' })).timeZone, 'America/New_York');
  await connector.searchIssues({ date: '2026-12-31' });
  assert.match(captured[0], /cf\[222\] >= "2024-02-29 00:00" AND cf\[222\] < "2024-03-01 00:00"/);
  assert.match(captured[1], /< "2027-01-01 00:00"/);
  for (const date of ['2026-02-29', '2026-13-01', '2026-11-04" OR project=OTHER', '0001-01-01']) await assert.rejects(connector.searchIssues({ date }), /日期/);
  await assert.rejects(connector.searchIssues({ date: '2026-11-04', startAt: -1 }), /分页/);
  assert.throws(() => new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password, projectKey: 'KEY" OR x=y' }), /项目 Key/);
  assert.throws(() => new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password, dateFieldId: '11116] OR x=y' }), /字段 ID/);
});

test('合成认证/验证码/权限/404/限流错误只返回中文，不回显服务端正文或密码', async () => {
  for (const [status, pattern, captcha] of [[401, /认证失败/, false], [403, /访问权限/, false], [404, /不存在/, false], [429, /过于频繁/, false], [500, /暂时不可用/, false], [403, /验证码/, true]] as const) {
    const service = await fixture((_request, response) => {
      if (captcha) response.setHeader('X-Seraph-LoginReason', 'AUTHENTICATION_DENIED');
      json(response, { errorMessages: [`server-body-${password}`] }, status);
    });
    try {
      const connector = new JiraConnector({ baseUrl: service.baseUrl, account: 'fixture', password });
      await assert.rejects(connector.getIssue('NEWDEVGROUP-1'), (error: Error) => { assert.match(error.message, pattern); assert.ok(!error.message.includes(password) && !error.message.includes('server-body')); return true; });
    } finally { await service.close(); }
  }
});

test('真实 HTTP 重定向不会向其他主机或端口发送认证；错误JSON与非JSON不作为任务', async () => {
  let forwarded = 0;
  const target = await fixture((_request, response) => { forwarded++; json(response, issue()); });
  const redirect = await fixture((_request, response) => { response.writeHead(302, { Location: `${target.baseUrl}/rest/api/2/issue/NEWDEVGROUP-1` }); response.end(); });
  try {
    await assert.rejects(new JiraConnector({ baseUrl: redirect.baseUrl, account: 'fixture', password }).getIssue('NEWDEVGROUP-1'), /重定向/);
    assert.equal(forwarded, 0);
  } finally { await redirect.close(); await target.close(); }
  for (const response of [new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }), Response.json({ errorMessages: ['synthetic error body'] }), Response.json({ message: 'not an issue' }), new Response('{broken-json', { headers: { 'Content-Type': 'application/json' } })]) {
    await assert.rejects(new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password }, async () => response).getIssue('NEWDEVGROUP-1'), /JSON|任务结构|查询错误/);
  }
});

test('响应大小、字段类型、未知时区与畸形分页明确失败，不猜测或静默丢数据', async () => {
  await assert.rejects(new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password }, async () => new Response('x', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(8 * 1024 * 1024 + 1) } })).getIssue('NEWDEVGROUP-1'), /8 MiB/);
  await assert.rejects(new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password }, async () => new Response('x'.repeat(8 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })).getIssue('NEWDEVGROUP-1'), /8 MiB/);
  for (const [myself, fieldData, page, expected] of [
    [{ ...user, timeZone: undefined }, fields, {}, /时区/],
    [{ ...user, timeZone: 'MadeUp/Zone' }, fields, {}, /时区/],
    [user, [{ id: 'customfield_11116', schema: { type: 'string' } }], {}, /Date/],
    [user, [], {}, /字段/],
    [user, fields, { startAt: 0, maxResults: 50, total: 2, issues: [] }, /分页/],
    [user, fields, { startAt: 0, maxResults: 50, total: 1, issues: [issue('OTHER-1')] }, /之外/],
  ] as const) {
    const transport: JiraTransport = async value => Response.json(value.endsWith('/myself') ? myself : value.endsWith('/field') ? fieldData : page);
    await assert.rejects(new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password }, transport).searchIssues({ date: '2026-11-04' }), expected);
  }
});

test('ADF描述保持文本、字段空值不造任务，不安全附件URL与已知密码不回传', async () => {
  const value = issue();
  const transport: JiraTransport = async () => Response.json({ ...value, fields: { summary: password, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一段' }, { type: 'hardBreak' }, { type: 'text', text: '第二行' }] }] }, status: null, issuetype: null, assignee: null, attachment: [{ id: '1', filename: '附件.txt', size: 1, mimeType: 'text/plain', content: 'https://other.example.invalid/credential-target' }] } });
  const result = await new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account: 'fixture', password }, transport).getIssue('NEWDEVGROUP-1');
  assert.equal(result.summary, '[已脱敏]');
  assert.equal(result.description, '第一段\n第二行');
  assert.equal(result.status, '');
  assert.equal(result.assignee, undefined);
  assert.equal(result.reporter, undefined);
  assert.equal(result.attachments[0].url, '');
  assert.ok(!JSON.stringify(result).includes(password));
});

test('报告人缺少显示名时使用账号，缺失或空值不造人名，报告人字段仍执行脱敏', async () => {
  for (const [reporter, expected] of [[{ name: 'fixture-reporter' }, 'fixture-reporter'], [null, undefined], [undefined, undefined], [{ displayName: password }, '[已脱敏]']] as const) {
    const value = issue();
    const transport: JiraTransport = async () => Response.json({ ...value, fields: { ...value.fields, reporter } });
    const result = await new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password }, transport).getIssue('NEWDEVGROUP-1');
    assert.equal(result.reporter, expected);
  }
});

test('15秒请求超时返回固定中文，不转发传输层的凭据异常正文', { timeout: 20000 }, async () => {
  const transport: JiraTransport = async (_url, init) => new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new Error(password)), { once: true }); });
  const started = Date.now();
  await assert.rejects(new JiraConnector({ baseUrl: 'https://jira.example.invalid', account: 'fixture', password }, transport).getIssue('NEWDEVGROUP-1'), /超过 15 秒/);
  assert.ok(Date.now() - started >= 14000);
});
