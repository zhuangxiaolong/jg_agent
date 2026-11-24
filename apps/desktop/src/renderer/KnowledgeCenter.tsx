import { useEffect, useMemo, useState } from 'react';
import type { DesktopApi, KnowledgeSearchHit, KnowledgeSource, Project, ProductSystem, ProjectKnowledgeItem } from '../../../../packages/domain/src';
import { Icon } from './ui';
import './knowledge-center.css';

export function KnowledgeCenter({ api, projects, currentProjectId }: { api: DesktopApi; projects: Project[]; currentProjectId?: string }) {
  const knowledge = api.knowledge;
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [query, setQuery] = useState('');
  const [system, setSystem] = useState<ProductSystem | ''>('');
  const [projectId, setProjectId] = useState(currentProjectId ?? '');
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [semanticConfigured, setSemanticConfigured] = useState(false);
  const [projectKnowledge, setProjectKnowledge] = useState<ProjectKnowledgeItem[]>([]);
  const [knowledgeTitle, setKnowledgeTitle] = useState('');
  const [knowledgeContent, setKnowledgeContent] = useState('');

  useEffect(() => { setProjectId(currentProjectId ?? ''); }, [currentProjectId]);
  useEffect(() => { if (knowledge) void knowledge.listSources().then(setSources).catch((error: unknown) => setMessage(String(error))); }, [knowledge]);
  useEffect(() => { if (knowledge && projectId) void knowledge.listProjectKnowledge(projectId).then(setProjectKnowledge).catch((error: unknown) => setMessage(String(error))); else setProjectKnowledge([]); }, [knowledge, projectId]);
  const activeSources = useMemo(() => sources.filter(item => item.status !== 'disabled'), [sources]);

  async function search() {
    if (!knowledge || !query.trim()) return;
    setBusy(true); setMessage('');
    try { const result = await knowledge.search({ query: query.trim(), ...(system ? { system } : {}), ...(projectId ? { projectId } : {}) }); setHits(result.hits); setSemanticConfigured(result.semanticSearchConfigured); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  async function index() {
    if (!knowledge || !projectId) return;
    setBusy(true); setMessage('');
    try { const job = await knowledge.indexProject({ projectId }); setMessage(`代码索引已完成：扫描 ${job.scannedFiles} 个文件，写入 ${job.indexedFiles} 个文件。`); setSources(await knowledge.listSources()); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  async function saveProjectKnowledge() {
    if (!knowledge || !projectId || !knowledgeTitle.trim() || !knowledgeContent.trim()) return;
    setBusy(true); setMessage('');
    try { await knowledge.saveProjectKnowledge({ projectId, title: knowledgeTitle.trim(), content: knowledgeContent.trim(), source: 'user_confirmed', confirmed: true }); setProjectKnowledge(await knowledge.listProjectKnowledge(projectId)); setKnowledgeTitle(''); setKnowledgeContent(''); setMessage('项目知识已保存，并标记为用户确认来源。'); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  if (!knowledge) return <div className="knowledge-empty">知识引擎当前不可用，请重启应用后重试。</div>;
  return <section className="knowledge-center">
    <header className="knowledge-header"><div><span className="knowledge-kicker">KNOWLEDGE ENGINE / 03</span><h3>MES / WMS 知识中心</h3><p>统一管理产品手册、研发资料、项目代码索引和可追溯引用。</p></div><div className="knowledge-stat"><strong>{activeSources.length}</strong><span>活跃来源</span></div></header>
    {message && <p className="knowledge-message" role="status"><Icon name="check" />{message}</p>}
    <div className="knowledge-toolbar"><label className="knowledge-search"><Icon name="eye" /><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void search(); }} placeholder="检索 MES/WMS 业务、代码、规范和引用" /><button type="button" onClick={() => void search()} disabled={busy} aria-label="搜索" title="搜索"><Icon name="branch" /></button></label><select value={system} onChange={event => setSystem(event.target.value as ProductSystem | '')}><option value="">全部系统</option><option value="MES5">MES5</option><option value="MES6">MES6</option><option value="WMS">WMS</option><option value="前端">前端</option><option value="通用">通用</option></select><select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button type="button" className="knowledge-action" onClick={() => void index()} disabled={busy || !projectId}><Icon name="refresh" />索引项目代码</button></div>
    <div className="knowledge-grid"><article className="knowledge-sources"><div className="knowledge-title"><strong>知识来源</strong><span>{activeSources.length} 个</span></div>{activeSources.map(source => <div className="knowledge-source" key={source.id}><span className={`knowledge-source-dot ${source.status}`} /><div><strong>{source.name}</strong><small>{source.kind} · {source.system ?? '未分类'} · {source.trust}</small></div><em>{source.version ?? '当前'}</em></div>)}{!activeSources.length && <p className="knowledge-muted">尚未建立知识来源。</p>}</article><article className="knowledge-results"><div className="knowledge-title"><strong>检索结果</strong><span>{hits.length} 条{semanticConfigured ? '' : ' · 语义检索未配置'}</span></div>{hits.map(hit => <details className="knowledge-hit" key={hit.id}><summary><span>{hit.title}</span><small>{hit.score} · {hit.system ?? '通用'}</small></summary><p>{hit.text}</p><footer>{hit.locator} · {hit.trust} · {hit.reasons.join('、')}</footer></details>)}{!hits.length && <p className="knowledge-muted">输入业务关键词后检索，结果会保留来源定位和可信级别。</p>}</article></div>
    <article className="knowledge-project"><div className="knowledge-title"><strong>项目知识确认</strong><span>仅保存用户明确确认的内容</span></div><div className="knowledge-project-form"><input value={knowledgeTitle} onChange={event => setKnowledgeTitle(event.target.value)} placeholder="知识标题" /><textarea value={knowledgeContent} onChange={event => setKnowledgeContent(event.target.value)} placeholder="补充项目约定、接口边界或验收规则" /><button type="button" className="knowledge-action" onClick={() => void saveProjectKnowledge()} disabled={busy || !projectId || !knowledgeTitle.trim() || !knowledgeContent.trim()}><Icon name="check" />确认保存</button></div>{projectKnowledge.length > 0 && <div className="knowledge-confirmed-list">{projectKnowledge.map(item => <details key={item.id}><summary><span>{item.title}</span><small>{new Date(item.updatedAt).toLocaleString()}</small></summary><p>{item.content}</p></details>)}</div>}</article>
  </section>;
}
