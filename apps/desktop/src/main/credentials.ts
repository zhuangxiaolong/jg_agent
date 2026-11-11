import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface CredentialVault {
  has(reference: string, scope: string): boolean;
  save(reference: string, secret: string, scope: string): void;
  delete(reference: string, scope: string): void;
}

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

/** MCP 凭据只按不可逆文件名落 DPAPI，引用和作用域写在加密载荷内。 */
export class DpapiCredentialVault implements CredentialVault {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private credential(reference: string, scope: string): CredentialStore {
    const id = createHash('sha256').update(scope).update('\0').update(reference).digest('hex');
    return new CredentialStore(join(this.root, `${id}.dpapi`));
  }
  has(reference: string, scope: string): boolean { return this.credential(reference, scope).read(scope) !== undefined; }
  save(reference: string, secret: string, scope: string): void {
    if (!reference || !scope || !secret) throw new Error('MCP 凭据引用、作用域和密钥不能为空');
    this.credential(reference, scope).save(secret, scope);
  }
  delete(reference: string, scope: string): void { this.credential(reference, scope).delete(); }
}
