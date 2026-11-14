import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../../../../packages/domain/src';
import { normalizeGrokBaseUrl, type GrokModelProfile, type GrokProviderProfile } from '../../../../packages/domain/src/grok';
import { GROK_BUILD_RUNTIME_VERSION, GROK_EXECUTION_RULES_VERSION } from '../../../../packages/agent-runtime/src/grok-config';

type Provider = Pick<GrokProviderProfile, 'id' | 'baseUrl'>;
type Model = Pick<GrokModelProfile, 'id' | 'apiBackend'>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** 配置身份与随机代际共同隔离目录，A→B→A 也不会撞上已绑定的原生会话。 */
export async function resolveGrokSessionBinding(dataRoot: string, session: Session, provider: Provider, model: Model, capabilitiesVersion: number): Promise<{ session: Session; home: string }> {
  const baseUrl = normalizeGrokBaseUrl(provider.baseUrl);
  const configuration = digest(JSON.stringify([provider.id, baseUrl, model.id, model.apiBackend, capabilitiesVersion, GROK_EXECUTION_RULES_VERSION])).slice(0, 32);
  const legacyBinding = digest(provider.id + '\0' + model.id);
  const profile = provider.id + '\0' + model.id + '\0' + model.apiBackend;
  const root = path.join(dataRoot, 'runtime', 'homes', 'grok_build_acp');
  const home = path.join(root, digest(profile + '\0' + capabilitiesVersion).slice(0, 32), session.id);
  const legacy = session.grokBinding === legacyBinding || (!session.grokBinding && Boolean(session.runtimeThreadId));
  if (legacy && session.runtimeCapabilitiesVersion === capabilitiesVersion) {
    // 旧会话沿用原目录；同一中转站改地址或协议后不能加载到新服务。
    for (const candidate of [home, path.join(root, digest(profile).slice(0, 32), session.id)]) {
      try {
        const marker = path.join(candidate, 'jinggong-profile.json');
        const info = await lstat(marker);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 65536) throw new Error('Grok 配置绑定文件不安全');
        const saved = JSON.parse(await readFile(marker, 'utf8'));
        const fingerprint = digest(JSON.stringify([baseUrl, model.id, model.apiBackend, GROK_BUILD_RUNTIME_VERSION]));
        if (saved?.owner === 'jinggong-grok' && saved.fingerprint === fingerprint && saved.executionRulesVersion === GROK_EXECUTION_RULES_VERSION) return { session, home: candidate };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  if (!legacy && session.grokBinding?.startsWith(configuration)) {
    const currentHome = path.join(home, session.grokBinding);
    let bound = false;
    if (!session.runtimeThreadId) {
      try { await lstat(path.join(currentHome, 'jinggong-session.json')); bound = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    // 项目/分支切换或初始化中断后，平台可能已清线程；已有原生绑定的目录不能重新 session/new。
    if (!bound) return { session, home: currentHome };
  }
  const updated: Session = {
    ...session, grokBinding: configuration + randomUUID().replaceAll('-', ''),
    runtimeThreadId: undefined, runtimeNativeSessionId: undefined, runtimeVersion: undefined, runtimeCapabilitiesVersion: undefined,
  };
  return { session: updated, home: path.join(home, updated.grokBinding!) };
}
