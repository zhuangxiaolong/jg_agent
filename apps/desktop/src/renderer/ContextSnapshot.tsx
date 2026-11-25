import type { ReactNode } from 'react';
import type { Session } from '../../../../packages/domain/src';
import type { ContextBuildStats, ContextExcludedSummary, ContextSourceSummary, ContextSourceType, PerformanceReport, PerformanceTrace } from '../../../../packages/performance/src/types';
import { contextSourceNames } from './context-source-names';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children ?? '不可用'}</dd></div>;
}

function SourceList({ items }: { items: (ContextSourceSummary | ContextExcludedSummary)[] }) {
  return <ul className="ci-sources">{items.map((item, index) => <li key={`${item.sourceId}:${index}`}>
    <strong>{item.title}</strong><small>{contextSourceNames[item.sourceType]}{'scope' in item && ` · ${item.scope} · ${item.estimatedTokens} Token（估算）`}</small>
    <p>{item.reason}</p>
    <details><summary>来源标识</summary><dl className="ci-fields">
      <Field label="来源 ID">{item.sourceId}</Field>
      {'contentHash' in item && <Field label="内容 Hash">{item.contentHash}</Field>}
      {'version' in item && item.version && <Field label="版本">{item.version}</Field>}
      {'pluginHash' in item && item.pluginHash && <Field label="插件 Hash">{item.pluginHash}</Field>}
      {'path' in item && item.path && <Field label="文件">{item.path}{item.startLine !== undefined && ` · 第 ${item.startLine}${item.endLine !== undefined ? '–' + item.endLine : ''} 行`}</Field>}
    </dl></details>
  </li>)}</ul>;
}

function Budget({ stats }: { stats: ContextBuildStats }) {
  const ms = (value?: number) => value === undefined ? '不可用' : `${Number(value.toFixed(1))} ms`;
  const overflowTokens = Math.max(0, stats.estimatedTokens - stats.budgetTokens);
  return <section className="ci-card"><h3>应用侧组装预算</h3>
    <dl className="ci-metrics">
      <Field label="合计 Token（估算）">{stats.estimatedTokens}</Field>
      <Field label="必需 Token（估算）">{stats.requiredEstimatedTokens}</Field>
      <Field label="可选 Token（估算）">{stats.optionalEstimatedTokens}</Field>
      <Field label="配置预算（Token）">{stats.budgetTokens}</Field>
      <Field label="超出预算（估算）">{overflowTokens}</Field>
      <Field label="去重">{stats.deduplicatedCount}</Field><Field label="裁剪">{stats.trimmedCount}</Field>
      <Field label="排除来源">{stats.excluded?.length ?? 0}</Field>
      <Field label="缓存">{stats.cacheStatus && ({ hit: '命中', miss: '未命中', disabled: '已关闭' } as const)[stats.cacheStatus]}</Field>
      <Field label="检索">{ms(stats.retrievalDurationMs)}</Field><Field label="组装">{ms(stats.buildDurationMs)}</Field>
      <Field label="缓存查找">{ms(stats.cacheLookupDurationMs)}</Field>
    </dl>
    {stats.requiredOverBudget && <p className="ci-warning">必需上下文已超预算，已完整保留。</p>}
  </section>;
}

function Sources({ stats }: { stats: ContextBuildStats }) {
  const counts = Object.entries(stats.sourceCounts ?? {});
  const selected = stats.selected ?? [], excluded = stats.excluded ?? [];
  return <section className="ci-card"><h3>本轮实际来源</h3>
    {counts.length > 0 && <dl className="ci-metrics">{counts.map(([type, count]) => <Field key={type} label={contextSourceNames[type as ContextSourceType]}>{count}</Field>)}</dl>}
    <h4>已选入应用上下文</h4>
    {selected.length ? <SourceList items={selected} /> : <p>{stats.sourceCount === 0
      ? `本轮没有选入可选来源；必需上下文 ${stats.requiredEstimatedTokens ?? 0} Token（估算）。`
      : '本轮已选入来源，Trace 未提供选中明细。'}</p>}
    <details><summary>未选 / 排除{excluded.length > 0 && ` · 已记录 ${excluded.length} 条`}</summary>
      {excluded.length ? <SourceList items={excluded} /> : <p>本轮没有排除明细。</p>}
    </details>
  </section>;
}

interface ReportedUsage {
  source: 'runtime_reported' | 'provider_reported';
  reportedAt: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

type SnapshotReport = PerformanceReport & { latest?: PerformanceTrace & { tokenUsage?: ReportedUsage } };

function ActualUsage({ usage }: { usage?: ReportedUsage }) {
  const labels = { inputTokens: '输入', outputTokens: '输出', cacheReadInputTokens: '缓存读取', cacheWriteInputTokens: '缓存写入', totalTokens: '合计' } as const;
  const valid = usage && ['runtime_reported', 'provider_reported'].includes(usage.source) && Number.isFinite(Date.parse(usage.reportedAt));
  const metrics = valid ? (Object.keys(labels) as (keyof typeof labels)[]).filter(key => {
    const value = usage[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }) : [];
  return <section className="ci-card"><h3>模型实际用量</h3>
    {usage && metrics.length ? <><p>{usage.source === 'runtime_reported' ? 'Runtime 报告' : 'Provider 报告'} · Token</p>
      <dl className="ci-metrics">{metrics.map(key => <Field key={key} label={labels[key]}>{usage[key]}</Field>)}</dl></>
      : <p>当前 Runtime 未提供实际 Token 用量。</p>}
  </section>;
}

export function ContextSnapshot({ report, session, running }: { report: SnapshotReport; session: Session; running: boolean }) {
  const { settings, latest } = report;
  const workspace = session.workspaceId ?? session.projectId ?? session.id;
  if (!settings.enabled || !settings.telemetryEnabled || settings.runtimeOverrides[session.runtimeKind ?? 'codex'] === false || settings.workspaceOverrides[workspace] === false)
    return <p className="ci-card" role="status">本轮遥测未采集。</p>;
  if (!settings.contextOptimizationEnabled) return <p className="ci-card" role="status">上下文优化已关闭，本轮按 Runtime 原始上下文路径执行。</p>;
  if (!latest || latest.sessionId !== session.id || (latest.workspaceId && latest.workspaceId !== workspace)
    || (running && (latest.status !== 'running' || latest.runtimeKind !== (session.runtimeKind ?? 'codex'))))
    return <p className="ci-card" role="status">{running ? '等待本轮上下文快照。' : '发送任务后显示本轮上下文快照。'}</p>;
  const unavailable = latest.spans.some(span => span.stage.startsWith('context.') && span.status === 'unavailable');
  return <div className="ci-snapshot" key={latest.id}>
    <section className="ci-card"><h3>{latest.status === 'running' ? '正在采集的轮次' : '最近采集的轮次'}</h3>
      <p><time dateTime={latest.startedAt}>{new Date(latest.startedAt).toLocaleString()}</time> · {latest.runtimeKind}{latest.modelId && ` · ${latest.modelId}`}</p>
      <small>Trace ID · {latest.id}</small>
    </section>
    {latest.context ? <><Budget stats={latest.context} /><Sources stats={latest.context} /></>
      : <p className="ci-card">{unavailable ? '本轮上下文检索或组装不可用。' : latest.status === 'running' ? '正在等待上下文组装数据。' : '此轮未记录上下文组装数据。'}</p>}
    {!!latest.loadedSkills?.length && <section className="ci-card"><h3>本轮已加载的 Skill</h3><SourceList items={latest.loadedSkills} /></section>}
    <ActualUsage usage={latest.tokenUsage} />
  </div>;
}
