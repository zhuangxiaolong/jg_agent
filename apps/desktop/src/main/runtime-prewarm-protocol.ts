import type { RuntimeHealth, RuntimeKind } from '../../../../packages/domain/src';
import type { verifyRuntimeManifestAsync } from './runtime-integrity';

export type RuntimeManifest = Awaited<ReturnType<typeof verifyRuntimeManifestAsync>>;

/** 仅传递本地组件位置，不将会话、模型凭据或工具回调送入预检线程。 */
export type RuntimePrewarmRequest = {
  id: number;
  method: 'check' | 'verify';
  kind: RuntimeKind;
  resourcesRoot: string;
  dataRoot: string;
  grokExecutablePath?: string;
  proxyUrl?: string;
} | { id: number; method: 'close' };

export type RuntimePrewarmResponse = {
  id: number;
  result: RuntimeHealth | RuntimeManifest | null;
} | { id: number; error: string } | {
  /** 主进程持有子进程清单，用于线程超时或异常退出后的后备回收。 */
  type: 'child';
  pid: number;
  active: boolean;
};
