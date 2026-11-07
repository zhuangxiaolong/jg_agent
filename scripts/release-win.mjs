import { spawnSync } from 'node:child_process';
import path from 'node:path';

const publisher = process.env.JINGGONG_UPDATE_PUBLISHER?.trim();
const certificate = process.env.CSC_LINK || process.env.WIN_CSC_LINK;
const password = process.env.CSC_KEY_PASSWORD || process.env.WIN_CSC_KEY_PASSWORD;
const cli = path.resolve('node_modules/electron-builder/cli.js');
const args = [cli, '--win', 'nsis', '--x64', '--publish', 'always'];
if (publisher && certificate && password) {
  args.push('--config.win.signExecutable=true', '--config.forceCodeSigning=true', `--config.win.signtoolOptions.publisherName=${publisher}`);
  console.log('在线更新发布：使用 Windows Authenticode 签名。');
} else {
  console.warn('在线更新发布：未配置 Windows 签名证书，将使用 HTTPS + latest.yml SHA512 校验发布无签名安装包。');
}
const result = spawnSync(process.execPath, args, { stdio: 'inherit', shell: false, env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
