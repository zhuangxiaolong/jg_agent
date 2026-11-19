import { createHmac, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { CODEX_RUNTIME_VERSION, RUNTIME_CAPABILITIES_VERSION, type RuntimeOptions } from '../../../../packages/agent-runtime/src';

const processFingerprintKey = randomBytes(32);
const RELEVANT_ENVIRONMENT = ['PATH', 'CODEX_HOME', 'CODEX_HOME_OVERRIDE', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SystemRoot', 'USERPROFILE', 'HOME'] as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function codexIdentity(options: RuntimeOptions, cwd: string, includeTurnContext: boolean): Promise<unknown> {
  const info = await lstat(options.executable);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Codex Runtime 入口必须是普通文件');
  const dictionaries = includeTurnContext ? (options.dictionaries ?? []).map(item => ({ id: item.id, name: item.name, kind: item.kind, system: item.system, enabled: item.enabled, digest: item.digest, content: item.content })) : undefined;
  const relevantEnv = Object.fromEntries(RELEVANT_ENVIRONMENT.map(name => [name, process.env[name] ?? null]));
  return stableValue({
    runtimeKind: 'codex', runtimeVersion: options.runtimeVersion ?? CODEX_RUNTIME_VERSION,
    binaryIdentity: { path: normalizedPath(options.executable), dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs },
    home: normalizedPath(options.home), cwd: normalizedPath(cwd), baseUrl: options.baseUrl, model: options.model, apiKey: options.apiKey ?? null,
    reasoningEffort: options.reasoningEffort ?? null, expectedUserAgentPrefix: options.expectedUserAgentPrefix ?? null,
    shellToolEnabled: options.shellToolEnabled ?? true, pluginsEnabled: options.pluginsEnabled ?? false, rpcTimeoutMs: options.rpcTimeoutMs ?? null,
    executionMode: options.executionMode ?? 'native', ...(includeTurnContext ? { executionRulesVersion: options.executionRulesVersion ?? null } : {}),
    ...(includeTurnContext ? { developerInstructions: options.developerInstructions ?? '', dictionaries, readAccess: undefined } : {}),
    toolset: includeTurnContext ? { capabilitiesVersion: RUNTIME_CAPABILITIES_VERSION, beforeWrite: !!options.beforeWrite, browser: !!options.browser, computer: !!options.computer, authorizedDirectories: !!options.authorizedDirectories, requestDirectoryAccess: !!options.requestDirectoryAccess, toolGateway: !!options.toolGateway, modelRequestGateway: !!options.modelRequestGateway } : undefined,
    relevantEnv,
  });
}

export async function codexRuntimeProcessKey(options: RuntimeOptions, cwd: string): Promise<string> {
  return createHmac('sha256', processFingerprintKey).update(JSON.stringify(await codexIdentity(options, cwd, false))).digest('hex');
}

/** 仅在当前进程内比较复用指纹；明文凭据和配置不会写入日志或持久化。 */
export async function codexRuntimeReuseKey(options: RuntimeOptions, cwd: string, readAccess: unknown): Promise<string> {
  const identity = await codexIdentity(options, cwd, true) as Record<string, unknown>;
  return createHmac('sha256', processFingerprintKey).update(JSON.stringify({ ...identity, readAccess: stableValue(readAccess) })).digest('hex');
}
