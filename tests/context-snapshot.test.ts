import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import type { Session } from '../packages/domain/src';
import { defaultPerformanceSettings } from '../packages/performance/src/telemetry';
import type { ContextBuildStats, PerformanceReport, PerformanceTrace } from '../packages/performance/src/types';
import { ContextSnapshot } from '../apps/desktop/src/renderer/ContextSnapshot';

const session: Session = {
  id: 'session-a', projectId: 'project-a', workspacePath: 'C:/workspace/a', title: '任务',
  status: 'idle', createdAt: '2026-11-25T00:00:00.000Z', model: 'model-a', runtimeKind: 'codex',
};

function report(overrides: Partial<PerformanceReport> = {}): PerformanceReport {
  return {
    settings: defaultPerformanceSettings(), traces: [], unavailable: [], sampleCount: 0,
    baselineStatus: 'insufficient_samples', summaries: [], ...overrides,
  };
}

function trace(context?: ContextBuildStats): PerformanceTrace {
  return {
    id: 'trace-current', sessionId: session.id, taskId: 'task-current', runtimeKind: 'codex',
    status: 'failed', startedAt: '2026-11-25T00:00:00.000Z', toolEvents: 0, retryCount: 0, spans: [],
    ...(context ? { context } : {}),
  };
}

test('当前快照显示估算预算、真实来源元数据和实际用量不可用状态', () => {
  const stats: ContextBuildStats = {
    sourceCount: 1, fragmentCount: 0, deduplicatedCount: 1, trimmedCount: 1, cacheHits: 0,
    estimatedTokens: 240, requiredEstimatedTokens: 80, optionalEstimatedTokens: 160, budgetTokens: 400,
    tokenMeasurement: 'estimated', requiredOverBudget: false, cacheStatus: 'miss', retrievalDurationMs: 3,
    buildDurationMs: 7, cacheLookupDurationMs: 1, sourceCounts: { project_fact: 1 },
    selected: [{
      sourceType: 'project_fact', sourceId: 'fact-1', title: '项目规则', scope: 'project',
      contentHash: 'sha256-fact', reason: '当前任务相关', estimatedTokens: 160, path: 'docs/rule.md', startLine: 4, endLine: 8,
    }],
    excluded: [{ sourceType: 'memory', sourceId: 'memory-2', title: '旧记忆', reason: '与已选来源重复' }],
  };
  const markup = renderToStaticMarkup(createElement(ContextSnapshot, {
    report: report({ latest: trace(stats), traces: [trace(stats)] }), session, running: false,
  }));

  assert.match(markup, /应用侧组装预算/);
  assert.match(markup, /必需 Token（估算）/);
  assert.match(markup, /160 Token（估算）/);
  assert.match(markup, /当前 Runtime 未提供实际 Token 用量/);
  assert.match(markup, /项目规则/);
  assert.match(markup, /sha256-fact/);
  assert.match(markup, /docs\/rule\.md · 第 4–8 行/);
  assert.match(markup, /旧记忆/);
  assert.match(markup, /与已选来源重复/);
  assert.doesNotMatch(markup, /模型上下文窗口/);
});

test('当前轮无快照、遥测关闭及不同 Session 的历史 Trace 均不展示旧轮数据', () => {
  const oldTrace = { ...trace(), id: 'trace-old', sessionId: 'session-old' };
  const markup = renderToStaticMarkup(createElement(ContextSnapshot, {
    report: report({ traces: [oldTrace], latest: oldTrace }), session, running: false,
  }));
  assert.match(markup, /发送任务后显示本轮上下文快照/);
  assert.doesNotMatch(markup, /trace-old/);

  const disabled = defaultPerformanceSettings();
  disabled.telemetryEnabled = false;
  const disabledMarkup = renderToStaticMarkup(createElement(ContextSnapshot, {
    report: report({ settings: disabled, latest: trace() }), session, running: false,
  }));
  assert.match(disabledMarkup, /本轮遥测未采集/);
  assert.doesNotMatch(disabledMarkup, /trace-current/);
});

test('同会话开启下一轮或切换工作区后隐藏已结束的旧 Trace', () => {
  const latest = trace();
  const render = (running: boolean) => renderToStaticMarkup(createElement(ContextSnapshot, { session, running, report: report({ latest }) }));
  assert.match(render(true), /等待本轮上下文快照/);
  assert.doesNotMatch(render(true), /trace-current/);
  latest.workspaceId = 'previous-workspace';
  assert.doesNotMatch(render(false), /trace-current/);
});

test('Provider 仅报告输入 Token 时只展示输入，非法来源和数值不能作为实际用量', () => {
  const tokenUsage = { source: 'provider_reported' as const, reportedAt: session.createdAt, inputTokens: 0, outputTokens: -2 };
  const latest = { ...trace(), tokenUsage };
  const markup = renderToStaticMarkup(createElement(ContextSnapshot, { session, running: false, report: { ...report(), latest } }));
  assert.match(markup, /Provider 报告/);
  assert.match(markup, /输入<\/dt><dd>0<\/dd>/);
  assert.doesNotMatch(markup, /输出|合计/);
  tokenUsage.reportedAt = '';
  assert.match(renderToStaticMarkup(createElement(ContextSnapshot, { session, running: false, report: { ...report(), latest } })), /未提供实际 Token 用量/);
});
