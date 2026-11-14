import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

test('Windows SendInput 辅助类可由 PowerShell 编译，验证时不发送桌面输入', { skip: process.platform !== 'win32' }, async () => {
  const source = await readFile(path.resolve('apps/desktop/src/main/computer.ts'), 'utf8');
  const helper = source.match(/const WINDOWS_INPUT_HELPER = String\.raw`([\s\S]*?)`;\r?\n/);
  assert.ok(helper, '必须找到主进程实际使用的 Windows 输入实现');
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${helper[1]}\n'@\n[JinggongDesktopInput].FullName`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await promisify(execFile)(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 });
  assert.match(result.stdout, /JinggongDesktopInput/);
});
