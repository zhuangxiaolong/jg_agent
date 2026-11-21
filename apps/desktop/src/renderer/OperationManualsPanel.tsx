import { useCallback, useEffect, useState } from 'react';
import type { DesktopApi, Session } from '../../../../packages/domain/src';
import type { ManualImportResult, ManualProductType, ManualSearchHit, OperationManual } from '../../../../packages/operation-manuals/src';
import { formatManualLocator } from '../../../../packages/operation-manuals/src/format';
import { Icon } from './ui';
import './operation-manuals.css';

type ManualDetails = Awaited<ReturnType<DesktopApi['getOperationManual']>>;
type Scope = NonNullable<Session['manualKnowledgeScope']>;
type ManualImportMetadata = { productType: ManualProductType; productVersion?: string; manualVersion?: string; effectiveDate?: string; scopeNote?: string };
type ManualFileSelection = NonNullable<Awaited<ReturnType<DesktopApi['selectOperationManualFiles']>>>;
type SelectedManualFile = ManualFileSelection['files'][number] & { metadata: ManualImportMetadata };
const products: Array<{ value: ManualProductType | 'all'; label: string }> = [
  { value: 'all', label: '全部产品' }, { value: 'MES5', label: 'MES5' }, { value: 'MES6', label: 'MES6' }, { value: 'WMS', label: 'WMS' }, { value: 'SRM', label: 'SRM' }, { value: 'JMOM', label: 'JMOM' }, { value: 'PDA', label: 'PDA' }, { value: 'COMMON', label: '通用' },
];
const manualProducts: ManualProductType[] = ['MES5', 'MES6', 'WMS', 'SRM', 'JMOM', 'PDA', 'COMMON'];

function statusLabel(status: OperationManual['status']): string {
  return ({ pending: '等待处理', processing: '处理中', ready: '可用', partial: '部分可用', failed: '解析失败', disabled: '已停用' })[status];
}

export function OperationManualsPanel({ sessions, pending, act, api }: {
  sessions: Session[];
  pending: boolean;
  act: (work: () => Promise<unknown>, success?: string | (() => string)) => Promise<boolean>;
  api: DesktopApi;
}) {
  const [manuals, setManuals] = useState<OperationManual[]>([]);
  const [details, setDetails] = useState<ManualDetails>(null);
  const [selectedId, setSelectedId] = useState('');
  const [editingManualId, setEditingManualId] = useState('');
  const [filter, setFilter] = useState<ManualProductType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<OperationManual['status'] | 'all'>('all');
  const [manualSearch, setManualSearch] = useState('');
  const [productType, setProductType] = useState<ManualProductType>('MES6');
  const [productVersion, setProductVersion] = useState('');
  const [manualVersion, setManualVersion] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [scopeNote, setScopeNote] = useState('');
  const [fileSelection, setFileSelection] = useState<ManualFileSelection | null>(null);
  const [selectedManualFiles, setSelectedManualFiles] = useState<SelectedManualFile[]>([]);
  const [importResult, setImportResult] = useState<ManualImportResult | null>(null);
  const [testProduct, setTestProduct] = useState<ManualProductType | 'all'>('all');
  const [testQuery, setTestQuery] = useState('');
  const [testHits, setTestHits] = useState<Array<ManualSearchHit & { citation: string }>>([]);
  const [testPerformed, setTestPerformed] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [sessionScope, setSessionScope] = useState<Scope>('auto');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [editName, setEditName] = useState('');
  const [editProductVersion, setEditProductVersion] = useState('');
  const [editManualVersion, setEditManualVersion] = useState('');
  const [editEffectiveDate, setEditEffectiveDate] = useState('');
  const [editScopeNote, setEditScopeNote] = useState('');
  const [editProductType, setEditProductType] = useState<ManualProductType>('MES6');

  const refresh = useCallback(async () => {
    const list = await api.listOperationManuals();
    setManuals(list);
    const nextId = list.some(item => item.id === selectedId) ? selectedId : list[0]?.id ?? '';
    setSelectedId(nextId);
    const detail = nextId ? await api.getOperationManual(nextId) : null;
    setDetails(detail);
    if (detail && editingManualId !== nextId) {
      setEditingManualId(nextId);
      setEditName(detail.manual.name);
      setEditProductType(detail.manual.productType);
      setEditProductVersion(detail.manual.productVersion ?? '');
      setEditManualVersion(detail.manual.manualVersion ?? '');
      setEditEffectiveDate(detail.manual.effectiveDate ?? '');
      setEditScopeNote(detail.manual.scopeNote ?? '');
    }
  }, [api, editingManualId, selectedId]);

  useEffect(() => {
    let active = true;
    const load = async () => { if (active) await refresh().catch(() => undefined); };
    void load();
    const timer = setInterval(() => { void load(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    setSessionId(current => sessions.some(item => item.id === current) ? current : sessions[0]?.id ?? '');
  }, [sessions]);
  useEffect(() => {
    const session = sessions.find(item => item.id === sessionId);
    setSessionScope(session?.manualKnowledgeScope ?? 'auto');
  }, [sessionId, sessions]);

  const visibleManuals = manuals.filter(item =>
    (filter === 'all' || item.productType === filter)
    && (statusFilter === 'all' || item.status === statusFilter)
    && (!manualSearch.trim() || `${item.name} ${item.originalName} ${item.productVersion ?? ''} ${item.manualVersion ?? ''} ${item.scopeNote ?? ''}`.toLocaleLowerCase('zh-CN').includes(manualSearch.trim().toLocaleLowerCase('zh-CN'))),
  );
  const manual = details?.manual;
  const latestJob = details?.jobs[0];
  const currentSession = sessions.find(item => item.id === sessionId);

  async function selectManual(id: string) {
    setSelectedId(id);
    const detail = await api.getOperationManual(id);
    setDetails(detail);
    if (!detail) return;
    setEditingManualId(id);
    setEditName(detail.manual.name);
    setEditProductType(detail.manual.productType);
    setEditProductVersion(detail.manual.productVersion ?? '');
    setEditManualVersion(detail.manual.manualVersion ?? '');
    setEditEffectiveDate(detail.manual.effectiveDate ?? '');
    setEditScopeNote(detail.manual.scopeNote ?? '');
  }

  function defaultImportMetadata(): ManualImportMetadata {
    return { productType, ...(productVersion.trim() ? { productVersion: productVersion.trim() } : {}), ...(manualVersion.trim() ? { manualVersion: manualVersion.trim() } : {}), ...(effectiveDate ? { effectiveDate } : {}), ...(scopeNote.trim() ? { scopeNote: scopeNote.trim() } : {}) };
  }

  async function selectFiles() {
    await act(async () => {
      const selection = await api.selectOperationManualFiles();
      setFileSelection(selection);
      setSelectedManualFiles(selection?.files.map(file => ({ ...file, metadata: { ...defaultImportMetadata() } })) ?? []);
    }, '文件已选择，可逐份设置产品分类和版本。');
  }

  async function replaceManualFile() {
    if (!manual) return;
    await act(async () => {
      const selection = await api.selectOperationManualFiles();
      if (!selection) return;
      if (selection.files.length !== 1) throw new Error('替换手册时请只选择一个文件。');
      await api.replaceOperationManualFile({ manualId: manual.id, selectionId: selection.selectionId, fileId: selection.files[0].id });
      await refresh();
    }, '已提交手册替换。解析完成后，新文件和索引会一起生效。');
  }

  function applyDefaultsToFiles() {
    const metadata = defaultImportMetadata();
    setSelectedManualFiles(current => current.map(file => ({ ...file, metadata: { ...metadata } })));
  }

  function updateSelectedFile(id: string, patch: Partial<ManualImportMetadata>) {
    setSelectedManualFiles(current => current.map(file => file.id === id ? { ...file, metadata: { ...file.metadata, ...patch } } : file));
  }

  async function importFiles() {
    if (!fileSelection || !selectedManualFiles.length) return;
    setImportResult(null);
    const completed = await act(async () => {
      const result = await api.importSelectedOperationManualFiles({
        selectionId: fileSelection.selectionId,
        files: selectedManualFiles.map(({ id, metadata }) => ({ id, metadata })),
      });
      setImportResult(result);
      setFileSelection(null);
      setSelectedManualFiles([]);
      await refresh();
    }, '已提交手册导入。解析将在后台进行。');
    if (completed) setTestPerformed(false);
  }

  async function updateManual() {
    if (!manual) return;
    await act(async () => {
      await api.updateOperationManual(manual.id, {
        name: editName.trim(), productType: editProductType,
        productVersion: editProductVersion.trim() || undefined,
        manualVersion: editManualVersion.trim() || undefined,
        effectiveDate: editEffectiveDate || undefined,
        scopeNote: editScopeNote.trim() || undefined,
      });
      await refresh();
    }, '手册信息已更新。');
  }

  async function testSearch() {
    if (!testQuery.trim()) return;
    await act(async () => {
      const productTypes = testProduct === 'all' ? manualProducts : [testProduct];
      setTestHits(await api.testOperationManualSearch({ productTypes, query: testQuery.trim() }));
      setTestPerformed(true);
    }, '检索测试已完成。');
  }

  async function setCurrentSessionScope(next: Scope) {
    if (!currentSession) return;
    const updated = await api.setSessionManualKnowledgeScope(currentSession.id, next);
    setSessionScope(updated.manualKnowledgeScope ?? 'auto');
    await refresh();
  }

  return <section aria-label="产品操作手册知识库">
    <div className="section-heading"><div><h3>产品操作手册</h3><p>在本机管理手册。相关问题会按会话产品范围检索并把来源定位交给当前 Runtime。</p></div></div>

    <div className="settings-form">
      <h4>导入手册</h4>
      <div className="document-controls">
        <label>默认产品分类<select value={productType} onChange={event => setProductType(event.target.value as ManualProductType)} disabled={pending}>{manualProducts.map(value => <option key={value} value={value}>{value === 'COMMON' ? '通用' : value}</option>)}</select></label>
        <label>产品版本<input value={productVersion} onChange={event => setProductVersion(event.target.value)} maxLength={100} placeholder="可留空" disabled={pending} /></label>
        <label>手册版本<input value={manualVersion} onChange={event => setManualVersion(event.target.value)} maxLength={100} placeholder="如 V1.2" disabled={pending} /></label>
        <label>生效日期<input type="date" value={effectiveDate} onChange={event => setEffectiveDate(event.target.value)} disabled={pending} /></label>
      </div>
      <label htmlFor="manual-scope-note">适用范围或备注</label>
      <input id="manual-scope-note" value={scopeNote} onChange={event => setScopeNote(event.target.value)} maxLength={1000} placeholder="如适用模块、工厂或特殊范围" disabled={pending} />
      <p className="field-hint">支持 PDF、DOCX、XLSX、PPTX、MD、TXT、HTML，单文件不超过 100 MiB，每批最多 20 个。选择后可逐份指定分类和版本。</p>
      <div className="settings-actions">
        <button className="primary-button" type="button" disabled={pending} onClick={() => void selectFiles()}><Icon name="plus" />选择手册文件</button>
        {selectedManualFiles.length > 0 && <button className="secondary-button" type="button" disabled={pending} onClick={applyDefaultsToFiles}>将默认信息应用到全部</button>}
        <button className="primary-button" type="button" disabled={pending || !selectedManualFiles.length} onClick={() => void importFiles()}>导入并解析 {selectedManualFiles.length || ''} 份</button>
      </div>
      {selectedManualFiles.length > 0 && <div className="manual-import-selection" aria-label="待导入手册列表">{selectedManualFiles.map(file => <div className="manual-import-row" key={file.id}>
        <div className="manual-import-file"><strong title={file.name}>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(2)} MiB</small><button className="secondary-button" type="button" disabled={pending} onClick={() => setSelectedManualFiles(current => current.filter(item => item.id !== file.id))}>移除</button></div>
        <div className="document-controls">
          <label>产品分类<select value={file.metadata.productType} onChange={event => updateSelectedFile(file.id, { productType: event.target.value as ManualProductType })} disabled={pending}>{manualProducts.map(value => <option key={value} value={value}>{value === 'COMMON' ? '通用' : value}</option>)}</select></label>
          <label>产品版本<input value={file.metadata.productVersion ?? ''} onChange={event => updateSelectedFile(file.id, { productVersion: event.target.value || undefined })} maxLength={100} disabled={pending} /></label>
          <label>手册版本<input value={file.metadata.manualVersion ?? ''} onChange={event => updateSelectedFile(file.id, { manualVersion: event.target.value || undefined })} maxLength={100} disabled={pending} /></label>
          <label>生效日期<input type="date" value={file.metadata.effectiveDate ?? ''} onChange={event => updateSelectedFile(file.id, { effectiveDate: event.target.value || undefined })} disabled={pending} /></label>
          <label>适用范围<input value={file.metadata.scopeNote ?? ''} onChange={event => updateSelectedFile(file.id, { scopeNote: event.target.value || undefined })} maxLength={1000} disabled={pending} /></label>
        </div>
      </div>)}</div>}
      {importResult && <div className="manual-import-result" role="status">
        <p>新增 {importResult.imported.length} 份，重复 {importResult.duplicates.length} 份，失败 {importResult.errors.length} 份。</p>
        {importResult.duplicates.map(item => <p key={item.id}>已存在：{item.name}（{item.productType}）</p>)}
        {importResult.errors.map((item, index) => <p key={`${item.fileName}-${index}`} className="form-error">{item.fileName}：{item.message}</p>)}
      </div>}
    </div>

    <div className="settings-form">
      <h4>手册范围</h4>
      <p className="field-hint">自动匹配使用当前会话的产品范围，或按问题中明确提到的 MES5、MES6、WMS、SRM、JMOM、PDA 分类，并包含通用手册；未知产品不会自动混用手册。</p>
      <div className="document-controls">
        <label>会话<select value={sessionId} onChange={event => setSessionId(event.target.value)} disabled={!sessions.length || pending}>{sessions.map(item => <option key={item.id} value={item.id}>{item.alias || item.title}</option>)}</select></label>
        <label>产品知识范围<select value={sessionScope} onChange={event => void act(() => setCurrentSessionScope(event.target.value as Scope), '会话产品知识范围已保存。')} disabled={!currentSession || pending}><option value="auto">自动匹配</option><option value="MES5">MES5 + 通用</option><option value="MES6">MES6 + 通用</option><option value="WMS">WMS + 通用</option><option value="SRM">SRM + 通用</option><option value="JMOM">JMOM + 通用</option><option value="PDA">PDA + 通用</option><option value="off">关闭手册检索</option></select></label>
      </div>
    </div>

    <div className="settings-form">
      <h4>手册库</h4>
      <div className="document-controls"><label>产品筛选<select value={filter} onChange={event => setFilter(event.target.value as ManualProductType | 'all')}>{products.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label>状态筛选<select value={statusFilter} onChange={event => setStatusFilter(event.target.value as OperationManual['status'] | 'all')}><option value="all">全部状态</option>{(['pending', 'processing', 'ready', 'partial', 'failed', 'disabled'] as const).map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label><label>名称或版本<input value={manualSearch} onChange={event => setManualSearch(event.target.value)} placeholder="搜索手册、版本或适用范围" /></label><span>{visibleManuals.length} 份手册</span></div>
      <div className="managed-list">{!visibleManuals.length && <div className="settings-empty">暂无手册。导入后会在后台解析并建立本地索引。</div>}{visibleManuals.map(item => {
        const job = item.id === manual?.id ? latestJob : undefined;
        return <div className={`managed-row ${item.id === selectedId ? 'selected' : ''}`} key={item.id}>
          <button className="managed-select" aria-label={`查看手册 ${item.name}`} onClick={() => void selectManual(item.id)}><Icon name="file" /><span><strong>{item.name}</strong><small>{item.productType}{item.manualVersion ? ` · ${item.manualVersion}` : ''} · {statusLabel(item.status)}{job && ['queued', 'running'].includes(job.status) ? ` · ${job.progress}%` : ''}</small></span></button>
          <button className="secondary-button" type="button" disabled={pending || ['queued', 'running'].includes(job?.status ?? '')} onClick={() => void act(() => api.setOperationManualEnabled(item.id, item.status === 'disabled'), item.status === 'disabled' ? '手册已启用。' : '手册已停用。')}>{item.status === 'disabled' ? '启用' : '停用'}</button>
          <button className="secondary-button" type="button" disabled={pending} onClick={() => void act(() => api.reparseOperationManual(item.id), '已加入重新解析队列。')}>重新解析</button>
        </div>;
      })}</div>
      {manual && <>
        <div className="document-preview">
          <div className="preview-heading"><strong>{manual.name}</strong><span>{manual.productType} · {statusLabel(manual.status)}</span></div>
          <p className="document-digest" title={manual.sha256}>{manual.bundled ? '安装包内置手册 · ' : ''}原文件：{manual.originalName} · {(manual.fileSize / 1024 / 1024).toFixed(2)} MiB · SHA-256 {manual.sha256.slice(0, 20)}…</p>
          <p className="field-hint">导入于 {new Date(manual.createdAt).toLocaleString('zh-CN')} · {manual.extractedChars.toLocaleString('zh-CN')} 字符 · {manual.chunkCount} 个知识片段{manual.pageCount ? ` · ${manual.pageCount} 页` : ''}{manual.sheetCount ? ` · ${manual.sheetCount} 个工作表` : ''}{manual.slideCount ? ` · ${manual.slideCount} 张幻灯片` : ''}</p>
          {manual.errorSummary && <p className="form-error">{manual.errorSummary}</p>}
          {latestJob && ['queued', 'running'].includes(latestJob.status) && <p className="field-hint">后台解析阶段：{latestJob.stage} · {latestJob.progress}%{latestJob.status === 'running' ? ' · 正在处理' : ' · 排队中'} <button className="secondary-button" type="button" onClick={() => void act(() => api.cancelOperationManualJob(latestJob.id), '解析任务已取消。')}>取消</button></p>}
        </div>
        <div className="settings-form">
          <h4>手册元数据</h4>
          <label htmlFor="manual-name">名称</label><input id="manual-name" value={editName} onChange={event => setEditName(event.target.value)} maxLength={200} disabled={pending} />
          <div className="document-controls"><label>产品分类<select value={editProductType} onChange={event => setEditProductType(event.target.value as ManualProductType)} disabled={pending}>{manualProducts.map(value => <option key={value} value={value}>{value === 'COMMON' ? '通用' : value}</option>)}</select></label><label>产品版本<input value={editProductVersion} onChange={event => setEditProductVersion(event.target.value)} maxLength={100} disabled={pending} /></label><label>手册版本<input value={editManualVersion} onChange={event => setEditManualVersion(event.target.value)} maxLength={100} disabled={pending} /></label><label>生效日期<input type="date" value={editEffectiveDate} onChange={event => setEditEffectiveDate(event.target.value)} disabled={pending} /></label></div>
          <label htmlFor="manual-edit-scope">适用范围或备注</label><input id="manual-edit-scope" value={editScopeNote} onChange={event => setEditScopeNote(event.target.value)} maxLength={1000} disabled={pending} />
          <div className="settings-actions"><button className="primary-button" type="button" disabled={pending || !editName.trim()} onClick={() => void updateManual()}><Icon name="check" />保存信息</button><button className="secondary-button" type="button" disabled={pending || ['queued', 'running'].includes(latestJob?.status ?? '')} onClick={() => void replaceManualFile()}>重新上传并替换</button><button className="danger-button" type="button" disabled={pending || manual.bundled} title={manual.bundled ? '安装包内置手册可停用或替换' : undefined} onClick={() => setDeleteConfirm(true)}>删除手册</button></div>
          {deleteConfirm && <div className="delete-confirm"><span>确认删除「{manual.name}」及其原始文件、解析内容和索引？</span><button type="button" disabled={pending} onClick={() => setDeleteConfirm(false)}>保留</button><button className="danger-button" type="button" disabled={pending} onClick={async () => { if (await act(async () => { await api.deleteOperationManual(manual.id); setSelectedId(''); setDeleteConfirm(false); await refresh(); }, '手册及其索引已删除。')) setDetails(null); }}>确认删除</button></div>}
        </div>
        {details?.chunks.length ? <div className="document-preview"><div className="preview-heading"><strong>解析片段预览</strong><span>显示前 {details.chunks.length} 段</span></div>{details.chunks.slice(0, 20).map(chunk => <article className="manual-chunk-preview" key={chunk.id}><strong>{chunk.sectionPath.join(' / ') || '未命名章节'}</strong><small>{formatManualLocator(chunk.locator)}</small><pre>{chunk.content.slice(0, 1800)}</pre></article>)}</div> : null}
      </>}
    </div>

    <div className="settings-form">
      <h4>测试检索</h4>
      <div className="document-controls"><label>产品范围<select value={testProduct} onChange={event => setTestProduct(event.target.value as ManualProductType | 'all')}><option value="all">全部产品</option>{manualProducts.map(value => <option key={value} value={value}>{value === 'COMMON' ? '通用' : value}</option>)}</select></label><input aria-label="输入操作问题测试检索" value={testQuery} onChange={event => setTestQuery(event.target.value)} maxLength={2000} placeholder="输入一个操作问题" /><button className="secondary-button" type="button" disabled={pending || !testQuery.trim()} onClick={() => void testSearch()}>测试检索</button></div>
      {testPerformed && <div className="managed-list">{!testHits.length && <div className="settings-empty">没有命中可用手册片段。</div>}{testHits.map(hit => <article className="manual-chunk-preview" key={hit.chunk.id}><strong>{hit.manual.name}{hit.manual.manualVersion ? ` · ${hit.manual.manualVersion}` : ''} · {hit.manual.productType}</strong><small>{hit.citation} · 匹配分 {hit.score}</small><pre>{hit.chunk.content}</pre></article>)}</div>}
    </div>
  </section>;
}
