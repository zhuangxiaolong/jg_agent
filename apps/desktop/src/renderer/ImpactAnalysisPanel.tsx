import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../../packages/domain/src';
import type { FindingDisposition, ImpactReviewApi, ImpactReviewDetail, ImpactReviewRecord } from '../../../../packages/impact-analysis/src/contracts';
import './impact-analysis.css';

const severityNames = { critical: '严重', high: '高', medium: '中', low: '低', info: '提示' };
const confidenceNames = { verified: '工具事实', likely: '静态推断', suggestion: '建议', unknown: '证据不足' };
const statusNames = { open: '待复核', confirmed: '已确认', ignored: '已忽略', false_positive: '误报', fixed: '已修复', stale: '已过期' };

export function ImpactAnalysisPanel({ project, sessionId, api }: { project: Project; sessionId?: string; api?: ImpactReviewApi }) {
  const [history, setHistory] = useState<ImpactReviewRecord[]>([]);
  const [selected, setSelected] = useState<ImpactReviewDetail>();
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const target = { projectId: project.id, ...(sessionId ? { sessionId } : {}) };
  const currentKey = `${project.id}:${sessionId ?? ''}`;
  const key = useRef(currentKey); key.current = currentKey;

  useEffect(() => {
    let alive = true;
    setHistory([]); setSelected(undefined); setFeedback(''); setReasons({}); setBusy('history');
    if (!api) { setBusy(''); return; }
    void api.list(target).then(items => { if (alive) setHistory(items); }).catch(error => { if (alive) setFeedback(message(error)); }).finally(() => { if (alive) setBusy(''); });
    return () => { alive = false; };
  }, [api, project.id, sessionId]);

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name); setFeedback('');
    try { await action(); } catch (error) { if (key.current === currentKey) setFeedback(message(error)); }
    finally { if (key.current === currentKey) setBusy(''); }
  }
  function accept(value: ImpactReviewDetail) {
    if (key.current !== currentKey) return;
    setSelected(value);
    setHistory(items => [value.report, ...items.filter(item => item.id !== value.report.id)]);
  }
  async function analyze() {
    if (!api) return;
    const result = await api.analyze(target);
    if (key.current !== currentKey) return;
    accept(result);
    const items = await api.list(target);
    if (key.current === currentKey) setHistory(items);
    if (key.current === currentKey) setFeedback(`已分析 ${result.report.analysis.files.length} 项变更，记录 ${result.findings.length} 条风险提示。`);
  }
  async function disposition(findingId: string, status: FindingDisposition) {
    if (!api || !selected) return;
    accept(await api.updateFinding({ projectId: project.id, reportId: selected.report.id, findingId, status, reason: reasons[findingId]?.trim() || undefined }));
  }
  if (!api) return <div className="iteration-body"><section><h4>代码影响分析尚未就绪</h4><p className="iteration-muted">请重启应用以加载桌面通信接口。</p></section></div>;
  return <div className="iteration-body impact-analysis-panel">
    <section>
      <h4>代码变更影响分析</h4>
      <p className="iteration-muted">{sessionId ? '当前会话工作区' : '当前项目仓库'} · 相对于 HEAD 的未提交变更（含新增文件）。Git 事实、静态规则推断与建议分别标记。</p>
      <button className="primary-button" disabled={!!busy} onClick={() => void run('analyze', analyze)}>{busy === 'analyze' ? '正在读取 Git 变更…' : '分析当前变更'}</button>
      <p className="iteration-muted">此入口不调用 AI 模型；建议回归尚未执行。</p>
    </section>
    {feedback && <div className="iteration-feedback" role="status">{feedback}</div>}
    <section>
      <div className="iteration-section-heading"><h4>历史报告</h4><button className="secondary-button" disabled={!!busy} onClick={() => void run('history', async () => { const items = await api.list(target); if (key.current === currentKey) { setHistory(items); if (selected) accept(await api.detail({ projectId: project.id, reportId: selected.report.id })); } })}>复核代码状态</button></div>
      {!history.length && <p className="iteration-muted">{busy === 'history' ? '读取中…' : '当前范围还没有分析报告。'}</p>}
      {history.length > 0 && <select aria-label="历史影响分析报告" disabled={!!busy} value={selected?.report.id ?? ''} onChange={event => { const reportId = event.target.value; if (reportId) void run('detail', async () => accept(await api.detail({ projectId: project.id, reportId }))); }}><option value="">选择报告</option>{history.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.status === 'stale' ? '已过期' : '已分析'} · {item.analysis.files.length} 项变更</option>)}</select>}
    </section>
    {selected && <>
      <section>
        <div className="iteration-section-heading"><h4>分析范围与证据</h4><button className="secondary-button" disabled={!!busy} onClick={() => void run('export', async () => { const result = await api.exportReport({ projectId: project.id, reportId: selected.report.id }); if (key.current === currentKey) setFeedback(result.cancelled ? '已取消导出。' : `报告已保存：${result.path}`); })}>导出报告</button></div>
        {selected.report.status === 'stale' && <p role="alert" className="impact-stale">已过期：{selected.report.staleReason}。请重新分析后处置问题。</p>}
        <small className="impact-fingerprint">HEAD：{selected.report.analysis.head}<br />Diff：{selected.report.diffFingerprint}</small>
        {selected.report.limitations.map(item => <p key={item} className="iteration-muted">{item}</p>)}
        {!selected.report.analysis.files.length && <p className="iteration-muted">此范围内没有未提交变更；不代表历史提交已经通过审查。</p>}
        {selected.report.analysis.files.map((file, index) => <div className="iteration-record" key={`${file.path}:${index}`}><strong>{file.path}</strong><span>{file.status} · +{file.additions} / −{file.deletions} · {file.changedLineStart ? `新文件行 ${file.changedLineStart}–${file.changedLineEnd}` : '无可用文本行号'}</span><small>Git 工具事实{file.binary ? ' · 二进制' : ''}{file.truncated ? ' · 正文截断' : ''}</small></div>)}
      </section>
      <section>
        <h4>风险提示与人工复核（{selected.findings.length}）</h4>
        {!selected.findings.length && <p className="iteration-muted">当前规则未产生风险提示；仍需真实测试和人工审查。</p>}
        {selected.findings.map(finding => <div key={finding.id} className="impact-finding">
          <strong>{severityNames[finding.severity]} · {finding.title}</strong>
          <small>{finding.filePath}{finding.startLine ? `:${finding.startLine}` : ''} · {confidenceNames[finding.confidence]} · {statusNames[finding.status]}</small>
          <p>{finding.description}</p><p>建议：{finding.suggestion}</p>
          <small>来源：{finding.source} · {finding.correlation === 'persisting' ? '历史疑点再次命中，需复核新正文' : '本轮新增'}</small>
          {finding.dispositionReason && <p>处置理由：{finding.dispositionReason}</p>}
          <label>处置理由（忽略/误报必填）<input aria-label={`${finding.filePath} 的处置理由`} value={reasons[finding.id] ?? ''} maxLength={2000} onChange={event => setReasons(items => ({ ...items, [finding.id]: event.target.value }))} /></label>
          <div className="iteration-export-actions"><button className="secondary-button" disabled={!!busy || selected.report.status === 'stale'} onClick={() => void run(finding.id, () => disposition(finding.id, 'confirmed'))}>确认风险</button><button className="secondary-button" disabled={!!busy || selected.report.status === 'stale' || !reasons[finding.id]?.trim()} onClick={() => void run(finding.id, () => disposition(finding.id, 'ignored'))}>忽略</button><button className="secondary-button" disabled={!!busy || selected.report.status === 'stale' || !reasons[finding.id]?.trim()} onClick={() => void run(finding.id, () => disposition(finding.id, 'false_positive'))}>标记误报</button></div>
        </div>)}
      </section>
      <section><h4>建议回归（尚未执行）</h4>{selected.report.analysis.recommendedCommands.map(item => <div key={item.command} className="iteration-record"><strong>{item.command}</strong><span>{item.reason}</span></div>)}</section>
    </>}
  </div>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
