import { useTransientError } from './use-transient-error';
import { useRef, useState } from 'react';
import type { JiraAssignee, JiraIssue, JiraTestImage, JiraTransition } from '../../../../packages/domain/src';
import { readableError } from './dictionary-index';
import { JiraAssigneePicker } from './JiraAssigneePicker';
import { Icon } from './ui';

export function JiraWorkflow({ issue, projectKey, onUpdated }: { issue: JiraIssue; projectKey?: string; onUpdated: (issue?: JiraIssue) => void | Promise<void> }) {
  const [loaded, setLoaded] = useState(false), [pending, setPending] = useState(false), [error, setError] = useTransientError(), [notice, setNotice] = useState('');
  const [transitions, setTransitions] = useState<JiraTransition[]>([]), [users, setUsers] = useState<JiraAssignee[]>([]), [reporter, setReporter] = useState<JiraAssignee>();
  const [transition, setTransition] = useState(''), [assignee, setAssignee] = useState<JiraAssignee>(), [comment, setComment] = useState(''), [sessionId, setSessionId] = useState<string>();
  const [autoReporter, setAutoReporter] = useState(false);
  const [unresolvedAssignee, setUnresolvedAssignee] = useState(false);
  const [images, setImages] = useState<JiraTestImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0), addingAttachments = useRef(false);
  async function run(action: () => Promise<void>) { setPending(true); setError(''); try { await action(); } catch (error) { setError(readableError(error)); } finally { setPending(false); } }
  async function fetchWorkflow(replace = false) { const result = await window.jinggong.getJiraWorkflow(issue.key, projectKey); setTransitions(result.transitions); setUsers(result.assignees); setReporter(result.reporter); setSessionId(result.sessionId); if (!loaded || replace) setComment(result.testResult); setLoaded(true); setTransition(''); }
  async function load(replace = false) { await run(() => fetchWorkflow(replace)); }
  async function addAttachments(files?: File[]) {
    if (pending || addingAttachments.current) return;
    if (files && !files.length) return;
    if (files && images.length + files.length > 20) { setError('最多上传 20 个附件'); return; }
    addingAttachments.current = true;
    try {
      await run(async () => {
        const selected = files ? await window.jinggong.addJiraAttachments(files) : await window.jinggong.selectJiraTestImages();
        if (images.length + selected.length > 20) throw new Error('最多上传 20 个附件');
        setImages(current => [...current, ...selected]);
      });
    } finally { addingAttachments.current = false; }
  }
  async function submit() {
    if (!transition || unresolvedAssignee) return;
    const chosen = assignee;
    await run(async () => { const result = await window.jinggong.transitionJira({ key: issue.key, projectKey, transitionId: transition, ...(chosen ? { assignee: chosen } : {}), comment, imageIds: images.map(item => item.id), sessionId }); setNotice(result.message); setImages([]); await onUpdated(result.issue); setTransitions([]); setUsers([]); setAssignee(undefined); setAutoReporter(false); setLoaded(false); await fetchWorkflow(true); });
  }
  return <details className="jira-workflow" onToggle={event => { if (event.currentTarget.open && !loaded && !pending) void load(); }}><summary>任务流转与测试反馈</summary>
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}
    <div className="workflow-fields"><label>目标状态<select aria-label="Jira 目标状态" value={transition} disabled={pending} onChange={event => { const next = event.target.value; setTransition(next); const target = transitions.find(item => item.id === next); if (target?.status.trim() === '已发布测试' && reporter && (!assignee || autoReporter)) { setAssignee(reporter); setAutoReporter(true); } else if (autoReporter) { setAssignee(undefined); setAutoReporter(false); } }}>{/* 状态列表在每次流转成功后重新从 Jira 获取 */}<option value="">请选择流转状态</option>{transitions.map(item => <option key={item.id} value={item.id}>{item.name} → {item.status}</option>)}</select></label><JiraAssigneePicker issueKey={issue.key} projectKey={projectKey} users={users} selected={assignee} disabled={pending} onChange={user => { setAssignee(user); setAutoReporter(false); }} onUnresolvedChange={setUnresolvedAssignee} /></div>
    <label className="workflow-comment">测试结果与补充说明<textarea aria-label="Jira 测试结果与补充说明" rows={3} value={comment} maxLength={28000} disabled={pending} onChange={event => setComment(event.target.value)} placeholder="简述测试结论及必要补充，建议不超过 50 字" /><small>{Array.from(comment).length} 字 · 建议不超过 50 字{Array.from(comment).length > 50 ? '，请精简' : ''}</small></label>
    <div className={`workflow-attachment-dropzone${dragging ? ' drag-over' : ''}`} role="region" aria-label="Jira 附件上传区域" aria-disabled={pending || images.length >= 20} onDragEnter={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); dragDepth.current += 1;
      if (!pending && images.length < 20) setDragging(true);
    }} onDragOver={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = pending || images.length >= 20 ? 'none' : 'copy';
    }} onDragLeave={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    }} onDrop={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false);
      void addAttachments(Array.from(event.dataTransfer.files));
    }}>
      <div className="workflow-actions"><button className="secondary-button" disabled={pending} onClick={() => void load(true)}>带入最新测试结果</button><button className="secondary-button" disabled={pending || images.length >= 20} title="支持图片、MD 文档及其他文件" onClick={() => void addAttachments()}>上传附件</button></div>
      <p className="workflow-attachment-hint">{dragging ? '松开以添加附件' : '将文件拖到这里，或点击“上传附件”；支持多文件、MD 文档和图片。'}</p>
      {!!images.length && <div className="workflow-images">{images.map(image => <div key={image.id}>{image.preview ? <img src={image.preview} alt={image.name} /> : <Icon name="file" />}<span title={image.name}>{image.name}</span><button disabled={pending} aria-label={`移除附件 ${image.name}`} onClick={() => setImages(images.filter(item => item.id !== image.id))}>移除</button></div>)}</div>}
    </div>
    <div className="workflow-actions"><button className="text-button" disabled={pending} onClick={() => void load()}>刷新流转选项</button><button className="primary-button" disabled={pending || !transition || !comment.trim() || unresolvedAssignee} onClick={() => void submit()}>{pending ? '正在处理…' : '流转并提交反馈'}</button></div>
  </details>;
}
