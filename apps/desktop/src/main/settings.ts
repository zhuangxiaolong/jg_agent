import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CredentialStore } from './credentials';
import { claudeCredentialSchema, claudeRuntimeSchema, idSchema, jiraSchema, layoutSchema, memorySchema, modelProfileSchema, preferencesSchema, profileIdSchema, providerModelsSchema, redact, requirementInputSchema, wecomTargetSchema } from './security';
import { parseJiraLocation } from '../../../../packages/jira-connector/src';
import { parsePolicy } from '../../../../packages/policy/src';
import { DEFAULT_UPDATE_URL, updateFeed } from '../../../../packages/domain/src/updates';
import type { LocalStore } from '../../../../packages/storage/src';
import type { ClaudeRuntimeSettings, ManagedDocument, ProviderModel, ProviderProfile, ProviderSettings, RuntimeKind, SettingsSnapshot, UpdateStatus, WeComTargetSummary } from '../../../../packages/domain/src';
import type { WeComDeliveryRecord } from '../../../../packages/wecom-notification/src/desktop-service';
import type { WeComNotificationTarget } from '../../../../packages/wecom-notification/src';

/** 凭据只在主进程解密，数据库和 Renderer 永远只接收是否已配置。 */
export class SettingsService {
  constructor(private readonly store: LocalStore, private readonly dataRoot: string, private readonly assertIdle: () => void, private readonly appVersion = '开发版') {}

  credential(id: string): CredentialStore {
    profileIdSchema.parse(id);
    return new CredentialStore(id === 'legacy-default' ? path.join(this.dataRoot, 'config/model-key.dpapi') : path.join(this.dataRoot, 'config/secrets', `${id}.dpapi`));
  }
  jiraCredential(): CredentialStore { return new CredentialStore(path.join(this.dataRoot, 'config/secrets/jira.dpapi')); }
  claudeCredential(): CredentialStore { return new CredentialStore(path.join(this.dataRoot, 'config/secrets/claude-console.dpapi')); }
  private wecomCredential(id: string): CredentialStore { return new CredentialStore(path.join(this.dataRoot, 'config/secrets', `wecom-${id}.dpapi`)); }
  profiles(): ProviderProfile[] { return this.store.listProviders().map(profile => ({ ...profile, hasKey: this.credential(profile.id).hasKey })); }
  defaultProvider(): ProviderSettings {
    const profile = this.profiles()[0];
    return profile ? { baseUrl: profile.baseUrl, model: profile.models[0], hasKey: profile.hasKey } : { baseUrl: '', model: '', hasKey: false };
  }
  snapshot(update: UpdateStatus = { state: 'disabled', message: '更新检查尚未启动' }): SettingsSnapshot {
    return { preferences: this.store.getPreferences(), providers: this.profiles(), jira: { ...this.store.getJira(), hasPassword: this.jiraCredential().hasKey }, documents: this.store.listDocuments(), memories: this.store.listMemories(), update, appVersion: this.appVersion, updateUrl: this.store.getUpdateUrl() ?? DEFAULT_UPDATE_URL, runtimeKind: this.store.getRuntimeKind(), requirementsSync: this.store.getRequirementsSync(), claude: this.claudeRuntime(), notificationWorkspaces: this.store.listProjects().map(({ id, name }) => ({ id, name })), wecom: { targets: this.wecomTargets(), deliveries: this.store.listWeComDeliveries().map((record: WeComDeliveryRecord) => ({ id: record.id, kind: record.kind, status: record.status, targetId: record.targetId, targetName: record.targetName, eventType: record.eventType, content: record.content, attempts: record.attempts, createdAt: record.createdAt, updatedAt: record.updatedAt, errorCode: record.errorCode, errorSummary: record.errorSummary, retryOfId: record.retryOfId })) } };
  }
  saveRuntimeKind(value: unknown): RuntimeKind {
    if (value !== 'jinggong' && value !== 'codex' && value !== 'claude_agent_sdk') throw new Error('Runtime 类型无效');
    return this.store.saveRuntimeKind(value);
  }
  redact(text: string): string {
    let value = redact(text);
    const vaults = [...this.store.listProviders().map(profile => this.credential(profile.id)), this.jiraCredential(), this.claudeCredential(), ...this.store.listWeComTargets<{ id: string }>().map(target => this.wecomCredential(target.id))];
    for (const vault of vaults) {
      try { const secret = vault.read(); if (secret) value = redact(value, secret); } catch { /* 凭据损坏不能阻断错误收尾。 */ }
    }
    return value;
  }
  assertCleanText(content: string): void {
    const vaults = [...this.store.listProviders().map(profile => this.credential(profile.id)), this.jiraCredential(), this.claudeCredential(), ...this.store.listWeComTargets<{ id: string }>().map(target => this.wecomCredential(target.id))];
    for (const vault of vaults) {
      let secret: string | undefined;
      try { secret = vault.read(); } catch { continue; }
      if (secret && content.includes(secret)) throw new Error('内容包含当前配置的连接凭据，请移除后重试');
    }
  }
  redactContent(content: string): string {
    let value = content;
    const vaults = [...this.store.listProviders().map(profile => this.credential(profile.id)), this.jiraCredential(), this.claudeCredential(), ...this.store.listWeComTargets<{ id: string }>().map(target => this.wecomCredential(target.id))];
    for (const vault of vaults) {
      try { const secret = vault.read(); if (secret) value = value.split(secret).join('[已脱敏]'); } catch { /* 凭据损坏不能阻断会话显示。 */ }
    }
    return value;
  }
  assertCleanValue(value: unknown): void {
    // 在 JSON 转义之前检查原始字符串，避免引号和反斜杠改变已知密钥的形态。
    const seen = new WeakSet<object>();
    const visit = (item: unknown, depth: number): void => {
      if (depth > 32) throw new Error('资料结构过于复杂');
      if (typeof item === 'string') { this.assertCleanText(item); return; }
      if (item && typeof item === 'object') {
        if (seen.has(item)) throw new Error('资料包含循环引用');
        seen.add(item);
        for (const child of Object.values(item)) visit(child, depth + 1);
      }
    };
    visit(value, 0);
  }
  savePreferences(value: unknown) { const preferences = preferencesSchema.parse(value); this.store.savePreferences(preferences); return preferences; }
  saveLayout(value: unknown) { const layout = layoutSchema.parse(value); this.store.saveLayout(layout); return layout; }
  saveUpdateUrl(value: unknown): string {
    if (typeof value !== 'string') throw new Error('更新地址无效');
    this.assertCleanText(value);
    const { url } = updateFeed(value); this.store.saveUpdateUrl(url); return url;
  }
  saveProfile(value: unknown): ProviderProfile {
    this.assertIdle();
    const input = modelProfileSchema.parse(value);
    for (const field of [input.name, input.baseUrl, ...input.models, ...(input.modelCatalog?.flatMap(item => [item.id, item.name]) ?? [])]) {
      this.assertCleanText(field);
      if (input.apiKey && field.includes(input.apiKey)) throw new Error('中转站元数据不能包含 API Key');
    }
    const current = input.id ? this.profiles().find(item => item.id === input.id) : undefined;
    if (input.id && !current && input.id !== 'legacy-default') throw new Error('模型配置不存在');
    if (!current && this.profiles().length >= 20) throw new Error('最多保存 20 个中转站配置');
    const id = input.id ?? randomUUID();
    const baseUrl = input.baseUrl.replace(/\/$/, '');
    const credential = this.credential(id);
    if (credential.hasKey && !input.apiKey && current?.baseUrl !== baseUrl) throw new Error('更换模型服务地址时请重新输入该服务的 API Key，避免把旧密钥发送到新地址');
    if (input.apiKey) credential.save(input.apiKey, baseUrl);
    const catalog = input.modelCatalog?.filter(item => input.models.includes(item.id)).map(item => ({ id: item.id, name: item.name })) as ProviderModel[] | undefined;
    const profile: ProviderProfile = { id, name: input.name, baseUrl, models: input.models, ...(catalog?.length ? { modelCatalog: catalog } : {}), hasKey: credential.hasKey };
    this.store.saveModelProvider(profile);
    return profile;
  }
  async fetchProviderModels(value: unknown): Promise<ProviderModel[]> {
    this.assertIdle();
    const input = providerModelsSchema.parse(value);
    const id = typeof input === 'string' ? input : input.id;
    const profile = id ? this.profiles().find(item => item.id === id) : undefined;
    if (id && !profile) throw new Error('模型中转站不存在');
    const baseUrl = (typeof input === 'string' ? profile!.baseUrl : input.baseUrl).replace(/\/$/, '');
    const suppliedKey = typeof input === 'string' ? undefined : input.apiKey;
    this.assertCleanText(baseUrl);
    if (!suppliedKey && profile && profile.baseUrl.replace(/\/$/, '') !== baseUrl) throw new Error('更换模型服务地址时请重新输入该服务的 API Key，避免把旧密钥发送到新地址');
    const key = suppliedKey ?? (profile ? this.credential(profile.id).read(baseUrl) : undefined);
    if (!key) throw new Error('请先配置该中转站 API Key');
    if (baseUrl.includes(key)) throw new Error('中转站地址不能包含 API Key');
    try {
      const endpoint = new URL(baseUrl + '/models');
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`获取模型列表失败（HTTP ${response.status}）`);
      const payload = await response.json() as { data?: unknown };
      if (!Array.isArray(payload.data)) throw new Error('中转站返回的模型列表格式无效');
      const models: ProviderModel[] = [];
      for (const item of payload.data) {
        if (!item || typeof item !== 'object') continue;
        const record = item as { id?: unknown; name?: unknown; owned_by?: unknown };
        if (typeof record.id !== 'string' || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(record.id) || record.id.includes(key)) continue;
        const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : typeof record.owned_by === 'string' && record.owned_by.trim() ? record.owned_by.trim() : record.id;
        models.push({ id: record.id, name: redact(name, key).slice(0, 240) });
      }
      const unique = [...new Map(models.map(item => [item.id, item])).values()].slice(0, 100);
      if (!unique.length) throw new Error('中转站未返回可用模型');
      return unique;
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : String(error), key));
    }
  }
  deleteProfile(value: unknown): void {
    this.assertIdle(); const id = profileIdSchema.parse(value);
    this.store.deleteModelProvider(id); this.credential(id).delete();
  }
  saveJira(value: unknown) {
    this.assertIdle();
    const input = jiraSchema.parse(value); const current = this.store.getJira();
    for (const field of [input.baseUrl, input.account]) {
      this.assertCleanText(field);
      if (input.password && field.includes(input.password)) throw new Error('Jira 地址和账号不能包含密码');
    }
    const baseUrl = input.baseUrl.replace(/\/$/, '');
    const vault = this.jiraCredential();
    if (vault.hasKey && !input.password && (current.baseUrl !== baseUrl || current.account !== input.account)) throw new Error('更换 Jira 地址或账号时请重新输入密码');
    const originalUrl = (value as { baseUrl: string }).baseUrl;
    const projectKey = (input.projectKey ?? parseJiraLocation(originalUrl).projectKey ?? current.projectKey ?? 'NEWDEVGROUP').toUpperCase();
    const dateFieldId = input.dateFieldId ?? current.dateFieldId ?? '11116';
    for (const field of [baseUrl, input.account, projectKey, dateFieldId]) {
      this.assertCleanText(field);
      if (input.password && field.includes(input.password)) throw new Error('Jira 配置元数据不能包含密码');
    }
    if (input.password) vault.save(input.password, `${baseUrl}\n${input.account}`);
    const result = { baseUrl, account: input.account, hasPassword: vault.hasKey, projectKey, dateFieldId };
    this.store.saveJira(result); return result;
  }
  saveClaudeCredential(value: unknown): { hasCredential: boolean } {
    this.assertIdle();
    this.claudeCredential().save(claudeCredentialSchema.parse(value), 'anthropic-console');
    return { hasCredential: true };
  }
  claudeRuntime(): ClaudeRuntimeSettings {
    return { ...this.store.getClaudeRuntime(), hasCredential: this.claudeCredential().hasKey };
  }
  saveClaudeRuntime(value: unknown): ClaudeRuntimeSettings {
    this.assertIdle();
    const input = claudeRuntimeSchema.parse(value);
    this.assertCleanText(input.model);
    if (input.baseUrl) this.assertCleanText(input.baseUrl);
    this.store.saveClaudeRuntime(input);
    return this.claudeRuntime();
  }
  clearClaudeCredential(): void { this.assertIdle(); this.claudeCredential().delete(); }
  private wecomTargets(): WeComTargetSummary[] {
    return this.store.listWeComTargets<Omit<WeComTargetSummary, 'hasCredential'> & { hasCredential?: boolean }>().map(target => ({ ...target, hasCredential: this.wecomCredential(target.id).hasKey }));
  }
  wecomTargetsForDelivery(): WeComNotificationTarget[] {
    return this.wecomTargets().map(target => ({ id: target.id, name: target.name, purpose: target.purpose, credentialRef: target.credentialRef, enabled: target.enabled, eventPolicy: target.eventPolicy, ...(target.mentionedUserIds?.length ? { mentionedUserIds: target.mentionedUserIds } : {}), ...(target.mentionedMobiles?.length ? { mentionedMobiles: target.mentionedMobiles } : {}), ...(target.workspaceIds?.length ? { workspaceIds: target.workspaceIds } : {}), ...(target.runtimeKinds?.length ? { runtimeKinds: target.runtimeKinds } : {}) }));
  }
  readWeComCredential(reference: string): string | undefined {
    const match = /^wecom\.webhook\.([a-f0-9-]{36})$/i.exec(reference);
    if (!match) return undefined;
    const target = this.wecomTargets().find(item => item.id === match[1]);
    if (!target || target.credentialRef !== reference) return undefined;
    return this.wecomCredential(target.id).read(`wecom.webhook.${target.id}`);
  }
  saveWeComTarget(value: unknown): WeComTargetSummary {
    this.assertIdle();
    const input = wecomTargetSchema.parse(value);
    const current = input.id ? this.wecomTargets().find(item => item.id === input.id) : undefined;
    if (input.id && !current) throw new Error('企业微信通知目标不存在');
    if (!current && !input.webhookUrl) throw new Error('请填写 Webhook 地址');
    const id = current?.id ?? randomUUID();
    const credential = this.wecomCredential(id);
    const now = new Date().toISOString();
    const target: WeComTargetSummary = {
      id, name: input.name, purpose: input.purpose, credentialRef: `wecom.webhook.${id}`, hasCredential: Boolean(input.webhookUrl) || credential.hasKey, enabled: input.enabled,
      ...(input.purpose === 'team_group' && input.mentionedUserIds?.length ? { mentionedUserIds: input.mentionedUserIds } : {}),
      ...(input.purpose === 'team_group' && input.mentionedMobiles?.length ? { mentionedMobiles: input.mentionedMobiles } : {}),
      ...(input.workspaceIds?.length ? { workspaceIds: [...new Set(input.workspaceIds)] } : {}),
      ...(input.runtimeKinds?.length && input.runtimeKinds.length < 3 ? { runtimeKinds: [...new Set(input.runtimeKinds)] } : {}),
      eventPolicy: input.eventPolicy, createdAt: current?.createdAt ?? now, updatedAt: now,
    };
    this.assertCleanValue(target);
    // 先完成所有可持久化元数据校验，Webhook 只进入 safeStorage。
    if (input.webhookUrl && JSON.stringify(target).includes(input.webhookUrl)) throw new Error('通知目标元数据不能包含 Webhook 地址');
    if (input.webhookUrl) credential.save(input.webhookUrl, `wecom.webhook.${id}`);
    try {
      this.store.saveWeComTarget(target);
    } catch (error) {
      // 新目标元数据写入失败时清掉刚创建的孤立凭据；编辑旧目标则保留原凭据，避免数据库短暂故障造成凭据丢失。
      if (!current && input.webhookUrl) credential.delete();
      throw error;
    }
    return target;
  }
  deleteWeComTarget(value: unknown): void {
    this.assertIdle(); const id = idSchema.parse(value);
    if (!this.wecomTargets().some(item => item.id === id)) throw new Error('企业微信通知目标不存在');
    this.store.deleteWeComTarget(id); this.wecomCredential(id).delete();
  }
  saveRequirement(value: unknown): ManagedDocument {
    this.assertIdle(); const input = requirementInputSchema.parse(value);
    this.assertCleanText(input.title + '\n' + input.content);
    const current = input.id ? this.store.listDocuments().find(document => document.id === input.id && document.kind === 'requirement') : undefined;
    if (input.id && !current) throw new Error('开发要求不存在，不能覆盖其他资料');
    if (!current && this.store.listDocuments().length >= 100) throw new Error('资料最多 100 份，请先整理和删除');
    const name = /\.(?:md|txt|json)$/i.test(input.title) ? input.title : `${input.title}.md`;
    const document: ManagedDocument = { id: current?.id ?? randomUUID(), kind: 'requirement', system: input.system, name, content: input.content, digest: createHash('sha256').update(input.content).digest('hex'), createdAt: current?.createdAt ?? new Date().toISOString(), enabled: current?.enabled ?? true, ...(current?.remote ? { remote: current.remote } : {}) };
    parsePolicy(document); this.store.saveDocument(document); return document;
  }
  saveMemory(value: unknown) {
    this.assertIdle(); const input = memorySchema.parse(value); this.assertCleanText(input.title + '\n' + input.content);
    if (this.store.listMemories().length >= 100) throw new Error('记忆最多 100 条，请先整理和删除');
    const memory = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
    this.store.saveMemory(memory); return memory;
  }
  deleteMemory(value: unknown): void { this.assertIdle(); this.store.deleteMemory(idSchema.parse(value)); }
}
