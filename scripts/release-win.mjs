import { spawnSync } from 'node:child_process';
import path from 'node:path';

const publisher = process.env.JINGGONG_UPDATE_PUBLISHER?.trim();
const certificate = process.env.CSC_LINK || process.env.WIN_CSC_LINK;
const password = process.env.CSC_KEY_PASSWORD || process.env.WIN_CSC_KEY_PASSWORD;
if (!publisher || !certificate || !password) {
  console.error('在线更新发布已停止：请配置 Windows 签名证书、证书密码及其准确 Authenticode 发布者名称。');
  process.exit(1);
}

const cli = path.resolve('node_modules/electron-builder/cli.js');
const result = spawnSync(process.execPath, [cli, '--win', 'nsis', '--x64', '--publish', 'always', '--config.win.signExecutable=true', '--config.win.forceCodeSigning=true', `--config.win.publisherName=${publisher}`], { stdio: 'inherit', shell: false, env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
