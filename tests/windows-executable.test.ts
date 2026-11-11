import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWindowsX64Executable } from '../scripts/windows-executable.mjs';
import { windowsX64Fixture } from './windows-executable-fixture';

test('Windows x64 可执行文件预检接受完整节表与原始节数据', () => {
  assert.deepEqual(validateWindowsX64Executable(windowsX64Fixture()), { machine: 'x64', sectionCount: 1, byteLength: 1024 });
});

test('Windows x64 可执行文件预检拒绝被截断的原始节数据', () => {
  assert.throws(() => validateWindowsX64Executable(windowsX64Fixture().subarray(0, 600)), /节超出实际文件.*截断/);
});

test('Windows x64 可执行文件预检拒绝错误架构、缺失头和截断节表', () => {
  const wrongArchitecture = windowsX64Fixture();
  wrongArchitecture.writeUInt16LE(0xaa64, 0x84);
  assert.throws(() => validateWindowsX64Executable(wrongArchitecture), /不是 Windows x64/);
  assert.throws(() => validateWindowsX64Executable(Buffer.from('fixture')), /缺少 MZ/);
  assert.throws(() => validateWindowsX64Executable(windowsX64Fixture().subarray(0, 400)), /节表.*截断/);
});
