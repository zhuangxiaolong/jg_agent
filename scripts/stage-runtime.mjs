import path from 'node:path';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const source = path.resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc');
const target = path.resolve('apps/desktop/resources/runtime');
const pkg = JSON.parse(await readFile('node_modules/@openai/codex/package.json', 'utf8'));
if (pkg.version !== '0.156.1' || pkg.license !== 'Apache-2.0') throw new Error('运行时版本或许可证与锁定值不符');
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
await cp('node_modules/@openai/codex/README.md', path.join(target, 'README.md'));
// 来自 openai/codex 的固定 rust-v0.156.1 标签，禁止随最新分支漂移。
for (const [name, expected] of [
  ['LICENSE', 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc'],
  ['NOTICE', '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915'],
]) {
  const sourceLicense = path.join('installer', 'licenses', `codex-${name}`);
  const content = await readFile(sourceLicense);
  if (createHash('sha256').update(content).digest('hex') !== expected) throw new Error(`Codex ${name} 校验失败`);
  await writeFile(path.join(target, name), content);
}
const files = [];
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(absolute);
    else if (entry.name !== 'manifest.json') files.push({ path: path.relative(target, absolute).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
  }
}
await scan(target);
await writeFile(path.join(target, 'manifest.json'), JSON.stringify({ version: pkg.version, license: pkg.license, source: 'https://registry.npmjs.org/@openai/codex', files }, null, 2));
console.log(`已准备固定 Codex ${pkg.version}，${files.length} 个文件，包含 SHA256 清单`);
