import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', '--cli', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', (code, signal) => process.exit(typeof code === 'number' ? code : signal ? 1 : 0));
