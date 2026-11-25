import { useEffect, useState } from 'react';
import type { DesktopApi, ManagedDocument, Project, Session } from '../../../../packages/domain/src';
import type { OperationManual } from '../../../../packages/operation-manuals/src';
import { manualProductScope } from '../../../../packages/operation-manuals/src/product-scope';
import type { PerformanceReport } from '../../../../packages/performance/src/types';
import { ContextSnapshot, Field } from './ContextSnapshot';

interface Props {
  api: DesktopApi;
  session: Session;
  project?: Project;
  provider?: { name: string; baseUrl: string };
  running: boolean;
  runtimeName: string;
  reasoning: string;
  backend: string;
  documents: ManagedDocument[];
  dataDirectory?: string;
  gitVersion?: string;
  engine?: string;
  onManage(tab: 'documents' | 'requirements' | 'manuals'): void;
}

function endpointHost(value?: string) {
  if (!value) return '未配置';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.host : '不可用';
  } catch { return '不可用'; }
}

type IndexStatus = Awaited<ReturnType<NonNullable<DesktopApi['performance']>['indexStatus']>>;

export function ContextInspector({ api, session, project, provider, running, runtimeName, reasoning, backend, documents, dataDirectory, gitVersion, engine, onManage }: Props) {
  const [report, setReport] = useState<PerformanceReport>();
  const [reportError, setReportError] = useState(false);
  const [index, setIndex] = useState<IndexStatus>();
  const [manuals, setManuals] = useState<OperationManual[]>();
  const [manualError, setManualError] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const bound = project?.id === session.projectId ? project : undefined;

  useEffect(() => {
    const service = api.performance;
    if (!service) return;
    let active = true, pending = false;
    let timer: number;
    async function refresh() {
      if (!service || pending || !active || document.hidden) return;
      pending = true;
      const [result, indexed] = await Promise.allSettled([
        service.report(session.id), bound ? service.indexStatus(session.id) : Promise.resolve(undefined),
      ]);
      if (!active) return;
      setReport(result.status === 'fulfilled' ? result.value : undefined);
      setReportError(result.status === 'rejected');
      setIndex(indexed.status === 'fulfilled' ? indexed.value : { status: '无法读取索引状态', fileCount: 0 });
      pending = false;
      timer = window.setTimeout(refresh, running ? 2000 : 5000);
    }
    function visibilityChanged() { window.clearTimeout(timer); void refresh(); }
    void refresh();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => { active = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', visibilityChanged); };
  }, [api, session.id, bound?.id, running]);

  useEffect(() => {
    if (!configOpen) return;
    let active = true;
    setManualError(false);
    void api.listOperationManuals().then(items => { if (active) setManuals(items); })
      .catch(() => { if (active) { setManuals(undefined); setManualError(true); } });
    return () => { active = false; };
  }, [api, configOpen]);

  const enabledDocs = documents.filter(doc => doc.enabled && (doc.system === '通用' || doc.system === session.system));
  const scope = manualProductScope(session.manualKnowledgeScope, session.system);
  const enabledManuals = manuals?.filter(item => scope.includes(item.productType) && (item.status === 'ready' || item.status === 'partial'));
  return <div className="context-inspector">
    <div className="ci-binding">
      <section className="ci-card"><h3>会话绑定</h3><dl className="ci-fields">
        <Field label="会话类型">{session.projectId ? '项目会话' : '独立会话'}</Field>
        {bound && <><Field label="项目名称">{bound.name}</Field><Field label="Git 项目根目录"><code>{bound.path}</code></Field></>}
        <Field label="当前工作目录"><code>{session.workspacePath || '不可用'}</code></Field>
        {session.projectId && <Field label="Worktree 路径">未提供已验证的路径</Field>}
        {session.branch && <Field label="会话分支">{session.branch}</Field>}
        <Field label="产品系统">{session.system ?? '通用'}</Field>
        {bound && <Field label="项目索引">{index?.status ?? (api.performance ? '正在读取…' : '不可用')}{index?.status === '可用' && ` · ${index.fileCount} 个文件`}</Field>}
      </dl>
      {!session.projectId && <p>独立会话未关联 Git 项目，本轮不执行项目索引。</p>}
      {session.projectId && !bound && <p className="ci-warning" role="alert">项目记录缺失，需要重新关联。</p>}
      {index?.error && <p className="ci-warning">最近索引错误 · {index.error}</p>}
      </section>
      <section className="ci-card"><h3>当前会话配置</h3><dl className="ci-fields">
        <Field label="Runtime">{runtimeName}{session.runtimeVersion && ` · ${session.runtimeVersion}`}</Field>
        <Field label="Provider">{provider ? `${provider.name}${session.providerId ? '' : '（默认）'}` : session.providerId || '未选择'}</Field>
        <Field label="模型">{session.model || '未选择'}</Field><Field label="推理强度">{reasoning}</Field>
        <Field label="Endpoint 主机">{endpointHost(provider?.baseUrl)}</Field><Field label="Backend">{backend}</Field>
      </dl></section>
    </div>
    <h2>上下文快照</h2>
    {!api.performance ? <p className="ci-card">当前构建未提供上下文采集接口。</p>
      : reportError ? <p className="ci-card ci-warning" role="alert">读取上下文快照失败，稍后自动重试。</p>
      : report ? <ContextSnapshot session={session} report={report} running={running} />
      : <p className="ci-card" role="status">正在读取上下文快照…</p>}
    <details className="ci-card" onToggle={event => setConfigOpen(event.currentTarget.open)}><summary>可用资料配置</summary>
      <h4>开发规范与数据字典</h4>
      {enabledDocs.length ? <ul>{enabledDocs.map(doc => <li key={doc.id}>{doc.name}<small>{doc.system} · {doc.kind === 'dictionary' ? '数据字典' : '开发规范'}</small></li>)}</ul> : <p>当前系统没有已启用的规范或字典。</p>}
      <h4>产品操作手册</h4>
      <p>会话检索范围 · {session.manualKnowledgeScope === 'off' ? '已关闭' : session.manualKnowledgeScope && session.manualKnowledgeScope !== 'auto' ? session.manualKnowledgeScope : '自动匹配系统与任务'}</p>
      {report?.settings.contextSources.operation_manual === false ? <p>操作手册来源已关闭。</p> : session.manualKnowledgeScope !== 'off' && (
        manualError ? <p>无法读取手册配置。</p> : !enabledManuals ? <p>正在读取手册…</p>
        : enabledManuals.length ? <ul>{enabledManuals.map(item => <li key={item.id}>{item.name}<small>{item.productType} · {item.manualVersion ?? '未标注版本'}</small></li>)}</ul>
        : <p>当前系统范围内没有可检索手册。</p>)}
      <div className="ci-actions"><button className="text-button" onClick={() => onManage('documents')}>管理数据字典</button>
        <button className="text-button" onClick={() => onManage('requirements')}>管理开发要求与规范</button>
        <button className="text-button" onClick={() => onManage('manuals')}>管理操作手册</button></div>
    </details>
    <details className="ci-card"><summary>本机环境</summary><dl className="ci-fields">
      <Field label="精工 Agent 引擎">{engine || '未检测到'}</Field><Field label="Git">{gitVersion || '未检测到'}</Field>
      <Field label="本地数据目录"><code>{dataDirectory}</code></Field>
    </dl></details>
  </div>;
}
