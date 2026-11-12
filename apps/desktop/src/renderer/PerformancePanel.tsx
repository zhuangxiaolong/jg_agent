import { useEffect, useState } from 'react';
import type { DesktopApi, Session } from '../../../../packages/domain/src';
import type { PerformanceReport, PerformanceSettings, PerformanceStage } from '../../../../packages/performance/src/types';
import type { TestPlan } from '../../../../packages/performance/src/test-policy';
import { useTransientError } from './use-transient-error';
import './performance.css';

const stageNames: Record<PerformanceStage, string> = {
  'runtime.initialize': '引擎初始化', 'workspace.index_check': '索引检查', 'workspace.index_update': '增量索引',
  search: '代码搜索', 'file.read': '文件读取', 'context.retrieve': '片段检索', 'context.build': '上下文组装',
  'model.queue': '模型排队', 'model.first_token': '首个响应', 'model.response': '模型响应',
  'tool.queue': '工具排队', 'tool.execute': '工具执行', 'command.execute': '命令执行', 'test.execute': '构建 / 测试', retry: '重试', 'task.finalize': '收尾',
};
const statusNames: Record<string, string> = { running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', unavailable: '不可用' };
const duration = (ms?: number) => ms === undefined ? '不可用' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} 秒`;

export function PerformancePanel({ api, session }: { api: DesktopApi; session?: Session }) {
  const [report, setReport] = useState<PerformanceReport>();
  const [index, setIndex] = useState<{ status: string; fileCount: number; updatedAt?: string; error?: string }>();
  const [error, setError] = useTransientError();
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<TestPlan>();
  useEffect(() => {
    let active = true;
    setReport(undefined); setIndex(undefined); setPlan(undefined);
    if (!session || !api.performance) return;
    const service = api.performance, id = session.id;
    const refresh = async () => {
      try {
        const [next, state] = await Promise.all([service.report(id), service.indexStatus(id)]);
        if (active) { setReport(next); setIndex(state); }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    void refresh(); const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, session?.id]);
  async function change(patch: Partial<PerformanceSettings>) {
    if (!api.performance) return;
    setBusy(true);
    try { const settings = await api.performance.settings(patch); setReport(current => current ? { ...current, settings } : current); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true); try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  if (!session) return <div className="inspector-empty">选择会话后查看执行监控。</div>;
  if (!api.performance) return <div className="inspector-empty">当前构建未提供执行监控。</div>;
  const trace = report?.latest;
  return <section className="performance-panel" aria-label="会话执行监控">
    <header><strong>执行监控</strong><small>仅显示公开事件实测数据</small></header>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {report && <details className="performance-settings"><summary>性能策略</summary>
      {([['enabled', '性能优化总开关'], ['telemetryEnabled', '耗时监控'], ['workspaceIndexEnabled', '工作区增量索引'], ['contextOptimizationEnabled', '上下文去重与预算'], ['safeParallelEnabled', '安全只读并行']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={report.settings[key]} disabled={busy} onChange={event => void change({ [key]: event.target.checked })} />{label}</label>)}
      <label>当前引擎启用<input type="checkbox" checked={report.settings.runtimeOverrides[session.runtimeKind ?? 'codex'] !== false} disabled={busy} onChange={event => void change({ runtimeOverrides: { ...report.settings.runtimeOverrides, [session.runtimeKind ?? 'codex']: event.target.checked } })} /></label>
      <label>当前工作区启用<input type="checkbox" checked={report.settings.workspaceOverrides[session.workspaceId ?? session.projectId ?? session.id] !== false} disabled={busy} onChange={event => void change({ workspaceOverrides: { ...report.settings.workspaceOverrides, [session.workspaceId ?? session.projectId ?? session.id]: event.target.checked } })} /></label>
      <label>只读并行上限<select value={report.settings.maxParallelReadOperations} disabled={busy} onChange={event => void change({ maxParallelReadOperations: Number(event.target.value) })}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
      <label>上下文预算（必需规范不裁剪）<input type="number" min={256} max={1000000} defaultValue={report.settings.contextBudgetTokens} key={report.settings.contextBudgetTokens} disabled={busy} onBlur={event => { const value = Number(event.target.value); if (value !== report.settings.contextBudgetTokens) void change({ contextBudgetTokens: value }); }} /></label>
      <label>日志保留天数<input type="number" min={1} max={365} defaultValue={report.settings.retainDays} key={`retain-${report.settings.retainDays}`} disabled={busy} onBlur={event => { const value = Number(event.target.value); if (value !== report.settings.retainDays) void change({ retainDays: value }); }} /></label>
      <button className="text-button" disabled={busy} onClick={() => void run(async () => { const settings = await api.performance!.reset(); setReport(current => current ? { ...current, settings } : current); })}>恢复默认策略</button><small>策略在下一轮生效；关闭后沿用原执行路径。</small>
    </details>}
    <div className="performance-index"><b>工作区索引</b><span>{index?.status ?? '检查中'} · {index?.fileCount ?? 0} 个文件</span>{index?.error && <small>{index.error}</small>}<button className="text-button" disabled={busy || !session.projectId} onClick={() => void run(() => api.performance!.rebuildIndex(session.id))}>重建索引</button></div>
    {!trace ? <p>尚无本会话的执行记录。发送任务后开始采集。</p> : <>
      <dl><dt>本轮状态</dt><dd>{statusNames[trace.status]}</dd><dt>总耗时</dt><dd>{duration(trace.totalDurationMs)}</dd><dt>Runtime</dt><dd>{trace.runtimeKind}</dd><dt>Provider</dt><dd>{trace.providerId ?? '不可用'}</dd><dt>模型 ID</dt><dd>{trace.modelId ?? '不可用'}</dd><dt>端点标识</dt><dd>{trace.endpoint ?? '不可用'}</dd><dt>首个可见响应</dt><dd>{duration(trace.firstVisibleResponseMs)}</dd><dt>工具事件通知</dt><dd>{trace.toolEvents} 条（不等同于调用数）</dd><dt>重试错误通知</dt><dd>{trace.retryCount}</dd></dl>
      {trace.context && <p>上下文：{trace.context.fragmentCount} 个片段 · 约 {trace.context.estimatedTokens} Token（估算） · 去重 {trace.context.deduplicatedCount} · 裁剪 {trace.context.trimmedCount} · 缓存命中 {trace.context.cacheHits}</p>}
      <details open><summary>执行阶段时间线</summary><ol className="performance-timeline">{trace.spans.map(span => <li key={span.id}><strong>{stageNames[span.stage] ?? span.stage}</strong><span>{statusNames[span.status]} · {duration(span.durationMs)}</span><small>{span.operation}</small></li>)}</ol></details>
    </>}
    <details><summary>当前不可采集的指标</summary><ul>{report?.unavailable.map(item => <li key={item}>{item}</li>)}</ul></details>
    <p>性能基线：样本不足。需同任务、代码版本、模型与环境的重复对照后评估提速。</p>
    <details><summary>分级测试建议与真实证据</summary><p>仅采用当前项目验证器已登记的命令；建议均为“未执行”，须确认后运行。</p>
      <button className="text-button" disabled={busy || !session.projectId} onClick={() => void run(async () => setPlan(await api.performance!.testPlan(session.id)))}>按变更推荐测试</button>
      <button className="text-button" disabled={busy || !session.projectId} onClick={() => void run(async () => setPlan(await api.performance!.testPlan(session.id, true)))}>要求全量测试计划</button>
      {plan?.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
      {plan?.entries.map(entry => <div className="performance-test" key={entry.command.id}><strong>{entry.command.name} · {entry.command.level}</strong><p>{entry.reason} · 未执行</p><code>{[entry.command.executable, ...entry.command.args].join(' ')}</code>{entry.selected && <button className="secondary-button" disabled={busy || session.status === 'running'} onClick={() => void run(async () => { await api.startVerification(session.id, entry.command.id as 'typecheck' | 'tests'); })}>确认并运行{entry.command.name}</button>}</div>)}
      <button className="text-button" disabled={busy || !session.projectId} onClick={() => void run(async () => { const history = await api.listVerificationRuns(session.id); await api.copyText(history.length ? JSON.stringify(history, null, 2) : '未执行：当前会话没有平台采集的验证记录。'); })}>复制平台验证记录</button>
    </details>
    <div className="performance-actions"><button className="secondary-button" disabled={busy || !trace} onClick={() => void run(async () => api.copyText(await api.performance!.export(session.id)))}>复制脱敏诊断</button><button className="text-button" disabled={busy || trace?.status === 'running'} onClick={() => void run(() => api.performance!.clear(session.id))}>清理历史记录</button></div>
  </section>;
}
