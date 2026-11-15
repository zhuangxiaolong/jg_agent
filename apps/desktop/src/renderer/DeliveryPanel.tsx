import { useEffect, useRef, useState } from 'react';
import type { DeliveryPackageRecord, JiraWritebackRecord, Project, Session } from '../../../../packages/domain/src';
import type { DeliveryPreview, DeliveryWritebackPreview } from '../../../../packages/domain/src/delivery';

export function DeliveryPanel({ project, session }: { project?: Project; session?: Session }) {
  const api = window.jinggong.delivery;
  const [taskId, setTaskId] = useState('');
  const [jiraKey, setJiraKey] = useState(session?.jiraIssue?.key ?? '');
  const [notes, setNotes] = useState('');
  const [remaining, setRemaining] = useState('');
  const [preview, setPreview] = useState<DeliveryPreview | null>(null);
  const [packages, setPackages] = useState<DeliveryPackageRecord[]>([]);
  const [comment, setComment] = useState('');
  const [writeback, setWriteback] = useState<DeliveryWritebackPreview | null>(null);
  const [writebacks, setWritebacks] = useState<JiraWritebackRecord[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setTaskId(''); setJiraKey(session?.jiraIssue?.key ?? ''); setNotes(''); setRemaining(''); setPreview(null); setPackages([]); setComment(''); setWriteback(null); setWritebacks([]); setConfirmed(false); setFeedback(''); setBusy('');
    if (project && api) void api.listPackages({ projectId: project.id }).then(value => { if (current === generation.current) setPackages(value); }).catch(error => { if (current === generation.current) setFeedback(errorText(error)); });
    return () => { generation.current++; };
  }, [project?.id, session?.id, api]);

  if (!project) return <div className="inspector-empty">请先选择本地项目，再整理交付证据。</div>;
  if (!api) return <div className="inspector-empty">交付服务尚未加载，请重新启动应用。</div>;
  const activeProject = project;
  const activeApi = api;
  const run = async (key: string, action: (current: () => boolean) => Promise<void>) => {
    const stamp = generation.current; setBusy(key); setFeedback('');
    try { await action(() => stamp === generation.current); }
    catch (error) { if (stamp === generation.current) setFeedback(errorText(error)); }
    finally { if (stamp === generation.current) setBusy(''); }
  };
  const invalidate = () => { setPreview(null); setWriteback(null); setConfirmed(false); };
  async function generate(current: () => boolean) {
    const result = await activeApi.preview({ projectId: activeProject.id, ...(session?.projectId === activeProject.id ? { sessionId: session.id } : {}), ...(taskId.trim() ? { taskId: taskId.trim() } : {}), ...(jiraKey.trim() ? { jiraKey: jiraKey.trim().toUpperCase() } : {}), implementationNotes: notes, remainingItems: remaining });
    if (!current()) return;
    setPreview(result); setComment(result.markdown.slice(0, 30000)); setWriteback(null); setConfirmed(false);
    setFeedback(`交付预览已采集，修订 ${result.revision}。缺失的验证或测试计数保持未知。`);
  }
  async function createWriteback(operation: 'comment' | 'attachment', current: () => boolean) {
    if (!preview) return;
    const latest = packages.find(item => item.status === 'success' && item.taskId === preview.snapshot.taskId && item.jiraKey === preview.snapshot.jira?.key);
    const result = await activeApi.previewWriteback({ previewId: preview.id, operation, ...(operation === 'comment' ? { comment } : { packageId: latest?.id }) });
    if (!current()) return;
    setWriteback(result); setConfirmed(false); setFeedback('已生成独立回写预览。请核对目标任务和内容，并勾选本次操作确认。');
  }
  return <div className="iteration-body" aria-label="任务交付档案">
    {feedback && <div className="iteration-feedback" role="status">{feedback}</div>}
    <section><h4>任务交付档案</h4><p className="iteration-muted">项目：{activeProject.name} · 会话：{session?.title ?? '项目级交付'}。平台采集真实计划、Git 和验证记录；填写的说明会标记为用户补充。</p>
      <label>关联 Jira Key（可选）<input value={jiraKey} maxLength={85} placeholder="MES6-123" onChange={event => { setJiraKey(event.target.value); invalidate(); }} /></label>
      <label>Agent Task ID（可选，留空使用当前会话）<input value={taskId} maxLength={160} onChange={event => { setTaskId(event.target.value); invalidate(); }} /></label>
      <label>实现内容补充<textarea rows={3} maxLength={12000} value={notes} onChange={event => { setNotes(event.target.value); invalidate(); }} /></label>
      <label>遗留问题、风险和待确认事项<textarea rows={3} maxLength={12000} value={remaining} onChange={event => { setRemaining(event.target.value); invalidate(); }} /></label>
      <button className="primary-button" disabled={!!busy} onClick={() => void run('preview', generate)}>{busy === 'preview' ? '采集证据中…' : '采集证据并预览交付包'}</button>
    </section>
    {preview && <section><h4>交付预览 · 修订 {preview.revision}</h4><p className="iteration-muted">证据采集于 {preview.snapshot.capturedAt}。默认排除客户源文件、完整代码、原始日志和环境配置。</p><pre className="iteration-context-preview">{preview.markdown}</pre>
      <button className="primary-button" disabled={!!busy} onClick={() => void run('export', async current => { const result = await activeApi.exportPackage(preview.id); if (!current()) return; if (result) { const history = await activeApi.listPackages({ projectId: activeProject.id }); if (current()) { setPackages(history); setFeedback(`交付 ZIP 已生成（修订 ${result.revision}）：${result.outputPath}`); } } else setFeedback('已取消保存。'); })}>{busy === 'export' ? '生成中…' : '生成 ZIP 交付包'}</button>
    </section>}
    {preview?.snapshot.jira && <section><h4>Jira 回写预览</h4><p className="iteration-muted">目标：{preview.snapshot.jira.key} · {preview.snapshot.jira.summary}。评论与附件分别确认；不会自动改变 Jira 状态。</p>
      <label>评论内容（可编辑，最多 30000 字）<textarea rows={6} maxLength={30000} value={comment} onChange={event => { setComment(event.target.value); setWriteback(null); setConfirmed(false); }} /></label>
      <div className="iteration-export-actions"><button className="secondary-button" disabled={!!busy || !comment.trim()} onClick={() => void run('jira-preview', current => createWriteback('comment', current))}>预览新增评论</button><button className="secondary-button" disabled={!!busy || !packages.some(item => item.status === 'success' && item.taskId === preview.snapshot.taskId && item.jiraKey === preview.snapshot.jira?.key)} onClick={() => void run('jira-attachment', current => createWriteback('attachment', current))}>预览上传本地交付 ZIP</button></div>
      {writeback && <div className="iteration-record"><strong>{writeback.record.operation === 'comment' ? '新增评论' : '上传 ZIP 附件'} → {writeback.issue.key}</strong><span>{writeback.issue.summary} · 当前状态 {writeback.issue.status}</span><small>执行账号：{String(writeback.record.preview.actor ?? '未知')} · 有效至 {writeback.expiresAt}</small><pre className="iteration-context-preview">{writeback.record.operation === 'comment' ? String(writeback.record.preview.comment ?? '') : `文件：${String(writeback.record.preview.fileName ?? '')}\nSHA256：${String(writeback.record.preview.packageSha256 ?? '')}`}</pre>
        <label><span><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> 我已核对，确认仅执行上述这一次 Jira 操作</span></label>
        <div className="iteration-export-actions"><button className="primary-button" disabled={!!busy || !confirmed} onClick={() => void run('jira-confirm', async current => { const result = await activeApi.confirmWriteback({ recordId: writeback.record.id, requestHash: writeback.record.requestHash, confirmed: true }); if (!current()) return; setWriteback(null); setConfirmed(false); setFeedback(result.resultStatus === 'success' ? `Jira 回写成功，回执 ID：${result.responseId}` : `Jira 回写失败：${result.errorMessage}`); const history = await activeApi.listWritebacks(result.jiraKey); if (current()) setWritebacks(history); })}>{busy === 'jira-confirm' ? '写入中…' : '确认并写回 Jira'}</button><button className="secondary-button" disabled={!!busy} onClick={() => void run('jira-cancel', async current => { await activeApi.cancelWriteback(writeback.record.id); if (current()) { setWriteback(null); setConfirmed(false); setFeedback('本次 Jira 回写已取消。'); } })}>取消回写</button></div>
      </div>}
    </section>}
    <section><div className="iteration-section-heading"><h4>本地交付包历史（{packages.length}）</h4><button className="secondary-button" disabled={!!busy} onClick={() => void run('history', async current => { const result = await activeApi.listPackages({ projectId: activeProject.id }); if (current()) setPackages(result); })}>刷新</button></div>{packages.length ? packages.map(item => <div key={item.id} className="iteration-record"><strong>修订 {item.revision} · {item.status} · {item.jiraKey ?? '未关联 Jira'}</strong><span>{item.outputPath}</span><small>{item.createdAt} · SHA256 {item.outputSha256}</small></div>) : <p className="iteration-muted">尚无交付包。每次生成保留独立版本，不覆盖旧文件。</p>}</section>
    {(writebacks.length > 0 || jiraKey.trim()) && <section><div className="iteration-section-heading"><h4>Jira 回写记录</h4><button className="secondary-button" disabled={!!busy || !jiraKey.trim()} onClick={() => void run('jira-history', async current => { const result = await activeApi.listWritebacks(jiraKey.trim().toUpperCase()); if (current()) setWritebacks(result); })}>读取记录</button></div>{writebacks.map(item => <div key={item.id} className="iteration-record"><strong>{item.jiraKey} · {item.operation} · {item.resultStatus}</strong><span>{item.responseId ? `回执 ${item.responseId}` : item.errorMessage ?? '等待确认 / 已取消'}</span><small>{item.createdAt}</small></div>)}</section>}
  </div>;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
