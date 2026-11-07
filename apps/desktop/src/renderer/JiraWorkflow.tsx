import { useState } from 'react';
import type { JiraAssignee, JiraIssue, JiraTestImage, JiraTransition } from '../../../../packages/domain/src';
import { readableError } from './dictionary-index';
import { JiraAssigneePicker } from './JiraAssigneePicker';

export function JiraWorkflow({ issue, projectKey, onUpdated }: { issue: JiraIssue; projectKey?: string; onUpdated: (issue: JiraIssue) => void }) {
  const [loaded, setLoaded] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [transitions, setTransitions] = useState<JiraTransition[]>([]), [users, setUsers] = useState<JiraAssignee[]>([]);
  const [transition, setTransition] = useState(''), [assignee, setAssignee] = useState<JiraAssignee>(), [comment, setComment] = useState(''), [sessionId, setSessionId] = useState<string>();
  const [unresolvedAssignee, setUnresolvedAssignee] = useState(false);
  const [images, setImages] = useState<JiraTestImage[]>([]);
  async function run(action: () => Promise<void>) { setPending(true); setError(''); try { await action(); } catch (error) { setError(readableError(error)); } finally { setPending(false); } }
  async function load(replace = false) { await run(async () => { const result = await window.jinggong.getJiraWorkflow(issue.key, projectKey); setTransitions(result.transitions); setUsers(result.assignees); setSessionId(result.sessionId); if (!loaded || replace) setComment(result.testResult); setLoaded(true); setTransition(''); }); }
  async function submit() {
    if (!transition || unresolvedAssignee) return;
    const chosen = assignee, target = transitions.find(item => item.id === transition);
    if (!window.confirm(`确认将 ${issue.key} 流转至“${target?.status}”？${chosen ? '\n经办人：' + chosen.displayName : ''}\n将提交下方测试结果和 ${images.length} 张测试图片。`)) return;
    await run(async () => { const result = await window.jinggong.transitionJira({ key: issue.key, projectKey, transitionId: transition, ...(chosen ? { assignee: chosen } : {}), comment, imageIds: images.map(item => item.id), sessionId }); setNotice(result.message); setImages([]); setTransition(''); if (result.issue) onUpdated(result.issue); setLoaded(false); });
  }
  return <details className="jira-workflow" onToggle={event => { if (event.currentTarget.open && !loaded && !pending) void load(); }}><summary>任务流转与测试反馈</summary>
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}
    <div className="workflow-fields"><label>目标状态<select aria-label="Jira 目标状态" value={transition} disabled={pending} onChange={event => setTransition(event.target.value)}><option value="">请选择流转状态</option>{transitions.map(item => <option key={item.id} value={item.id}>{item.name} → {item.status}</option>)}</select></label><JiraAssigneePicker issueKey={issue.key} projectKey={projectKey} users={users} selected={assignee} disabled={pending} onChange={setAssignee} onUnresolvedChange={setUnresolvedAssignee} /></div>
    <label className="workflow-comment">测试结果与补充说明<textarea aria-label="Jira 测试结果与补充说明" rows={7} value={comment} maxLength={28000} disabled={pending} onChange={event => setComment(event.target.value)} placeholder="自动带入关联会话结果，也可手动填写实际测试情况" /></label>
    <div className="workflow-actions"><button className="secondary-button" disabled={pending} onClick={() => void load(true)}>带入最新测试结果</button><button className="secondary-button" disabled={pending || images.length >= 20} onClick={() => void run(async () => { const selected = await window.jinggong.selectJiraTestImages(); if (images.length + selected.length > 20) throw new Error('最多上传 20 张测试图片'); setImages([...images, ...selected]); })}>上传测试图片</button></div>
    {!!images.length && <div className="workflow-images">{images.map(image => <div key={image.id}><img src={image.preview} alt={image.name} /><span>{image.name}</span><button disabled={pending} aria-label={`移除测试图片 ${image.name}`} onClick={() => setImages(images.filter(item => item.id !== image.id))}>移除</button></div>)}</div>}
    <div className="workflow-actions"><button className="text-button" disabled={pending} onClick={() => void load()}>刷新流转选项</button><button className="primary-button" disabled={pending || !transition || !comment.trim() || unresolvedAssignee} onClick={() => void submit()}>{pending ? '正在处理…' : '确认流转并提交反馈'}</button></div>
  </details>;
}
