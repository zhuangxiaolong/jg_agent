import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CredentialStore } from './credentials';
import { idSchema, jiraSchema, layoutSchema, memorySchema, modelProfileSchema, preferencesSchema, profileIdSchema, redact, requirementInputSchema } from './security';
import { parseJiraLocation } from '../../../../packages/jira-connector/src';
import { parsePolicy } from '../../../../packages/policy/src';
import { DEFAULT_UPDATE_URL, updateFeed } from '../../../../packages/domain/src/updates';
import type { LocalStore } from '../../../../packages/storage/src';
import type { ManagedDocument, ProviderProfile, ProviderSettings, SettingsSnapshot, UpdateStatus } from '../../../../packages/domain/src';

/** 凭据只在主进程解密，数据库和 Renderer 永远只接收是否已配置。 */
export class SettingsService {
  constructor(private readonly store: LocalStore, private readonly dataRoot: string, private readonly assertIdle: () => void, private readonly appVersion = '开发版') {}

  credential(id: string): CredentialStore {
    profileIdSchema.parse(id);
    return new CredentialStore(id === 'legacy-default' ? path.join(this.dataRoot, 'config/model-key.dpapi') : path.join(this.dataRoot, 'config/secrets', `${id}.dpapi`));
  }
  jiraCredential(): CredentialStore { return new CredentialStore(path.join(this.dataRoot, 'config/secrets/jira.dpapi')); }
  profiles(): ProviderProfile[] { return this.store.listProviders().map(profile => ({ ...profile, hasKey: this.credential(profile.id).hasKey })); }
  defaultProvider(): ProviderSettings {
    const profile = this.profiles()[0];
    return profile ? { baseUrl: profile.baseUrl, model: profile.models[0], hasKey: profile.hasKey } : { baseUrl: '', model: '', hasKey: false };
  }
  snapshot(update: UpdateStatus = { state: 'disabled', message: '更新检查尚未启动' }): SettingsSnapshot {
    return { preferences: this.store.getPreferences(), providers: this.profiles(), jira: { ...this.store.getJira(), hasPassword: this.jiraCredential().hasKey }, documents: this.store.listDocuments(), memories: this.store.listMemories(), update, appVersion: this.appVersion, updateUrl: this.store.getUpdateUrl() ?? DEFAULT_UPDATE_URL, requirementsSync: this.store.getRequirementsSync() };
  }
  redact(text: string): string {
    let value = redact(text);
    const vaults = [...this.store.listProviders().map(profile => this.credential(profile.id)), this.jiraCredential()];
    for (const vault of vaults) {
      try { const secret = vault.read(); if (secret) value = redact(value, secret); } catch { /* 凭据损坏不能阻断错误收尾。 */ }
    }
    return value;
  }
  assertCleanText(content: string): void {
    const vaults = [...this.store.listProviders().map(profile => this.credential(profile.id)), this.jiraCredential()];
    for (const vault of vaults) {
      let secret: string | undefined;
      try { secret = vault.read(); } catch { continue; }
      if (secret && content.includes(secret)) throw new Error('内容包含当前配置的连接凭据，请移除后重试');
    }
  }
  redactContent(content: string): string {
    let value = content;
    const vaults = [...this.store.listProviders().map(profile => this.credential(profile.id)), this.jiraCredential()];
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
    for (const field of [input.name, input.baseUrl, ...input.models]) {
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
    const profile: ProviderProfile = { id, name: input.name, baseUrl, models: input.models, hasKey: credential.hasKey };
    this.store.saveModelProvider(profile);
    return profile;
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
