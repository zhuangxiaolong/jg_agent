import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { detectProductSystem } from '../packages/system-detection/src';

test('根据解决方案和项目框架自动识别 MES5、MES6、WMS', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-system-detection-'));
  try {
    const mes5 = path.join(root, 'mes5'); await mkdir(mes5);
    await writeFile(path.join(mes5, 'JZ.IMS.sln'), '');
    await writeFile(path.join(mes5, 'JZ.IMS.WebApi.csproj'), '<TargetFramework>netcoreapp3.1</TargetFramework>');
    const mes6 = path.join(root, 'mes6'); await mkdir(mes6);
    await writeFile(path.join(mes6, 'IMES.sln'), '');
    await writeFile(path.join(mes6, 'IMES.Web.Entry.csproj'), '<TargetFramework>net10.0</TargetFramework>');
    const wms = path.join(root, 'wms'); await mkdir(wms);
    await writeFile(path.join(wms, 'IWMS.sln'), '');
    assert.equal((await detectProductSystem(mes5)).system, 'MES5');
    assert.equal((await detectProductSystem(mes6)).system, 'MES6');
    assert.equal((await detectProductSystem(wms)).system, 'WMS');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MES6 历史 IWMS.Common 命名空间不会盖过 MES6 指纹，独立 WMS.sln 仍识别为 WMS', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-system-legacy-wms-'));
  try {
    const mes6 = path.join(root, 'imes-with-legacy-common'); await mkdir(mes6);
    await writeFile(path.join(mes6, 'IMES.sln'), '');
    for (let index = 0; index < 8; index++) {
      await writeFile(path.join(mes6, `IMES.Module${index}.csproj`), '<TargetFramework>net10.0</TargetFramework><ProjectReference Include="IWMS.Common" />');
    }
    await writeFile(path.join(mes6, 'Startup.cs'), 'namespace IWMS.Common;');
    assert.equal((await detectProductSystem(mes6)).system, 'MES6');

    const wms = path.join(root, 'wms-without-project-hints'); await mkdir(wms);
    await writeFile(path.join(wms, 'WMS.sln'), '');
    assert.equal((await detectProductSystem(wms)).system, 'WMS');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('无明确指纹时保持通用，避免错误加载字典', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-system-generic-'));
  try { await writeFile(path.join(root, 'README.md'), '# internal tools'); assert.equal((await detectProductSystem(root)).system, '通用'); }
  finally { await rm(root, { recursive: true, force: true }); }
});
