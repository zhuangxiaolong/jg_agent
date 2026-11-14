import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { z } from 'zod';
import { CredentialStore } from './credentials';
import { profileIdSchema, redact } from './security';
import { normalizeGrokBaseUrl, safeGrokCompatibility, safeGrokRuntime, type GrokCompatibilityResult, type GrokProviderProfile, type GrokRuntimeSettings, type GrokSettingsSnapshot } from '../../../../packages/domain/src/grok';
import type { ProviderProfile } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';

const runtimeSchema = z.object({ enabled: z.boolean(), executablePath: z.string(), proxyUrl: z.string().optional() }).strict();
const modelsSchema = z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._:/-]{1,160}$/), apiBackend: z.enum(['chat_completions', 'responses', 'messages']) })).max(100);

/** 自动发现引擎；历史启用开关不再作为会话使用的前置条件。 */
export function discoverGrokRuntime(saved: GrokRuntimeSettings, installed: string, available: (filename: string) => boolean = existsSync): GrokRuntimeSettings {
  const executablePath = [installed, saved.executablePath].find(filename => filename && available(filename));
  return { ...saved, enabled: Boolean(executablePath), executablePath: executablePath || saved.executablePath || installed };
}

/** Grok 复用模型中转站，只单独保存 Runtime 与模型协议，不复制凭据。 */
export class GrokSettingsService {
  constructor(private readonly store: LocalStore, private readonly dataRoot: string, private readonly assertIdle: () => void) {}

  credential(id: string): CredentialStore {
    profileIdSchema.parse(id);
    return new CredentialStore(id === 'legacy-default' ? path.join(this.dataRoot, 'config/model-key.dpapi') : path.join(this.dataRoot, 'config/secrets', `${id}.dpapi`));
  }

  /** 凭据按模型中转站原地址校验；只有发送请求的地址才补 /v1。 */
  apiKey(id: string): string | undefined {
    const provider = this.store.listProviders().find(item => item.id === profileIdSchema.parse(id));
    if (!provider) throw new Error('模型中转站不存在，请在【模型中转站】中配置');
    return this.credential(id).read(provider.baseUrl);
  }

  private identity(provider: ProviderProfile, key?: string): string {
    return createHash('sha256').update(JSON.stringify([provider.baseUrl, key ?? ''])).digest('hex');
  }

  configurationIdentity(providerId: string, modelId: string): string {
    const provider = this.store.listProviders().find(item => item.id === profileIdSchema.parse(providerId));
    const model = this.profiles().find(item => item.id === providerId)?.models.find(item => item.id === modelId);
    if (!provider || !model) throw new Error('模型中转站或模型不存在');
    return createHash('sha256').update(JSON.stringify([this.identity(provider, this.apiKey(providerId)), modelId, model.apiBackend])).digest('hex');
  }

  runtime(): GrokRuntimeSettings {
    const runtime = this.store.getGrokRuntime();
    const installed = path.join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
    return discoverGrokRuntime(runtime, installed);
  }

  profiles(): GrokProviderProfile[] {
    const preferences = this.store.listGrokProviders();
    return this.store.listProviders().map(provider => {
      let key: string | undefined;
      try { key = this.apiKey(provider.id); } catch { /* 地址或凭据已失效时由界面提示重新配置。 */ }
      const saved = preferences.find(item => item.id === provider.id);
      const identityMatches = !!saved && saved.sharedIdentity === this.identity(provider, key);
      return {
        id: provider.id, name: provider.name, baseUrl: normalizeGrokBaseUrl(provider.baseUrl), enabled: true, hasKey: !!key,
        models: provider.models.map(id => {
          // 协议可复用；兼容结论必须重新匹配当前服务地址和凭据。
          const prior = saved?.sharedIdentity ? saved.models.find(model => model.id === id) : undefined;
          return { id, name: provider.modelCatalog?.find(model => model.id === id)?.name || id, apiBackend: prior?.apiBackend ?? 'chat_completions', enabled: true, ...(identityMatches && prior?.compatibility ? { compatibility: prior.compatibility } : {}) };
        }),
      };
    });
  }
  snapshot(): GrokSettingsSnapshot { return { runtime: this.runtime(), providers: this.profiles() }; }

  redact(text: string): string {
    let value = redact(text);
    for (const provider of this.store.listProviders()) {
      try { const key = this.credential(provider.id).read(); if (key) value = redact(value, key); } catch { /* 损坏凭据不阻断错误收尾。 */ }
    }
    return value;
  }

  assertCleanText(value: string): void {
    for (const provider of this.store.listProviders()) {
      let key: string | undefined;
      try { key = this.credential(provider.id).read(); } catch { continue; }
      if (key && value.includes(key)) throw new Error('Grok 配置元数据不能包含已配置的 API Key');
    }
  }

  saveRuntime(value: unknown): GrokRuntimeSettings {
    this.assertIdle();
    const input = safeGrokRuntime(runtimeSchema.parse(value));
    this.assertCleanText(JSON.stringify(input));
    this.store.saveGrokRuntime(input);
    return this.runtime();
  }

  saveModels(providerId: string, value: unknown): GrokProviderProfile {
    this.assertIdle();
    const id = profileIdSchema.parse(providerId);
    const input = modelsSchema.parse(value);
    const profile = this.profiles().find(item => item.id === id);
    if (!profile) throw new Error('模型中转站不存在，请在【模型中转站】中配置');
    if (new Set(input.map(model => model.id)).size !== input.length) throw new Error('同一模型协议不能重复');
    if (input.some(model => !profile.models.some(current => current.id === model.id))) throw new Error('所选模型无效，不属于模型中转站');
    const updated: GrokProviderProfile = { ...profile, models: profile.models.map(model => {
      const patch = input.find(item => item.id === model.id);
      return patch && patch.apiBackend !== model.apiBackend ? { ...model, apiBackend: patch.apiBackend, compatibility: undefined } : model;
    }) };
    this.assertCleanText(JSON.stringify(updated));
    const shared = this.store.listProviders().find(item => item.id === id)!;
    this.store.saveGrokProvider(updated, this.identity(shared, this.apiKey(id)));
    return this.profiles().find(item => item.id === id)!;
  }

  /** 只允许主进程真实连接测试写入；配置变更后拒绝记录旧请求的结论。 */
  saveCompatibility(providerId: string, modelId: string, value: GrokCompatibilityResult, expectedIdentity?: string): GrokCompatibilityResult {
    if (expectedIdentity && this.configurationIdentity(providerId, modelId) !== expectedIdentity) throw new Error('模型中转站或协议已变化，请重新测试');
    const result = safeGrokCompatibility({ ...value, detail: this.redact(value.detail).replace(/\s+/g, ' ').slice(0, 2000) });
    this.assertCleanText(JSON.stringify(result));
    const profile = this.profiles().find(item => item.id === profileIdSchema.parse(providerId));
    const shared = this.store.listProviders().find(item => item.id === providerId);
    if (!profile || !shared || !profile.models.some(model => model.id === modelId)) throw new Error('模型中转站或模型不存在');
    this.store.saveGrokProvider({ ...profile, models: profile.models.map(model => model.id === modelId ? { ...model, compatibility: result } : model) }, this.identity(shared, this.apiKey(providerId)));
    return result;
  }
}
