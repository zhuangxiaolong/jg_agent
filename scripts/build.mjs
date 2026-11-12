import { build } from 'esbuild';
import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
await mkdir('dist/renderer', { recursive: true });
// 清理已移除的独立浏览器窗口产物，避免增量构建继续打入旧工具栏。
await Promise.all(['dist/browser-preload.cjs', 'dist/renderer/browser.js', 'dist/renderer/browser.html', 'dist/renderer/browser.css'].map(file => rm(file, { force: true })));
await build({ entryPoints: ['apps/desktop/src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/main.cjs', external: ['electron', 'sql.js'], sourcemap: true });
await build({ entryPoints: ['apps/desktop/src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/preload.cjs', external: ['electron'] });
await build({ entryPoints: ['apps/desktop/src/renderer/main.tsx'], bundle: true, platform: 'browser', outfile: 'dist/renderer/renderer.js', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
await copyFile('apps/desktop/src/renderer/index.html', 'dist/renderer/index.html');
await cp('apps/desktop/resources/branding', 'dist/renderer/assets', { recursive: true });
