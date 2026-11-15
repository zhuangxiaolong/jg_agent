import { createHash } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, relative } from 'node:path';
import { z } from 'zod';
import { assessTaskRecovery, confirmTaskPlan, createTaskCheckpoint, createTaskPlan, refreshReadyTaskSteps, transitionTaskStep, type RecoveryAssessmentInput, type TaskGovernanceStore } from '../../../../packages/second-iteration/src';
import type { GitConnector } from '../../../../packages/git-connector/src';
import type { Project, TaskCheckpoint, TaskGovernanceCheckpointInput, TaskGovernancePlanInput } from '../../../../packages/domain/src';

type Handle = (channel: string, fn: (...args: any[]) => any) => void;

const taskIdSchema = z.string().trim().min(1).max(160);
const planIdSchema = z.string().uuid();
const stepIdSchema = z.string().uuid();
const projectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i);
const textListSchema = z.array(z.string().trim().min(1).max(2000)).max(500);
const planInputSchema = z.object({
  taskId: taskIdSchema,
  projectId: projectIdSchema.optional(),
  goal: z.string().trim().min(1).max(8000),
  assumptions: textListSchema.optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(100),
  steps: z.array(z.object({
    stepKey: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    order: z.number().int().min(0),
    dependsOn: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
    required: z.boolean().optional(),
  }).strict()).min(1).max(100),
}).strict();
const checkpointInputSchema = z.object({
  taskId: taskIdSchema,
  planId: planIdSchema,
  stepId: stepIdSchema,
  projectId: projectIdSchema.optional(),
  contextSnapshotId: z.string().trim().min(1).max(160).optional(),
  runtimeId: z.string().trim().min(1).max(160).optional(),
  runtimeSessionId: z.string().trim().min(1).max(160).optional(),
  checkpointSummary: z.string().trim().min(1).max(8000),
  completedActions: textListSchema,
  pendingActions: textListSchema,
  evidenceRefs: textListSchema,
}).strict();
const transitionSchema = z.object({
  planId: planIdSchema,
  stepId: stepIdSchema,
  next: z.enum(['pending', 'ready', 'running', 'succeeded', 'failed', 'skipped', 'blocked', 'invalidated']),
  outputSummary: z.string().max(8000).optional(),
  evidenceRefs: textListSchema.optional(),
}).strict();

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/**
 * 读取实际任务工作区的原始字节指纹，包含二进制和删除记录；不保存源代码正文。
 * 大仓库、特殊文件或采集期间发生变动时拒绝生成“完整”指纹。
 */
export async function projectFingerprint(git: GitConnector, project: Project, workspacePath = project.path): Promise<{
  branch?: string;
  headSha?: string;
  worktreeFingerprint?: string;
  fileManifest: Array<{ path: string; sha256: string; status?: string }>;
}> {
  try {
    await git.projectState(project);
    const state = await git.state(workspacePath, true);
    const files = await git.files(workspacePath, true);
    const changes = await git.diff(workspacePath, true);
    if (files.length >= 10000 || changes.some(item => item.truncated)) return { fileManifest: [] };
    const changed = new Map(changes.map(item => [item.path, `${item.status}${item.staged ? ':staged' : ':working'}`]));
    const manifest: Array<{ path: string; sha256: string; status?: string }> = [];
    const checkedParents = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      const clean = file.path.replace(/\\/g, '/');
      if (isAbsolute(clean) || clean.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('检查点路径无效');
      const target = resolve(workspacePath, clean);
      if (relative(workspacePath, target).startsWith('..')) throw new Error('检查点路径越界');
      let parent = dirname(target);
      while (!checkedParents.has(parent)) {
        if ((await lstat(parent)).isSymbolicLink()) throw new Error('检查点路径包含链接');
        checkedParents.add(parent);
        if (parent === resolve(workspacePath)) break;
        const next = dirname(parent); if (next === parent) throw new Error('检查点路径越界'); parent = next;
      }
      const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!info) { manifest.push({ path: clean, sha256: digest('jinggong:deleted-file'), status: 'D' }); continue; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 64 * 1024 * 1024) throw new Error('检查点不接受链接、特殊文件或超限文件');
      totalBytes += info.size;
      if (totalBytes > 256 * 1024 * 1024) throw new Error('检查点文件总量超限');
      const handle = await open(target, 'r');
      let hash: string;
      try {
        const before = await handle.stat();
        if (before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size || before.mtimeMs !== info.mtimeMs) throw new Error('采集期间文件发生变更');
        const value = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let position = 0;
        while (position < before.size) {
          const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
          if (!read.bytesRead) throw new Error('采集期间文件发生变更');
          value.update(buffer.subarray(0, read.bytesRead)); position += read.bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('采集期间文件发生变更');
        hash = value.digest('hex');
      } finally { await handle.close(); }
      manifest.push({ path: clean, sha256: hash, ...(changed.has(file.path) ? { status: changed.get(file.path) } : {}) });
    }
    manifest.sort((left, right) => left.path.localeCompare(right.path));
    const later = await git.state(workspacePath, true);
    const laterFiles = await git.files(workspacePath, true);
    const laterChanges = await git.diff(workspacePath, true);
    if (state.branch !== later.branch || state.commits[0]?.hash !== later.commits[0]?.hash || JSON.stringify(files) !== JSON.stringify(laterFiles) || JSON.stringify(changes) !== JSON.stringify(laterChanges)) throw new Error('采集期间 Git 状态发生变更');
    const canonical = JSON.stringify({ files: manifest.map(item => ({ path: item.path, sha256: item.sha256, status: item.status ?? '' })), diff: changes });
    const headSha = state.commits[0]?.hash;
    if (!state.branch || !headSha) return { fileManifest: [] };
    return { branch: state.branch, headSha, worktreeFingerprint: digest(canonical), fileManifest: manifest };
  } catch {
    return { fileManifest: [] };
  }
}

function listPlans(store: TaskGovernanceStore, taskId: string) {
  return store.listTaskPlans(taskId).map(plan => ({ plan, steps: store.listTaskPlanSteps(plan.id) }));
}

export function registerTaskGovernanceIpc(input: {
  handle: Handle;
  store: TaskGovernanceStore;
  git: GitConnector;
  project: (value: unknown) => Project;
  resolveWorkspace?: (taskId: string, projectId: string) => string | Promise<string>;
  resolveRuntime?: (checkpoint: TaskCheckpoint) => Promise<{ available: boolean; nativeSessionResumeSupported?: boolean }>;
  resolveContext?: (checkpoint: TaskCheckpoint) => Promise<Pick<RecoveryAssessmentInput, 'contextSnapshotId' | 'contextUnchanged' | 'validationStillApplicable'>>;
  isTaskRunning?: (taskId: string) => boolean;
}) {
  const { handle, store, git, project } = input;
  handle('task-governance:plans', (taskValue: unknown) => listPlans(store, taskIdSchema.parse(taskValue)));
  handle('task-governance:plan-create', (value: unknown) => {
    const parsed = planInputSchema.parse(value) as TaskGovernancePlanInput;
    if (parsed.projectId) project(parsed.projectId);
    return createTaskPlan(store, parsed);
  });
  handle('task-governance:plan-confirm', (value: unknown) => {
    const planId = planIdSchema.parse(value);
    const plan = store.listTaskPlans().find(item => item.id === planId);
    if (plan && input.isTaskRunning?.(plan.taskId)) throw new Error('任务仍在运行，请等待当前阶段结束再确认计划');
    return confirmTaskPlan(store, planId);
  });
  handle('task-governance:steps-refresh', (value: unknown) => refreshReadyTaskSteps(store, planIdSchema.parse(value)));
  handle('task-governance:step-transition', (value: unknown) => {
    const parsed = transitionSchema.parse(value);
    const plan = store.listTaskPlans().find(item => item.id === parsed.planId);
    if (plan && parsed.next !== 'running' && input.isTaskRunning?.(plan.taskId)) throw new Error('任务仍在运行，请等待当前阶段结束后记录结果');
    return transitionTaskStep(store, parsed.planId, parsed.stepId, parsed.next, { outputSummary: parsed.outputSummary, evidenceRefs: parsed.evidenceRefs });
  });
  handle('task-governance:checkpoint-create', async (value: unknown) => {
    const parsed = checkpointInputSchema.parse(value) as TaskGovernanceCheckpointInput;
    if (input.isTaskRunning?.(parsed.taskId)) throw new Error('任务仍在运行，请等待当前阶段结束后保存检查点');
    if (parsed.projectId) {
      const target = project(parsed.projectId);
      const workspace = await input.resolveWorkspace?.(parsed.taskId, parsed.projectId) ?? target.path;
      const fingerprint = await projectFingerprint(git, target, workspace);
      return createTaskCheckpoint(store, { ...parsed, ...fingerprint });
    }
    return createTaskCheckpoint(store, { ...parsed, fileManifest: [] });
  });
  handle('task-governance:checkpoints', (value: unknown) => store.listTaskCheckpoints(taskIdSchema.parse(value)));
  handle('task-governance:recovery-assess', async (value: unknown) => {
    const checkpointId = z.string().uuid().parse(value);
    const checkpoint = store.getTaskCheckpoint?.(checkpointId);
    if (!checkpoint) throw new Error('任务检查点不存在');
    if (input.isTaskRunning?.(checkpoint.taskId)) throw new Error('任务仍在运行，不能同时启动恢复审查');
    let current: RecoveryAssessmentInput = { runtimeAvailable: false, nativeSessionResumeSupported: false };
    if (checkpoint.projectId) {
      try {
        const target = project(checkpoint.projectId);
        const workspace = await input.resolveWorkspace?.(checkpoint.taskId, checkpoint.projectId) ?? target.path;
        const fingerprint = await projectFingerprint(git, target, workspace);
        const runtime = await input.resolveRuntime?.(checkpoint);
        const context = await input.resolveContext?.(checkpoint);
        current = { ...fingerprint, ...context, runtimeAvailable: runtime?.available === true, nativeSessionResumeSupported: runtime?.nativeSessionResumeSupported === true };
      } catch {
        current = { runtimeAvailable: false, nativeSessionResumeSupported: false };
      }
    }
    return assessTaskRecovery(store, checkpointId, current);
  });
}
