import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function brokenPipeChild(source: string): Promise<{ code: number | null; messages: unknown[] }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: path.resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: unknown[] = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('断管子进程未按期退出')); }, 10000);
    child.on('error', reject);
    child.on('message', (message) => {
      messages.push(message);
      if (message === 'ready') {
        child.stdout!.destroy();
        child.stderr!.destroy();
        child.send('write');
      }
    });
    child.once('exit', (code) => { clearTimeout(timeout); resolve({ code, messages }); });
  });
}

test('真实断开的父进程 stderr 管道可复现 EPIPE 导致未保护子进程退出', async () => {
  const result = await brokenPipeChild(`
    const { Console } = await import('node:console');
    const console = new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: false });
    process.on('uncaughtExceptionMonitor', (error) => { process.send({ errorCode: error.code }); });
    process.on('message', () => {
      console.error('字典导入业务错误：文件中没有可导入的数据');
      setTimeout(() => { process.send('survived'); process.exit(0); }, 150);
    });
    process.send('ready');
  `);
  assert.notEqual(result.code, 0);
  assert.ok(result.messages.some((item) => !!item && typeof item === 'object' && 'errorCode' in item && item.errorCode === 'EPIPE'));
  assert.ok(!result.messages.includes('survived'));
});

test('安全 stdio 保护使真实断管后的 console 与写入回调正常，日志不保留凭据正文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-logging-'));
  const moduleUrl = pathToFileURL(path.resolve('apps/desktop/src/main/logging.ts')).href;
  const value = 'logging-test-sentinel-not-a-real-model-key';
  const result = await brokenPipeChild(`
    const { installDesktopLogging } = await import(${JSON.stringify(moduleUrl)});
    const controller = installDesktopLogging({ logDirectory: ${JSON.stringify(root)} });
    const { Console } = await import('node:console');
    const strictConsole = new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: false });
    process.on('message', () => {
      strictConsole.error('Electron 内部错误日志', ${JSON.stringify(value)});
      console.error('业务错误', new Error(${JSON.stringify(value)}));
      console.log('模型配置', ${JSON.stringify(value)});
      process.stderr.write(${JSON.stringify(value)}, (error) => {
        if (error) { process.send('callback-failed'); process.exit(2); return; }
        process.stdout.write(${JSON.stringify(value)}, () => {
          process.send({ survived: true, logFile: controller.logFile });
          setTimeout(() => process.exit(0), 50);
        });
      });
    });
    process.send('ready');
  `);
  assert.equal(result.code, 0);
  const state = result.messages.find((item): item is { survived: boolean; logFile: string } => !!item && typeof item === 'object' && 'survived' in item);
  assert.equal(state?.survived, true);
  const log = await readFile(state!.logFile, 'utf8');
  assert.ok(!log.includes(value));
  assert.ok(!log.includes('业务错误'));
  const entries = log.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(entries.some((item) => item.event === 'stdio-sink-installed'));
  assert.ok(entries.some((item) => item.stream === 'stderr'));
});

test('stdio 保护处理输出通道错误，其他未捕获异常仍正常失败', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-logging-error-'));
  const moduleUrl = pathToFileURL(path.resolve('apps/desktop/src/main/logging.ts')).href;
  const result = await brokenPipeChild(`
    const { installDesktopLogging } = await import(${JSON.stringify(moduleUrl)});
    const controller = installDesktopLogging({ logDirectory: ${JSON.stringify(root)} });
    process.on('message', () => {
      const error = Object.assign(new Error('不应记录的异常正文'), { code: 'EPIPE' });
      process.stderr.emit('error', error);
      process.stdout.emit('error', Object.assign(new Error('不应记录的未知写错误'), { code: 'EIO' }));
      process.send({ logFile: controller.logFile, uncaughtListeners: process.listenerCount('uncaughtException') });
      throw new Error('此程序错误必须保持未捕获');
    });
    process.send('ready');
  `);
  assert.notEqual(result.code, 0);
  const state = result.messages.find((item): item is { logFile: string; uncaughtListeners: number } => !!item && typeof item === 'object' && 'logFile' in item);
  assert.equal(state?.uncaughtListeners, 0);
  const log = await readFile(state!.logFile, 'utf8');
  assert.ok(log.includes('EPIPE'));
  assert.ok(log.includes('EIO'));
  assert.ok(!log.includes('不应记录'));
});
