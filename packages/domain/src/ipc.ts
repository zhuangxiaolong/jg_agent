import type { IpcErrorInfo } from './index';

export type PluginIpcFailure = IpcErrorInfo & { ok?: false; code: string; retryable: boolean };

function sanitizeValue(value: unknown, clean: (text: string) => string, depth: number): unknown {
  if (depth > 6) return '[已截断]';
  if (typeof value === 'string') return clean(value).slice(0, 2000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeValue(item, clean, depth + 1));
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 50)) {
    const safeKey = clean(key).slice(0, 100);
    if (safeKey) result[safeKey] = sanitizeValue(child, clean, depth + 1);
  }
  return result;
}

export function serializePluginIpcFailure(error: unknown, clean: (text: string) => string): PluginIpcFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { message?: unknown; code?: unknown; details?: unknown; retryable?: unknown; suggestedAction?: unknown };
  if (typeof candidate.code !== 'string' || !/^[A-Z0-9_]{1,100}$/.test(candidate.code)) return undefined;
  const failure: PluginIpcFailure = {
    ok: false,
    error: clean(typeof candidate.message === 'string' ? candidate.message : String(error)),
    code: candidate.code,
    retryable: candidate.retryable === true,
  };
  if (candidate.details !== undefined) failure.details = sanitizeValue(candidate.details, clean, 0);
  if (typeof candidate.suggestedAction === 'string') failure.suggestedAction = clean(candidate.suggestedAction).slice(0, 500);
  return failure;
}

export function createIpcError(failure: IpcErrorInfo): Error & Omit<IpcErrorInfo, 'error'> {
  return Object.assign(new Error(failure.error), {
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.details === undefined ? {} : { details: failure.details }),
    ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
    ...(failure.suggestedAction === undefined ? {} : { suggestedAction: failure.suggestedAction }),
  });
}
