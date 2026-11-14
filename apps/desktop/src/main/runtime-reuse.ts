import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeOptions } from '../../../../packages/agent-runtime/src';

/** 回调逐轮重绑；组件、权限或上下文变化时必须冷恢复，不复用旧线程配置。 */
export async function codexRuntimeReuseKey(options: RuntimeOptions, cwd: string, readAccess: unknown): Promise<string> {
  const info = await lstat(options.executable);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Codex Runtime 入口必须是普通文件');
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return createHash('sha256').update(JSON.stringify([
    'codex', normalized(options.executable), info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs,
    normalized(options.home), normalized(cwd), options.baseUrl, options.model, options.apiKey,
    options.reasoningEffort, options.runtimeVersion, options.runtimeDisplayName, options.expectedUserAgentPrefix,
    options.shellToolEnabled, options.pluginsEnabled, options.rpcTimeoutMs, options.executionMode,
    options.developerInstructions, options.dictionaries, readAccess,
    !!options.beforeWrite, !!options.browser, !!options.authorizedDirectories, !!options.requestDirectoryAccess,
    !!options.toolGateway, !!options.modelRequestGateway,
  ])).digest('hex');
}
