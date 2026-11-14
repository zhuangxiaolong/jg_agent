import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimePrewarmService } from '../apps/desktop/src/main/runtime-prewarm';
import type { RuntimeHealth, RuntimeKind } from '../packages/domain/src';

interface FixtureOptions {
  delays?: Partial<Record<RuntimeKind, number>>;
  errors?: RuntimeKind[];
  cpuMs?: number;
  once?: 'crash' | 'hang';
  holdCheck?: RuntimeKind;
  holdVerify?: boolean;
  holdGrokPath?: string;
  requestTimeoutMs?: number;
}
interface WorkerEvent { state: string; method?: string; kind?: RuntimeKind; active?: number; path?: string; threadId?: number }

// 合成协议使用真正的 Worker 线程，验证桌面调度和隔离行为，不替代真实组件或模型验收。
async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-prewarm-'));
  const eventsFile = path.join(root, 'events.jsonl');
  const workerFile = path.join(root, 'worker.cjs');
  const cpuGateFile = path.join(root, 'cpu-stop');
  const responseGateFile = path.join(root, 'response-continue');
  const configuration = { ...options, eventsFile, cpuGateFile, responseGateFile, marker: path.join(root, 'first-worker') };
  await writeFile(workerFile, `
const { parentPort, threadId } = require('node:worker_threads');
const fs = require('node:fs');
const configuration = ${JSON.stringify(configuration)};
let active = 0, sequence = 0;
const log = value => fs.appendFileSync(configuration.eventsFile, JSON.stringify({ ...value, threadId }) + '\\n');
parentPort.on('message', message => {
  if (message.method === 'close') {
    log({ state: 'close' });
    parentPort.postMessage({ id: message.id, result: null });
    return;
  }
  active += 1;
  const number = ++sequence;
  log({ state: 'begin', method: message.method, kind: message.kind, active, path: message.grokExecutablePath });
  if (configuration.once && !fs.existsSync(configuration.marker)) {
    fs.writeFileSync(configuration.marker, 'first');
    if (configuration.once === 'crash') process.exit(7);
    return;
  }
  if (configuration.cpuMs && message.method === 'check') {
    const until = performance.now() + 10000;
    while (!fs.existsSync(configuration.cpuGateFile) && performance.now() < until) {
      const interval = performance.now() + configuration.cpuMs;
      while (performance.now() < interval) {}
    }
  }
  const respond = () => {
    if (((message.method === 'check' && (message.kind === configuration.holdCheck ||
        (configuration.holdGrokPath && message.grokExecutablePath === configuration.holdGrokPath))) ||
        (message.method === 'verify' && configuration.holdVerify)) &&
        !fs.existsSync(configuration.responseGateFile)) {
      setTimeout(respond, 5);
      return;
    }
    active -= 1;
    log({ state: 'end', method: message.method, kind: message.kind, active, path: message.grokExecutablePath });
    if (message.method === 'check' && configuration.errors?.includes(message.kind)) {
      parentPort.postMessage({ id: message.id, error: '合成组件检查失败' });
      return;
    }
    const result = message.method === 'verify'
      ? { runtimeVersion: 'fixture-' + number }
      : { kind: message.kind, available: true, compatible: true, version: 'fixture',
          detail: JSON.stringify({ number, path: message.grokExecutablePath }) };
    parentPort.postMessage({ id: message.id, result });
  };
  setTimeout(respond, configuration.delays?.[message.kind] ?? 5);
});
`);
  const published: Array<RuntimeHealth & { kind: RuntimeKind }> = [];
  let busy = false;
  let grok = { executablePath: path.join(root, 'grok-first.exe') };
  const service = new RuntimePrewarmService({
    workerFile, resourcesRoot: root, dataRoot: root,
    grokRuntime: () => grok, isBusy: () => busy,
    publish: value => { published.push(value); },
    initialDelayMs: 40, intervalMs: 10, requestTimeoutMs: options.requestTimeoutMs ?? 5000,
  });
  return {
    service, published, root,
    setBusy(value: boolean) { busy = value; },
    setGrok(executablePath: string) { grok = { executablePath }; },
    async releaseCpu() { await writeFile(cpuGateFile, '结束合成计算'); },
    async releaseHeld() { await writeFile(responseGateFile, '返回合成检查结果'); },
    async events(): Promise<WorkerEvent[]> {
      try { return (await readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as WorkerEvent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    },
    async close() { await service.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 7000;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, '等待预热测试条件超时');
    await delay(5);
  }
}

test('启动先返回预热快照，用户忙时推迟，按选择顺序逐个检查且失败不阻断后续组件', async () => {
  const item = await fixture({ delays: { jinggong: 60 }, errors: ['codex'] });
  try {
    assert.equal(item.service.snapshot('jinggong').warmingUp, true);
    assert.deepEqual(await item.events(), [], '快照读取不应启动或等待 Worker');
    item.setBusy(true);
    item.service.start('jinggong');
    await delay(75);
    assert.deepEqual(await item.events(), [], '工作繁忙时不启动后台组件检查');
    item.setBusy(false);
    await until(() => item.published.length === 4);
    const events = await item.events();
    assert.deepEqual(events.filter(event => event.state === 'begin').map(event => event.kind), ['jinggong', 'codex', 'claude_agent_sdk', 'grok_build_acp']);
    assert.ok(events.filter(event => event.state === 'begin').every(event => event.active === 1), '后台预热只能单并发');
    assert.equal(item.service.snapshot('codex').available, false);
    assert.equal(item.service.snapshot('grok_build_acp').compatible, true);
  } finally { await item.close(); }
});

test('同一组件检查去重，完成后的快照复用检查结果，手动刷新重新检查', async () => {
  const item = await fixture({ delays: { codex: 80 } });
  try {
    const first = item.service.check('codex');
    assert.equal(item.service.check('codex'), first);
    const health = await first;
    assert.equal(item.service.snapshot('codex'), health);
    for (let index = 0; index < 10; index += 1) assert.equal(item.service.snapshot('codex').compatible, true);
    assert.equal((await item.events()).filter(event => event.state === 'begin').length, 1);
    await item.service.check('codex');
    assert.equal((await item.events()).filter(event => event.state === 'begin').length, 2);
    assert.equal(item.published.length, 2);
  } finally { await item.close(); }
});

test('真实任务校验越过无关后台检查，合并同时校验但后续轮次重新核验', async () => {
  const item = await fixture({ holdCheck: 'codex' });
  try {
    const checking = item.service.check('codex');
    await until(async () => (await item.events()).some(event => event.state === 'begin' && event.kind === 'codex'));
    const verification = item.service.verify('jinggong');
    assert.equal(item.service.verify('jinggong'), verification);
    const first = await verification;
    let events = await item.events();
    assert.ok(events.some(event => event.state === 'end' && event.method === 'verify'));
    assert.ok(!events.some(event => event.state === 'end' && event.kind === 'codex'), '前台校验不应等待无关组件检查结束');
    assert.notEqual(events.find(event => event.state === 'begin' && event.method === 'check')?.threadId,
      events.find(event => event.state === 'begin' && event.method === 'verify')?.threadId, '前台校验必须在独立 Worker 中执行');
    const second = await item.service.verify('jinggong');
    assert.notEqual(first.runtimeVersion, second.runtimeVersion, '不能用启动时的检查结果替代下一轮完整性验证');
    events = await item.events();
    assert.equal(events.filter(event => event.state === 'begin' && event.method === 'verify').length, 2);
    await item.releaseHeld();
    await checking;
  } finally { await item.close(); }
});

test('Worker 密集计算期间主线程定时器仍可响应', async () => {
  const item = await fixture({ cpuMs: 10, requestTimeoutMs: 12000 });
  try {
    const checking = item.service.check('claude_agent_sdk');
    await until(async () => (await item.events()).some(event => event.state === 'begin'));
    let settled = false;
    void checking.then(() => { settled = true; });
    await delay(30);
    assert.equal(settled, false, '主线程定时器必须先于 Worker 的密集计算完成');
    assert.equal((await item.events()).filter(event => event.state === 'end').length, 0);
    await item.releaseCpu();
    assert.equal((await checking).compatible, true);
  } finally { await item.releaseCpu(); await item.close(); }
});

test('关闭取消未启动和进行中的预热，不发布退出后的状态，也不再创建 Worker', async () => {
  const beforeStart = await fixture();
  try {
    beforeStart.service.start('codex');
    await beforeStart.service.close();
    beforeStart.service.start('jinggong');
    assert.equal((await beforeStart.service.check('codex')).compatible, false);
    await assert.rejects(beforeStart.service.verify('codex'), /已关闭/);
    await delay(60);
    assert.deepEqual(await beforeStart.events(), []);
  } finally { await beforeStart.close(); }
  const running = await fixture({ holdCheck: 'codex' });
  try {
    running.service.start('codex');
    await until(async () => (await running.events()).some(event => event.state === 'begin'));
    const pendingCheck = running.service.check('codex');
    const closing = running.service.close();
    assert.equal(running.service.close(), closing);
    await closing;
    assert.equal((await pendingCheck).compatible, false);
    await delay(30);
    assert.deepEqual(running.published, []);
    const events = await running.events();
    assert.equal(events.filter(event => event.state === 'begin').length, 1);
    assert.equal(events.filter(event => event.state === 'close').length, 1);
  } finally { await running.close(); }
});

test('Worker 崩溃或请求超时后可通过后续检查恢复', async () => {
  for (const once of ['crash', 'hang'] as const) {
    const item = await fixture({ once, requestTimeoutMs: 1500 });
    try {
      assert.equal((await item.service.check('codex')).available, false, `${once} 必须返回不可用状态`);
      assert.equal((await item.service.check('codex')).compatible, true, `${once} 后须重新创建 Worker`);
      assert.equal(item.published.length, 2);
      assert.equal(item.service.snapshot('codex').compatible, true);
    } finally { await item.close(); }
  }
});

test('Grok 组件路径变化使快照失效，旧检查结果不能覆盖新配置', async () => {
  const oldPath = path.join(tmpdir(), 'grok-old-fixture.exe');
  const newPath = path.join(tmpdir(), 'grok-new-fixture.exe');
  const item = await fixture({ holdGrokPath: oldPath });
  try {
    item.setGrok(oldPath);
    const previous = item.service.check('grok_build_acp');
    await until(async () => (await item.events()).some(event => event.state === 'begin'));
    item.setGrok(newPath);
    assert.equal(item.service.snapshot('grok_build_acp').warmingUp, true);
    const next = await item.service.check('grok_build_acp');
    assert.equal(JSON.parse(next.detail).path, newPath);
    await item.releaseHeld();
    await previous;
    assert.equal(item.published.length, 1);
    assert.equal(JSON.parse(item.service.snapshot('grok_build_acp').detail).path, newPath);
    item.setGrok(oldPath);
    assert.equal(item.service.snapshot('grok_build_acp').warmingUp, true);
  } finally { await item.close(); }
});

test('后台检查超时只回收自身 Worker，不得中断前台完整性校验', async () => {
  const item = await fixture({ once: 'hang', holdVerify: true, requestTimeoutMs: 2000 });
  try {
    const checking = item.service.check('codex');
    await until(async () => (await item.events()).some(event => event.state === 'begin' && event.method === 'check'));
    // 为两个请求的超时留出间隔；前台校验由显式 gate 控制完成顺序。
    await delay(500);
    const verifying = item.service.verify('jinggong');
    let verificationSettled = false;
    void verifying.then(() => { verificationSettled = true; }, () => { verificationSettled = true; });
    await until(async () => (await item.events()).some(event => event.state === 'begin' && event.method === 'verify'));
    assert.equal((await checking).available, false);
    assert.equal(verificationSettled, false, '后台请求超时不能结算或拒绝前台请求');
    await item.releaseHeld();
    assert.match((await verifying).runtimeVersion, /^fixture-/);
    assert.equal((await item.service.check('codex')).compatible, true, '后台检查可独立重启');
  } finally { await item.releaseHeld(); await item.close(); }
});
