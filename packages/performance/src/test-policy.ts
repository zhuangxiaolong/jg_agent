export type TestLevel = 'smoke' | 'targeted' | 'unit' | 'build' | 'integration' | 'full';
export interface RegisteredTestCommand {
  id: string; repositoryId: string; name: string; level: TestLevel; executable: string; args: string[]; workingDirectory: string;
  timeoutMs: number; requiresNetwork: boolean; requiresDatabase: boolean; sideEffectLevel: 'none' | 'local' | 'external'; enabled: boolean;
  changedPathPrefixes?: string[];
}
export interface TestPlanEntry { command: RegisteredTestCommand; selected: boolean; requiresApproval: boolean; reason: string; status: 'not_run' }
export interface TestPlan { entries: TestPlanEntry[]; missingFull: boolean; warnings: string[] }
const ORDER: Record<TestLevel, number> = { smoke: 0, targeted: 1, unit: 2, build: 3, integration: 4, full: 5 };

/** 只推荐登记命令，执行继续交给现有 VerificationRunService 采集真实证据。 */
export function recommendTests(input: { commands: RegisteredTestCommand[]; changedFiles: string[]; fullRequested?: boolean; multiRepository?: boolean }): TestPlan {
  const documentationOnly = input.changedFiles.length > 0 && input.changedFiles.every(file => /\.(?:md|txt)$/i.test(file));
  const entries = input.commands.map(command => {
    const relevant = !command.changedPathPrefixes?.length || input.changedFiles.some(file => command.changedPathPrefixes!.some(prefix => file.startsWith(prefix)));
    let selected = command.enabled && (relevant || command.level === 'full' && input.fullRequested === true) && (['smoke', 'targeted', 'unit', 'build'].includes(command.level) || command.level === 'integration' && input.multiRepository === true || command.level === 'full' && input.fullRequested === true);
    let reason = selected ? command.level === 'full' ? '用户明确要求全量测试' : command.level === 'build' ? '变更后需要构建验证' : '与变更范围相关，先执行快速验证' : !command.enabled ? '登记命令已禁用' : !relevant ? '变更路径不属于该模块' : '当前策略未选择该测试层级';
    if (documentationOnly && command.level !== 'smoke' && !(command.level === 'full' && input.fullRequested)) { selected = false; reason = '仅文档改动，保留用户明确要求的 full，其余代码测试未执行'; }
    const requiresApproval = command.requiresDatabase || command.requiresNetwork || command.sideEffectLevel === 'external' || command.level === 'full';
    if (selected && requiresApproval) reason += '；须通过既有平台审批/验证入口执行';
    return { command: structuredClone(command), selected, requiresApproval, reason, status: 'not_run' as const };
  }).sort((a, b) => ORDER[a.command.level] - ORDER[b.command.level]);
  const missingFull = input.fullRequested === true && !entries.some(entry => entry.command.enabled && entry.command.level === 'full');
  return { entries, missingFull, warnings: [...(input.commands.length ? [] : ['项目没有登记测试命令，未猜测或执行命令']), ...(missingFull ? ['用户要求 full，但没有启用的全量测试登记命令；须明确说明未执行原因'] : [])] };
}
