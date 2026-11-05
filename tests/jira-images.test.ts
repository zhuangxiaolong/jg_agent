import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JiraAttachment, JiraIssue } from '../packages/domain/src';
import { JiraConnector, MAX_JIRA_IMAGE_BYTES, inspectJiraImage, validateJiraImage } from '../packages/jira-connector/src';
import { JiraImageStore } from '../apps/desktop/src/main/jira-images';

// 合成回归使用真实有效的 1×1 PNG；不使用用户服务、凭据或生产附件。
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64');
// Windows System.Drawing 在内存生成的合成 1×1 JPEG，与真实用户图片无关。
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==', 'base64');
const password = 'synthetic-jira-image-password';
const sha256 = createHash('sha256').update(png).digest('hex');
function attachment(url = 'https://jira.example.invalid/jira/secure/attachment/1/pixel.png'): JiraAttachment { return { id: '1', name: '验收截图.png', mimeType: 'image/png', size: png.length, url }; }
function issue(attachments = [attachment()]): JiraIssue { return { id: '1', key: 'CD-435', summary: '合成图片验收', description: '请核对截图', status: '待开发', issueType: '任务', url: 'https://jira.example.invalid/jira/browse/CD-435', attachments, fetchedAt: '2026-11-04T00:00:00Z' }; }
function responseImage(response: ServerResponse, bytes = png, mime = 'image/png') { response.writeHead(200, { 'Content-Type': mime }); response.end(bytes); }
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('合成服务启动失败');
  return { base: `http://127.0.0.1:${address.port}/jira`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('真实HTTP图片GET携带独立认证，MIME/签名通过后按SHA原子缓存，重启后可离线读取', async () => {
  let downloads = 0;
  const server = await fixture((request, response) => {
    downloads++;
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/jira/secure/attachment/1/pixel.png');
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(`fixture:${password}`).toString('base64')}`);
    responseImage(response);
  });
  try {
    const connector = new JiraConnector({ baseUrl: server.base, account: 'fixture', password });
    const original = issue([attachment(`${server.base}/secure/attachment/1/pixel.png`)]);
    const root = await mkdtemp(path.join(tmpdir(), 'jinggong-image-cache-'));
    const store = new JiraImageStore(root);
    const cached = await store.cacheIssue(connector, original);
    assert.equal(original.attachments[0].localImage, undefined);
    assert.deepEqual(cached.attachments[0].localImage, { sha256, size: png.length, mimeType: 'image/png' });
    const [filename] = await store.runtimePaths(cached);
    assert.equal(filename, path.join(await realpath(root), 'attachments', 'jira', `${sha256}.png`));
    assert.deepEqual(await readFile(filename), png);
    assert.equal((await lstat(filename)).nlink, 1);
    assert.deepEqual(await readdir(path.dirname(filename)), [`${sha256}.png`]);
    const offline = { downloadImage: async () => { throw new Error('离线测试不可发起网络'); } };
    const restarted = new JiraImageStore(root);
    assert.deepEqual(await restarted.cacheIssue(offline, cached), cached);
    assert.equal(await restarted.dataUrl(cached.attachments[0]), `data:image/png;base64,${png.toString('base64')}`);
    assert.deepEqual(await restarted.runtimePaths(cached), [filename]);
    assert.equal(downloads, 1);
    const changed = Buffer.from(png); changed[changed.length - 1] ^= 1; await writeFile(filename, changed);
    await assert.rejects(restarted.dataUrl(cached.attachments[0]), /SHA256/);
  } finally { await server.close(); }
});

test('图片认证边界拒绝外源/外context/协议和真实HTTP重定向，不向目标转发认证', async () => {
  let forwarded = 0, sent = 0;
  const target = await fixture((_request, response) => { forwarded++; responseImage(response); });
  const source = await fixture((_request, response) => { sent++; response.writeHead(302, { Location: `${target.base}/secure/attachment/1/pixel.png` }); response.end(); });
  try {
    const connector = new JiraConnector({ baseUrl: source.base, account: 'fixture', password });
    for (const url of [`${target.base}/secure/attachment/1/pixel.png`, source.base.replace('/jira', '/outside/pixel.png'), `${source.base}evil/pixel.png`, source.base.replace('http://', 'http://user:pass@') + '/pixel.png', 'file:///C:/outside.png', `${source.base}/a%2fb.png`]) await assert.rejects(connector.downloadImage(attachment(url)), /同源|context|地址/);
    assert.equal(sent, 0); assert.equal(forwarded, 0);
    await assert.rejects(connector.downloadImage(attachment(`${source.base}/secure/attachment/1/pixel.png`)), /重定向/);
    assert.equal(sent, 1); assert.equal(forwarded, 0);
  } finally { await source.close(); await target.close(); }
});

test('图片拒绝HTML/SVG、签名伪装、超限响应与认证错误，不泄漏正文密码', async () => {
  for (const [bytes, mime] of [[Buffer.from('<html>login</html>'), 'text/html'], [Buffer.from('<svg/>'), 'image/svg+xml'], [Buffer.from('<html>not png</html>'), 'image/png']] as const) {
    const connector = new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account: 'fixture', password }, async () => new Response(bytes, { headers: { 'Content-Type': mime } }));
    await assert.rejects(connector.downloadImage(attachment()), /MIME|签名|PNG/);
  }
  for (const status of [401, 403, 404, 500]) {
    const connector = new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account: 'fixture', password }, async () => new Response(password, { status }));
    await assert.rejects(connector.downloadImage(attachment()), (error: Error) => { assert.ok(!error.message.includes(password)); assert.match(error.message, /Jira|账号/); return true; });
  }
  for (const declared of [false, true]) {
    const connector = new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account: 'fixture', password }, async () => new Response(Buffer.alloc(MAX_JIRA_IMAGE_BYTES + 1), { headers: { 'Content-Type': 'image/png', ...(declared ? { 'Content-Length': String(MAX_JIRA_IMAGE_BYTES + 1) } : {}) } }));
    await assert.rejects(connector.downloadImage(attachment()), /8 MiB/);
  }
  assert.equal(validateJiraImage(png, 'image/png'), 'image/png');
  assert.equal(validateJiraImage(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), 'image/gif'), 'image/gif');
  await assert.rejects(new JiraConnector({ baseUrl: 'https://jira.example.invalid/jira', account: 'fixture', password }).downloadImage({ ...attachment(), size: MAX_JIRA_IMAGE_BYTES + 1 }), /8 MiB/);
});

test('真实JPEG被Jira错标PNG时按文件签名识别，HTTP下载与缓存类型一致并可离线恢复', async () => {
  const jpegWithFooter = Buffer.concat([jpeg, Buffer.alloc(24, 8)]);
  const server = await fixture((_request, response) => responseImage(response, jpegWithFooter, 'image/png'));
  try {
    const connector = new JiraConnector({ baseUrl: server.base, account: 'fixture', password });
    const original = issue([{ ...attachment(`${server.base}/secure/attachment/1/wrong.png`), size: jpeg.length }]);
    assert.equal(validateJiraImage(jpeg, 'image/png'), 'image/jpeg');
    assert.deepEqual(inspectJiraImage(jpegWithFooter, 'image/png'), { mimeType: 'image/jpeg', imageBytes: jpeg.length });
    assert.throws(() => validateJiraImage(jpeg.subarray(0, -2), 'image/jpeg'), /签名|结构/);
    assert.throws(() => validateJiraImage(Buffer.concat([jpeg, Buffer.alloc(64 * 1024 + 1)]), 'image/jpeg'), /签名|结构/);
    assert.equal(validateJiraImage(png, 'image/jpeg'), 'image/png');
    const downloaded = await connector.downloadImage(original.attachments[0]);
    assert.equal(downloaded.mimeType, 'image/jpeg');
    assert.deepEqual(downloaded.bytes, jpeg);
    const store = new JiraImageStore(await mkdtemp(path.join(tmpdir(), 'jinggong-mislabeled-jpeg-')));
    const cached = await store.cacheIssue(connector, original);
    assert.equal(cached.attachments[0].mimeType, 'image/png');
    assert.equal(cached.attachments[0].localImage?.mimeType, 'image/jpeg');
    assert.match((await store.runtimePaths(cached))[0], /\.jpg$/);
    assert.equal(await store.dataUrl(cached.attachments[0]), `data:image/jpeg;base64,${jpeg.toString('base64')}`);
  } finally { await server.close(); }
});

test('并发图片加载共用整次任务下载与SHA写入，失败明确中止且不污染原始快照', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-image-concurrency-'));
  const store = new JiraImageStore(root); let count = 0;
  const connector = { downloadImage: async () => { count++; await new Promise(resolve => setImmediate(resolve)); return { bytes: png, mimeType: 'image/png' as const }; } };
  const original = issue([attachment(), { ...attachment(), id: '2', name: '另一张.png' }]);
  const cached = await Promise.all(Array.from({ length: 10 }, () => store.cacheIssue(connector, original)));
  assert.equal(count, 2);
  assert.deepEqual(await readdir(path.join(root, 'attachments/jira')), [`${sha256}.png`]);
  assert.equal((await store.runtimePaths(cached[0])).length, 2);
  const broken = issue([{ ...attachment(), id: '3', name: '失败图片.png' }]);
  await assert.rejects(store.cacheIssue({ downloadImage: async () => { throw new Error('合成HTTP错误'); } }, broken), /未完整缓存.*尚未创建会话.*合成HTTP错误/);
  assert.equal(broken.attachments[0].localImage, undefined);
  await assert.rejects(store.runtimePaths(broken), /缓存元数据无效/);
  assert.equal((await store.cacheIssue(connector, broken)).attachments[0].localImage?.sha256, sha256);
});

test('缓存拒绝根目录联接、文件硬链接、伪造哈希与目录替换，不读取外部文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-image-path-'));
  const outside = path.join(root, 'outside'); await mkdir(outside);
  const junction = path.join(root, 'linked'); await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const connector = { downloadImage: async () => ({ bytes: png, mimeType: 'image/png' as const }) };
  await assert.rejects(new JiraImageStore(junction).cacheIssue(connector, issue()), /联接|符号链接/);
  assert.deepEqual(await readdir(outside), []);
  const store = new JiraImageStore(path.join(root, 'safe'));
  const cached = await store.cacheIssue(connector, issue());
  const [filename] = await store.runtimePaths(cached);
  const extra = path.join(outside, 'hardlink.png'); await link(filename, extra);
  await assert.rejects(store.dataUrl(cached.attachments[0]), /链接|大小/);
  await unlink(extra);
  for (const sha of ['../outside', 'A'.repeat(64), 'a'.repeat(63)]) await assert.rejects(store.dataUrl({ ...cached.attachments[0], localImage: { ...cached.attachments[0].localImage!, sha256: sha } }), /元数据/);
  await rename(path.dirname(filename), path.dirname(filename) + '-old'); await mkdir(path.dirname(filename));
  await writeFile(filename, png);
  await assert.rejects(store.dataUrl(cached.attachments[0]), /目录身份已变化/);
});

test('相同快照并发下载按服务与认证scope隔离，同scope新Connector可去重', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-image-scope-'));
  const store = new JiraImageStore(root);
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  let first = 0, second = 0, same = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const base = 'https://jira.example.invalid/jira';
  const original = issue();
  const connectorA = new JiraConnector({ baseUrl: base, account: 'fixture-A', password }, async () => { first++; await held; return new Response(png, { headers: { 'Content-Type': 'image/png' } }); });
  const connectorSame = new JiraConnector({ baseUrl: base, account: 'fixture-A', password }, async () => { same++; return new Response(png, { headers: { 'Content-Type': 'image/png' } }); });
  const connectorB = new JiraConnector({ baseUrl: base, account: 'fixture-B', password }, async () => { second++; return new Response(gif, { headers: { 'Content-Type': 'image/gif' } }); });
  const one = store.cacheIssue(connectorA, original);
  const also = store.cacheIssue(connectorSame, original);
  const two = await store.cacheIssue(connectorB, original);
  release();
  const result = await one;
  assert.equal((await also).attachments[0].localImage?.sha256, result.attachments[0].localImage?.sha256);
  assert.notEqual(two.attachments[0].localImage?.sha256, result.attachments[0].localImage?.sha256);
  assert.equal(first, 1); assert.equal(second, 1); assert.equal(same, 0);
});

test('任务图片20张与会话总32MiB均硬限制，非图片附件不伪造成图片', async () => {
  const store = new JiraImageStore(await mkdtemp(path.join(tmpdir(), 'jinggong-image-limits-')));
  let calls = 0;
  const connector = { downloadImage: async () => { calls++; return { bytes: png, mimeType: 'image/png' as const }; } };
  await assert.rejects(store.cacheIssue(connector, issue(Array.from({ length: 21 }, (_, index) => ({ ...attachment(), id: String(index) })))), /20 张/);
  assert.equal(calls, 0);
  const nonImage = { ...attachment(), name: '需求说明.md', mimeType: 'text/markdown' };
  assert.deepEqual(await store.runtimePaths(await store.cacheIssue(connector, issue([nonImage]))), []);
  assert.equal(calls, 0);
  // 保留原有效 PNG 的 IHDR/IDAT/IEND，仅追加有界合成附属块，用于真实文件容量回归。
  const payload = Buffer.alloc(7 * 1024 * 1024);
  const chunk = Buffer.alloc(payload.length + 12); chunk.writeUInt32BE(payload.length); chunk.write('npAD', 4); payload.copy(chunk, 8);
  const large = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  await assert.rejects(store.cacheIssue({ downloadImage: async () => ({ bytes: large, mimeType: 'image/png' as const }) }, issue(Array.from({ length: 5 }, (_, index) => ({ ...attachment(), id: String(index) })))), /32 MiB/);
});
