import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export class CredentialStore {
  constructor(private readonly filename: string) {}
  get hasKey(): boolean { return existsSync(this.filename); }
  save(secret: string, scope?: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，拒绝保存密钥');
    mkdirSync(dirname(this.filename), { recursive: true });
    const encrypted = safeStorage.encryptString(scope ? JSON.stringify({ version: 1, scope, secret }) : secret);
    writeFileSync(`${this.filename}.tmp`, encrypted);
    renameSync(`${this.filename}.tmp`, this.filename);
  }
  read(scope?: string): string | undefined {
    if (!this.hasKey) return undefined;
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用');
    const value = safeStorage.decryptString(readFileSync(this.filename));
    if (!value.startsWith('{')) return value; // 兼容 V0.1 单模型凭据，后续保存即绑定服务。
    const record = JSON.parse(value);
    if (record.version !== 1 || typeof record.secret !== 'string' || (scope && record.scope !== scope)) throw new Error('凭据与当前服务或账号不匹配，请重新配置');
    return record.secret;
  }
  delete(): void { if (this.hasKey) unlinkSync(this.filename); }
}
