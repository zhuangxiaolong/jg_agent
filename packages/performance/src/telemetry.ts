import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RuntimeKind } from '../../domain/src';
import type { PerformanceReport, PerformanceSettings, PerformanceSpan, PerformanceStage, PerformanceState, PerformanceStatus, PerformanceTrace } from './types';

const MAX_TRACES = 200;
const MAX_SPANS = 1500;
const STATUSES = new Set(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'unavailable']);
export function defaultPerformanceSettings(): PerformanceSettings {
  return { enabled: true, telemetryEnabled: true, workspaceIndexEnabled: true, contextOptimizationEnabled: true, safeParallelEnabled: true,
    maxParallelReadOperations: 3, retainDays: 30, contextBudgetTokens: 6000, testStrategy: 'recommend', version: 1,
    updatedAt: new Date().toISOString(), runtimeOverrides: {}, workspaceOverrides: {} };
}
function identifier(value: string | undefined): string | undefined { return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : undefined; }
function endpoint(value?: string): string | undefined {
  if (!value) return;
  try { const url = new URL(value); return `${url.protocol}//${url.host}`; } catch { return 'unavailable'; }
}
export function cleanPerformanceText(value: string): string {
  return value.replace(/Bearer\s+[^\s,;"'<>]+/gi, 'Bearer [已脱敏]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已脱敏]')
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization)(["'\s]*[:=]["'\s]*)([^\s,"'}]+)/gi, '$1$2[已脱敏]');
}

/** 仅记录白名单指标，不保存模型文本、隐藏推理或完整工具参数。 */
export class PerformanceTelemetry {
  private state: PerformanceState;
  private readonly clocks = new Map<string, number>();
  private readonly spanClocks = new Map<string, number>();
  private readonly runtimeSpans = new Map<string, string>();
  private persistTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly options: { load?: () => unknown; save?: (state: PerformanceState) => void; redact?: (text: string) => string; now?: () => number } = {}) {
    let loaded: PerformanceState | undefined;
    try { const candidate = options.load?.() as PerformanceState | undefined; if (candidate?.version === 1 && candidate.settings && typeof candidate.settings === 'object' && Array.isArray(candidate.traces)) loaded = candidate; } catch { /* 性能历史不可用时不阻断开发流程。 */ }
    this.state = loaded
      ? { version: 1, settings: { ...defaultPerformanceSettings(), ...loaded.settings }, traces: loaded.traces.filter(trace => trace && typeof trace.id === 'string' && typeof trace.sessionId === 'string' && typeof trace.startedAt === 'string' && STATUSES.has(trace.status) && ['codex', 'jinggong', 'claude_agent_sdk', 'grok_build_acp'].includes(trace.runtimeKind) && Array.isArray(trace.spans) && trace.spans.length <= MAX_SPANS && trace.spans.every(span => span && typeof span.id === 'string' && typeof span.stage === 'string' && typeof span.operation === 'string' && STATUSES.has(span.status))).slice(-MAX_TRACES) }
      : { version: 1, settings: defaultPerformanceSettings(), traces: [] };
    for (const trace of this.state.traces) {
      if (trace.status === 'running') { trace.status = 'interrupted'; trace.endedAt = new Date().toISOString(); }
      for (const span of trace.spans) if (span.status === 'running') { span.status = 'interrupted'; span.endedAt = trace.endedAt; }
    }
    this.prune(); this.persist();
  }
  private now(): number { return this.options.now?.() ?? performance.now(); }
  private persist(immediate = false): void {
    if (!this.options.save) return;
    const save = () => { try { this.options.save?.(structuredClone(this.state)); } catch { /* 遥测存储失败不能导致原始任务失败。 */ } };
    if (immediate) { if (this.persistTimer) clearTimeout(this.persistTimer); this.persistTimer = undefined; save(); return; }
    if (!this.persistTimer) { this.persistTimer = setTimeout(() => { this.persistTimer = undefined; save(); }, 200); this.persistTimer.unref(); }
  }
  private prune(): void {
    const cutoff = Date.now() - this.state.settings.retainDays * 86400000;
    this.state.traces = this.state.traces.filter(item => item.status === 'running' || Date.parse(item.startedAt) >= cutoff).slice(-MAX_TRACES);
  }
  getSettings(): PerformanceSettings { return structuredClone(this.state.settings); }
  isEnabled(runtimeKind?: RuntimeKind, workspaceId?: string): boolean {
    const settings = this.state.settings;
    return settings.enabled && (!runtimeKind || settings.runtimeOverrides[runtimeKind] !== false) && (!workspaceId || settings.workspaceOverrides[workspaceId] !== false);
  }
  updateSettings(patch: Partial<PerformanceSettings>): PerformanceSettings {
    const allowed = ['enabled', 'telemetryEnabled', 'workspaceIndexEnabled', 'contextOptimizationEnabled', 'safeParallelEnabled', 'maxParallelReadOperations', 'retainDays', 'contextBudgetTokens', 'testStrategy', 'runtimeOverrides', 'workspaceOverrides'];
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('性能设置字段无效');
    for (const key of ['enabled', 'telemetryEnabled', 'workspaceIndexEnabled', 'contextOptimizationEnabled', 'safeParallelEnabled'] as const) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error('性能开关无效');
    for (const [key, minimum, maximum] of [['maxParallelReadOperations', 1, 3], ['retainDays', 1, 365], ['contextBudgetTokens', 256, 1000000]] as const) {
      const value = patch[key]; if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > maximum)) throw new Error(`性能设置 ${key} 超出范围`);
    }
    if (patch.testStrategy !== undefined && !['recommend', 'targeted', 'full_approval'].includes(patch.testStrategy)) throw new Error('测试策略无效');
    for (const key of ['runtimeOverrides', 'workspaceOverrides'] as const) if (patch[key] !== undefined) {
      const value = patch[key]; if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([name, enabled]) => typeof enabled !== 'boolean' || !/^[\w.:-]{1,128}$/.test(name) || key === 'runtimeOverrides' && !['codex', 'jinggong', 'claude_agent_sdk', 'grok_build_acp'].includes(name))) throw new Error('性能覆盖规则无效');
    }
    this.state.settings = { ...this.state.settings, ...structuredClone(patch), version: this.state.settings.version + 1, updatedAt: new Date().toISOString() };
    this.prune(); this.persist(); return this.getSettings();
  }
  resetSettings(): PerformanceSettings {
    const version = this.state.settings.version + 1; this.state.settings = { ...defaultPerformanceSettings(), version }; this.persist(); return this.getSettings();
  }
  startTrace(input: { sessionId: string; taskId?: string; workspaceId?: string; runtimeKind: RuntimeKind; providerId?: string; modelId?: string; baseUrl?: string }): string | undefined {
    if (!this.isEnabled(input.runtimeKind, input.workspaceId) || !this.state.settings.telemetryEnabled) return;
    const id = randomUUID();
    const trace: PerformanceTrace = { id, sessionId: input.sessionId, taskId: input.taskId ?? id, workspaceId: input.workspaceId,
      runtimeKind: input.runtimeKind, providerId: identifier(input.providerId), modelId: identifier(input.modelId), endpoint: endpoint(input.baseUrl),
      status: 'running', startedAt: new Date().toISOString(), toolEvents: 0, retryCount: 0, spans: [] };
    this.state.traces.push(trace); this.clocks.set(id, this.now()); this.prune(); this.persist(); return id;
  }
  startSpan(traceId: string | undefined, input: { stage: PerformanceStage; operation: string; parentSpanId?: string }): string | undefined {
    const trace = this.state.traces.find(item => item.id === traceId);
    if (!trace || trace.status !== 'running' || trace.spans.length >= MAX_SPANS) return;
    if (input.parentSpanId && !trace.spans.some(item => item.id === input.parentSpanId)) throw new Error('父性能阶段不存在');
    const id = randomUUID(); const span: PerformanceSpan = { ...input, operation: (this.options.redact?.(cleanPerformanceText(input.operation)) ?? cleanPerformanceText(input.operation)).slice(0, 100), id, traceId: trace.id, status: 'running', startedAt: new Date().toISOString() };
    trace.spans.push(span); this.spanClocks.set(id, this.now()); this.persist(); return id;
  }
  endSpan(spanId: string | undefined, status: Exclude<PerformanceStatus, 'running'> = 'completed', metrics: { itemCount?: number; byteCount?: number; errorCode?: string } = {}): void {
    if (!spanId) return;
    for (const trace of this.state.traces) {
      const span = trace.spans.find(item => item.id === spanId); if (!span || span.status !== 'running') continue;
      const started = this.spanClocks.get(spanId);
      span.status = status; span.endedAt = new Date().toISOString();
      if (started !== undefined) span.durationMs = Math.max(0, this.now() - started);
      for (const key of ['itemCount', 'byteCount'] as const) if (Number.isFinite(metrics[key]) && metrics[key]! >= 0) span[key] = metrics[key];
      if (metrics.errorCode) span.errorCode = metrics.errorCode.replace(/[^A-Z0-9_]/gi, '').slice(0, 64);
      this.spanClocks.delete(spanId); this.persist(); return;
    }
  }
  recordRuntimeEvent(traceId: string | undefined, event: { type: string; text: string; requestId?: string | number; performance?: { callId: string; phase: 'started' | 'completed'; operation: string; stage: string; exitCode?: number | null } }): void {
    const trace = this.state.traces.find(item => item.id === traceId); if (!trace || trace.status !== 'running') return;
    if ((event.type === 'delta' || event.type === 'message') && event.text.trim() && trace.firstVisibleResponseMs === undefined) {
      const started = this.clocks.get(trace.id); if (started !== undefined) trace.firstVisibleResponseMs = Math.max(0, this.now() - started);
    }
    if (event.type === 'tool') trace.toolEvents++;
    if (event.performance) {
      const info = event.performance; const key = `${trace.id}:${info.callId}`;
      const stage: PerformanceStage = ({ tool: 'tool.execute', search: 'search', read: 'file.read', command: 'command.execute', test: 'test.execute', build: 'test.execute' } as Record<string, PerformanceStage>)[info.stage] ?? 'tool.execute';
      if (info.phase === 'started' && !this.runtimeSpans.has(key)) {
        const span = this.startSpan(trace.id, { stage, operation: info.operation }); if (span) this.runtimeSpans.set(key, span);
      } else if (info.phase === 'completed') {
        const span = this.runtimeSpans.get(key);
        // 没有开始事件时不捏造持续时间；没有命令退出码时不标记成功。
        if (span) { this.endSpan(span, info.exitCode === null && ['command', 'test', 'build'].includes(info.stage) ? 'unavailable' : typeof info.exitCode === 'number' && info.exitCode !== 0 ? 'failed' : 'completed'); this.runtimeSpans.delete(key); }
      }
    }
    // 文本未提供稳定工具调用 ID，不能将 started/completed 通知数冒充工具调用数。
    if (event.type === 'error' && /retry|重试/i.test(event.text)) trace.retryCount++;
    if (event.type === 'status' && ['completed', 'failed', 'interrupted'].includes(event.text)) this.finishTrace(trace.id, event.text as PerformanceStatus);
  }
  setContextStats(traceId: string | undefined, stats: PerformanceTrace['context']): void {
    const trace = this.state.traces.find(item => item.id === traceId); if (trace) { trace.context = structuredClone(stats); this.persist(); }
  }
  finishTrace(traceId: string | undefined, status: PerformanceStatus): void {
    const trace = this.state.traces.find(item => item.id === traceId); if (!trace || trace.status !== 'running' || status === 'running') return;
    const started = this.clocks.get(trace.id);
    trace.status = status; trace.endedAt = new Date().toISOString(); if (started !== undefined) trace.totalDurationMs = Math.max(0, this.now() - started);
    for (const span of trace.spans) if (span.status === 'running') this.endSpan(span.id, status === 'completed' ? 'interrupted' : status);
    this.clocks.delete(trace.id); for (const key of this.runtimeSpans.keys()) if (key.startsWith(`${trace.id}:`)) this.runtimeSpans.delete(key); this.prune(); this.persist(true);
  }
  report(sessionId: string): PerformanceReport {
    const traces = this.state.traces.filter(item => item.sessionId === sessionId);
    const copies = structuredClone(traces);
    for (const trace of copies) if (trace.status === 'running') { const started = this.clocks.get(trace.id); if (started !== undefined) trace.totalDurationMs = Math.max(0, this.now() - started); }
    const result: PerformanceReport = { settings: this.getSettings(), traces: copies, latest: copies.at(-1),
      unavailable: ['模型首 token（仅测量首个可见响应）', '模型调用次数与内部等待时间', '输入/输出 token（当前 Runtime 未公开用量）', '原生工具排队时间与未上报关联边界的工具耗时', '未接入平台验证器的测试结果'], sampleCount: traces.filter(item => item.status === 'completed').length,
      baselineStatus: 'insufficient_samples' };
    return result;
  }
  export(sessionId: string): string { const value = JSON.stringify(this.report(sessionId), null, 2); return this.options.redact?.(cleanPerformanceText(value)) ?? cleanPerformanceText(value); }
  clear(sessionId?: string): void {
    this.state.traces = this.state.traces.filter(item => item.status === 'running' || sessionId !== undefined && item.sessionId !== sessionId); this.persist();
  }
  flush(): void { this.persist(true); }
}
