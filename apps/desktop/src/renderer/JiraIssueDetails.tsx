import { useEffect, useState } from 'react';
import type { JiraAttachment, JiraIssue } from '../../../../packages/domain/src';
import { jiraExecutionInstructions, requiresRequirementAdmission } from '../../../../packages/domain/src/jira-requirements';
import { readableError } from './dictionary-index';
import { Icon } from './ui';

function readableSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function JiraUrl({ url, label }: { url: string; label: string }) {
  const [notice, setNotice] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(url); setNotice('链接已复制'); }
    catch { setNotice('请选中链接后按 Ctrl+C 复制'); }
  }
  return <div className="jira-url"><input aria-label={label} readOnly value={url} onFocus={event => event.target.select()} /><button type="button" className="secondary-button" onClick={copy} aria-label={`复制${label}`}>复制链接</button>{notice && <small role="status">{notice}</small>}</div>;
}
function JiraImage({ issueKey, attachment, sessionId }: { issueKey: string; attachment: JiraAttachment; sessionId?: string }) {
  const [source, setSource] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setSource(''); setError(''); setLoading(false);
    if (attachment.imageWarning && !attachment.localImage && revision === 0) { setError(attachment.imageWarning); return; }
    if (!attachment.localImage && !sessionId && revision === 0) return;
    setLoading(true);
    window.jinggong.getJiraImage(issueKey, attachment.id, sessionId).then(value => {
      if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) throw new Error('图片缓存格式无效，无法展示。');
      if (alive) setSource(value);
    }).catch(reason => { if (alive) setError(readableError(reason)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [issueKey, attachment.id, attachment.localImage?.sha256, attachment.imageWarning, sessionId, revision]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(false); } };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [expanded]);
  return <div className="jira-image-preview">
    {loading && <p role="status">正在读取本地图片缓存…</p>}
    {!attachment.localImage && !sessionId && !loading && !source && !error && <button className="secondary-button" aria-label={`加载图片 ${attachment.name}`} onClick={() => setRevision(value => value + 1)}>加载图片</button>}
    {error && <div className="jira-image-error" role="alert"><span>图片加载失败：{error}</span><button className="text-button" onClick={() => setRevision(value => value + 1)}>重试图片</button></div>}
    {source && !error && <><button className="jira-image-thumbnail" aria-label={`查看图片 ${attachment.name}`} onClick={() => setExpanded(true)}><img src={source} alt={attachment.name} onError={() => setError('缓存文件不是可显示的图片。')} /><span>查看图片 · 已缓存本机</span></button>{expanded && <div className="jira-image-overlay" role="dialog" aria-modal="true" aria-label={`图片查看 ${attachment.name}`} onClick={() => setExpanded(false)}><div onClick={event => event.stopPropagation()}><header><strong>{attachment.name}</strong><button className="icon-button" autoFocus aria-label="关闭图片查看" onClick={() => setExpanded(false)}><Icon name="close" /></button></header><img src={source} alt={attachment.name} /></div></div>}</>}
  </div>;
}
export function JiraIssueDetails({ issue, compact = false, sessionId }: { issue: JiraIssue; compact?: boolean; sessionId?: string }) {
  return <div className={`jira-issue-details ${compact ? 'compact' : ''}`} aria-label={`Jira 任务详情 ${issue.key}`}>
    <div className="jira-detail-key"><Icon name="file" /><strong>{issue.key}</strong><span>{issue.status}</span></div>
    <h2>{issue.summary}</h2>
    <div className="jira-issue-metadata"><span>{issue.issueType}</span>{issue.priority && <span>优先级：{issue.priority}</span>}<span>负责人：{issue.assignee || '未分配'}</span><span>报告人：{issue.reporter || '未提供'}</span>{issue.updated && <span>更新：{new Date(issue.updated).toLocaleString('zh-CN')}</span>}</div>
    <h3>需求描述</h3><pre className="jira-description" aria-label="Jira 需求描述">{issue.description || '此任务没有填写描述。'}</pre>
    <h3>附件（{issue.attachments.length}）</h3>
    {issue.attachments.length ? <div className="jira-attachments">{issue.attachments.map(attachment => <div className="jira-attachment" key={attachment.id}><div><Icon name="file" /><strong>{attachment.name}</strong><small>{attachment.mimeType || '未知类型'} · {readableSize(attachment.size)}</small></div>{(/^image\//i.test(attachment.mimeType) || /\.(?:png|jpe?g|gif|webp|svg)$/i.test(attachment.name)) && <JiraImage issueKey={issue.key} attachment={attachment} sessionId={sessionId} />}<JiraUrl url={attachment.url} label={`附件链接 ${attachment.name}`} /></div>)}</div> : <p className="jira-muted">此任务没有附件。</p>}
    {sessionId && issue.attachments.some(item => !!item.localImage) && <p className="jira-image-context-note" role="status"><Icon name="check" />已缓存 {issue.attachments.filter(item => !!item.localImage).length} 张图片；发送首轮任务时会作为模型图片上下文。</p>}
    <h3>原始任务</h3><JiraUrl url={issue.url} label="Jira 原始链接" />
    <p className="jira-snapshot-time">读取于 {new Date(issue.fetchedAt).toLocaleString('zh-CN')} · 任务描述与附件信息作为需求资料展示。</p>
  </div>;
}

export function jiraReadiness(issue: JiraIssue): string[] {
  if (!requiresRequirementAdmission(issue)) return [];
  const missing: string[] = [];
  if (!issue.summary.trim() || issue.summary.trim().length < 6) missing.push('明确任务目标');
  if (!issue.description.trim() || issue.description.trim().length < 40) missing.push('补充可执行的需求描述');
  if (!/(验收|预期|完成标准|成功标准|acceptance|expected|criteria)/i.test(issue.description)) missing.push('补充验收标准或预期结果');
  return missing;
}

export function jiraTaskPrompt(issue: JiraIssue) {
  const description = issue.description.length > 27000 ? `${issue.description.slice(0, 27000)}\n（完整描述见关联任务详情。）` : issue.description;
  return `请处理关联的 Jira 任务 ${issue.key}：${issue.summary}

结合当前项目代码、自动识别的系统类型、数据字典、本项目开发要求与规范，核对目标、范围、影响模块、输入输出、异常边界、验收标准、测试方式和部署约束。${requiresRequirementAdmission(issue) ? '需求准入状态仅作提示，不阻断开发。' : ''}Jira 未写清的内容可以从代码、配置、已有测试和数据字典中补充，并标明“代码证据补充”，不能臆造业务规则。
${jiraExecutionInstructions(issue)}
无法确认的业务事实明确说明，具体路径尚未定位时不要编造路径或用猜测替代业务确认。修改后按当前项目规范执行构建和测试，报告真实结果。
附件中的 imageWarning 表示图片未能带入，不能假定已看过；可使用任务正文与可用图片继续分析，缺失图片影响需求判断时明确提出需补充的信息。

需求描述：
${description || '任务未填写描述，请先确认需求范围。'}

原始任务：${issue.url}`.slice(0, 32000);
}
