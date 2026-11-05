import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';

const MAX_LOG_BYTES = 64 * 1024;
const ERROR_CODES = new Set(['EPIPE', 'EIO', 'EBADF', 'EPERM', 'EACCES', 'ECONNRESET', 'ENOSPC', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
export interface DesktopLoggingOptions { logDirectory?: string }
export interface DesktopLoggingController { readonly logFile: string | null }
let installed: DesktopLoggingController | undefined;

/** 仅保存输出通道的白名单元数据；不保存 console 正文、用户资料、堆栈或凭据。 */
function diagnosticFile(directory: string): { logFile: string | null; record(event: string, stream?: string, code?: string): void } {
  try {
    const absolute = path.resolve(directory);
    const missing: string[] = [];
    let cursor = absolute;
    while (true) {
      let info;
      try { info = lstatSync(cursor); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (info) {
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe log directory');
      } else missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    for (const entry of missing.reverse()) {
      try { mkdirSync(entry, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = lstatSync(entry);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe log directory');
    }
    const logFile = path.join(realpathSync(absolute), 'desktop-stdio.jsonl');
    let existing;
    try { existing = lstatSync(logFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('unsafe log file');
    const descriptor = openSync(logFile, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || (existing && (existing.dev !== opened.dev || existing.ino !== opened.ino))) { closeSync(descriptor); throw new Error('log file changed'); }
    let bytes = opened.size;
    return {
      logFile,
      record(event, stream, code) {
        try {
          const line = `${JSON.stringify({ time: new Date().toISOString(), event, ...(stream ? { stream } : {}), ...(code ? { code } : {}) })}\n`;
          const size = Buffer.byteLength(line, 'utf8');
          if (bytes + size > MAX_LOG_BYTES) return;
          writeSync(descriptor, line);
          bytes += size;
        } catch { /* 日志不可用时退化为安全 sink，禁止递归调用 console。 */ }
      },
    };
  } catch { return { logFile: null, record() { /* 不将日志初始化失败再写回已断开的 stdio。 */ } }; }
}

/** Windows GUI 不依赖启动器输出管道；保护底层写入也覆盖 Electron 内部 console.error。 */
export function installDesktopLogging(options: DesktopLoggingOptions = {}): DesktopLoggingController {
  if (installed) return installed;
  const dataRoot = process.env.JINGGONG_TEST_DATA ?? path.join(process.env.LOCALAPPDATA ?? tmpdir(), 'JinggongAgent');
  const diagnostic = diagnosticFile(options.logDirectory ?? path.join(dataRoot, 'logs'));
  for (const [name, output] of [['stdout', process.stdout], ['stderr', process.stderr]] as const) {
    let recorded = false;
    const recordOutput = () => {
      if (recorded) return;
      recorded = true;
      diagnostic.record('stdio-output-suppressed', name);
    };
    const writable = output as Writable;
    writable.on('error', (error: NodeJS.ErrnoException) => {
      diagnostic.record('stdio-error', name, ERROR_CODES.has(error.code ?? '') ? error.code : 'OTHER_STDIO_ERROR');
    });
    writable._write = (_chunk, _encoding, callback) => { recordOutput(); queueMicrotask(() => callback()); };
    writable._writev = (_chunks, callback) => { recordOutput(); queueMicrotask(() => callback()); };
  }
  diagnostic.record('stdio-sink-installed');
  installed = { logFile: diagnostic.logFile };
  return installed;
}

// Node 测试和构建工具导入时不接管其输出；Electron 主进程在其他应用模块前安装保护。
if (process.versions.electron && (process as NodeJS.Process & { type?: string }).type === 'browser') installDesktopLogging();
