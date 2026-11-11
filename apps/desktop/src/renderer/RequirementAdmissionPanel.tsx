import { useState } from 'react';
import type { RequirementAdmission, RequirementCheckItem, RequirementResolutionAction } from '../../../../packages/domain/src';
import './requirement-admission.css';

export interface RequirementAdmissionPanelProps {
  admission?: RequirementAdmission;
  historyHint?: string;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  disabled?: boolean;
  resolveAvailable?: boolean;
  onResolve: (itemId: string, action: RequirementResolutionAction, valueText?: string, reason?: string) => void | Promise<void>;
}

type DraftAction = 'confirm' | 'provide_info' | 'not_applicable' | 'accept_risk' | 'reject_assumption';
const statusLabels: Record<RequirementAdmission['status'], string> = {
  ready: '检查完成', needs_confirmation: '有待确认项', blocked: '存在未决事项', stale: '需求已变化', not_checked: '尚未检查', error: '检查失败',
};
const itemStatusLabels: Record<RequirementCheckItem['status'], string> = {
  confirmed: '已确认', missing: '缺少信息', ambiguous: '存在歧义', assumption: '待确认假设', not_applicable: '不适用',
};
const riskLabels: Record<RequirementCheckItem['riskLevel'], string> = { critical: '关键', high: '高', medium: '中', low: '低' };
const stageLabels: Record<RequirementCheckItem['blockingStage'], string> = { design: '设计', implementation: '实施', testing: '测试/验收', release: '发布', none: '仅提醒' };
const actionLabels: Record<DraftAction, string> = { confirm: '确认并记录依据', provide_info: '提交补充', not_applicable: '确认不适用', accept_risk: '接受风险继续', reject_assumption: '拒绝假设' };
const evidenceLabels: Record<string, string> = { jira_summary: 'Jira 标题', jira_description: 'Jira 描述', jira_comment: 'Jira 评论', jira_attachment: 'Jira 附件', user_supplement: '用户补充', project_context: '项目上下文', knowledge: '知识资料' };

export function RequirementAdmissionPanel({ admission, historyHint, onRefresh, refreshing = false, disabled = false, resolveAvailable, onResolve }: RequirementAdmissionPanelProps) {
  const blockedStatuses = ['stale', 'error', 'not_checked'] as const;
  const allowResolve = resolveAvailable !== false && !disabled && (!admission || !blockedStatuses.includes(admission.status as typeof blockedStatuses[number]));
  const refreshButton = onRefresh && <button type="button" className="secondary-button ra-refresh" disabled={disabled || refreshing} onClick={() => void onRefresh()}>{refreshing ? '刷新检查中…' : admission ? '重新检查' : '开始需求检查'}</button>;
  if (!admission) return <section className="requirement-admission" aria-label="需求准入检查">
    <div className="ra-compact"><details><summary><strong>需求准入</strong><span className="ra-status ra-status-not_checked">尚未检查</span><span className="ra-compact-note">仅作需求提示，不阻断开发</span></summary><div className="ra-expanded"><p className="ra-muted">{historyHint || '当前会话没有准入记录'}。不会根据历史内容补造检查结论，开发仍可继续。</p></div></details>{refreshButton}</div>
  </section>;

  const unresolvedCount = admission.items.filter(unresolved).length;
  const grouped = [
    { title: '设计或实施待确认', items: admission.items.filter(item => unresolved(item) && (item.blockingStage === 'design' || item.blockingStage === 'implementation')) },
    { title: '测试、验收或发布提醒', items: admission.items.filter(item => unresolved(item) && (item.blockingStage === 'testing' || item.blockingStage === 'release')) },
    { title: '其他检查项', items: admission.items.filter(item => !unresolved(item) || item.blockingStage === 'none') },
  ].filter(group => group.items.length > 0);

  return <section className="requirement-admission" aria-label="需求准入检查">
    <div className="ra-compact"><details><summary><strong>需求准入</strong><span className={`ra-status ra-status-${admission.status}`}>{statusLabels[admission.status]}</span><span className="ra-compact-note">{unresolvedCount ? `待确认 ${unresolvedCount} 项` : '无待确认项'} · 仅作提示，不阻断开发</span></summary><div className="ra-expanded">
      <header className="ra-heading"><div><h3>需求准入检查</h3><p>本地规则预检 · {generationLabel(admission.projectGeneration)} · {taskTypeLabel(admission.taskType)} · 检查于 {formatDate(admission.checkedAt)}</p></div></header>
      <div className="ra-summary" aria-label="准入摘要">
        <span>已确认 {admission.items.filter(item => item.status === 'confirmed').length}</span>
        <span>待处理 {unresolvedCount}</span>
        <span>验收标准 {admission.acceptanceCriteria.length}</span>
        <strong>{admission.implementationAllowed ? '检查项已满足' : '仍有检查项待处理'}</strong>
      </div>
      {!!admission.stageBlockers.length && <div className="ra-stage-blockers" role="status"><strong>阶段提醒：</strong>{admission.stageBlockers.map(stage => stageLabels[stage]).join('、')}</div>}
      {admission.status === 'stale' && <p className="ra-callout">Jira 需求快照已变化。刷新检查以更新需求提示。</p>}
      {admission.status === 'error' && <p className="ra-callout">检查未成功完成；开发仍可继续，需求检查结果暂不可用。</p>}
      {!allowResolve && admission.items.some(unresolved) && <p className="ra-callout">当前准入记录不可用于人工决策。请重新检查或等待检查完成后再操作。</p>}
      {admission.items.length ? <div className="ra-groups">{grouped.map(group => <section className="ra-group" key={group.title}><h4>{group.title}<span>{group.items.length}</span></h4><div className="ra-items">{group.items.map(item => <AdmissionItem key={item.id} item={item} admission={admission} onResolve={onResolve} resolveAvailable={allowResolve} />)}</div></section>)}</div> : <p className="ra-muted">本次检查没有生成检查项。</p>}
      <section className="ra-criteria"><h4>验收标准与测试追溯<span>{admission.acceptanceCriteria.length}</span></h4>
        {admission.acceptanceCriteria.length ? <div className="ra-criteria-list">{admission.acceptanceCriteria.map(criterion => <article className="ra-criterion" key={criterion.id}><div><strong>{criterion.criterionKey}</strong><span className={`ra-criterion-status ra-criterion-${criterion.status}`}>{criterion.status === 'confirmed' ? '已确认' : criterion.status === 'not_applicable' ? '不适用' : '待确认'}</span></div><p>{criterion.statement}</p><EvidenceList evidence={criterion.source} /></article>)}</div> : <p className="ra-muted">尚未提取验收标准。测试状态不能据此显示为已通过。</p>}
      </section>
      <footer className="ra-footer">模板 {admission.templateVersion} · 规则 {admission.ruleVersion} · 快照 {admission.snapshotHash.slice(0, 12)}</footer>
    </div></details>{refreshButton}</div>
  </section>;
}

function AdmissionItem({ item, admission, onResolve, resolveAvailable }: { item: RequirementCheckItem; admission: RequirementAdmission; onResolve: RequirementAdmissionPanelProps['onResolve']; resolveAvailable: boolean }) {
  const [draftAction, setDraftAction] = useState<DraftAction | null>(null);
  const [valueText, setValueText] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const latest = admission.resolutions.filter(resolution => resolution.itemId === item.id).at(-1);
  const hardBlock = unresolved(item) && (item.blockingStage === 'design' || item.blockingStage === 'implementation') && !item.overrideAllowed;
  const effectiveStatus = latest?.action === 'not_applicable' ? 'not_applicable' : latest?.action === 'confirm' || latest?.action === 'provide_info' ? 'confirmed' : item.status;
  async function resolve(action: RequirementResolutionAction, value?: string, why?: string) {
    setPending(true);
    try { await onResolve(item.id, action, value, why); setDraftAction(null); setValueText(''); setReason(''); }
    finally { setPending(false); }
  }
  function startDraft(action: DraftAction) { setValueText(''); setReason(''); setDraftAction(action); }
  return <article className={`ra-item${hardBlock ? ' ra-item-hard-block' : ''}`}>
    <div className="ra-item-heading"><div><span className={`ra-item-status ra-item-${effectiveStatus}`}>{itemStatusLabels[effectiveStatus]}</span><strong>{item.title}</strong></div><span className="ra-item-meta">{riskLabels[item.riskLevel]}风险 · {stageLabels[item.blockingStage]}提醒</span></div>
    <p className="ra-finding">{item.finding}</p>{item.question && <p className="ra-question"><strong>待确认：</strong>{item.question}</p>}
    {hardBlock && <p className="ra-hard-block-note">此项不能通过接受风险标记为已解决；可继续实施并保留此提醒。</p>}
    <EvidenceList evidence={item.evidence} />
    {latest && <div className="ra-resolution"><strong>最近人工决策：{resolutionLabel(latest.action)}</strong>{latest.valueText && <p>{latest.valueText}</p>}{latest.reason && <p>理由：{latest.reason}</p>}<small>{latest.actorLabel} · {formatDate(latest.createdAt)}</small></div>}
    <div className="ra-actions">
      {item.status === 'assumption' && <button type="button" className="secondary-button" disabled={pending} onClick={() => startDraft('reject_assumption')}>拒绝假设</button>}
      {item.status !== 'confirmed' && item.status !== 'not_applicable' && item.status !== 'missing' && <button type="button" className="secondary-button" disabled={pending || !resolveAvailable} onClick={() => startDraft('confirm')}>确认并记录依据</button>}
      {item.status !== 'confirmed' && item.status !== 'not_applicable' && <button type="button" className="secondary-button" disabled={pending || !resolveAvailable} onClick={() => startDraft('provide_info')}>{item.status === 'missing' ? '补充并确认' : '补充信息'}</button>}
      {item.status !== 'not_applicable' && !hardBlock && <button type="button" className="secondary-button" disabled={pending || !resolveAvailable} onClick={() => startDraft('not_applicable')}>标记不适用</button>}
      {item.overrideAllowed && unresolved(item) && <button type="button" className="secondary-button ra-risk-button" disabled={pending || !resolveAvailable} onClick={() => startDraft('accept_risk')}>接受风险继续</button>}
    </div>
    {draftAction && <form className="ra-resolution-form" onSubmit={event => { event.preventDefault(); void resolve(draftAction, ['provide_info', 'confirm'].includes(draftAction) ? valueText.trim() || undefined : undefined, draftAction === 'reject_assumption' ? valueText.trim() || undefined : reason.trim() || undefined); }}>
      <strong>{actionLabels[draftAction]}</strong>
      {(draftAction === 'provide_info' || draftAction === 'confirm' || draftAction === 'reject_assumption') && <label>{draftAction === 'provide_info' ? '补充的需求事实' : draftAction === 'confirm' ? '确认的业务事实或依据' : '拒绝原因'}<textarea autoFocus value={valueText} maxLength={4000} rows={3} onChange={event => setValueText(event.target.value)} placeholder={draftAction === 'provide_info' ? '填写已确认的业务规则或事实' : draftAction === 'confirm' ? '记录确认内容及其依据，作为本次决策审计' : '说明为什么该假设不成立'} required /></label>}
      {(draftAction === 'not_applicable' || draftAction === 'accept_risk') && <label>{draftAction === 'not_applicable' ? '不适用原因' : '风险及接受依据'}<textarea autoFocus value={reason} maxLength={2000} rows={3} onChange={event => setReason(event.target.value)} placeholder={draftAction === 'not_applicable' ? '说明此检查项为何不适用' : '说明风险、依据及接受原因'} required /></label>}
      {draftAction === 'provide_info' && <label>补充依据（可选）<textarea value={reason} maxLength={2000} rows={2} onChange={event => setReason(event.target.value)} placeholder="说明补充内容的依据" /></label>}
      <div><button type="submit" className="secondary-button" disabled={pending || !resolveAvailable || ((draftAction === 'provide_info' || draftAction === 'confirm' || draftAction === 'reject_assumption') && !valueText.trim()) || ((draftAction === 'not_applicable' || draftAction === 'accept_risk') && !reason.trim())}>{pending ? '保存中…' : draftAction === 'provide_info' && item.status === 'missing' ? '补充并确认' : actionLabels[draftAction]}</button><button type="button" className="text-button" disabled={pending} onClick={() => setDraftAction(null)}>取消</button></div>
    </form>}
  </article>;
}

function EvidenceList({ evidence }: { evidence: RequirementCheckItem['evidence'] }) {
  if (!evidence.length) return <p className="ra-evidence-missing">没有可引用的来源；此判断不能作为已确认事实。</p>;
  return <ul className="ra-evidence">{evidence.map((source, index) => <li key={`${source.sourceType}-${source.sourceId || ''}-${index}`}><strong>{evidenceLabels[source.sourceType] || source.sourceType}</strong>{source.sourceId && <span>{source.sourceId}</span>}{source.location && <span>{source.location}</span>}{source.quote && <q>{source.quote}</q>}</li>)}</ul>;
}

function unresolved(item: RequirementCheckItem) { return item.status === 'missing' || item.status === 'ambiguous' || item.status === 'assumption'; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN'); }
function generationLabel(value: RequirementAdmission['projectGeneration']) { return value === 'unknown' ? '项目代际未知' : value; }
function taskTypeLabel(value: RequirementAdmission['taskType']) { return ({ bug: '缺陷修复', feature: '新功能', integration: '接口集成', schema: '数据变更', report: '报表查询', ui: 'UI调整', config: '配置部署', refactor: '技术重构', unknown: '任务类型未知' } as const)[value]; }
function resolutionLabel(action: RequirementResolutionAction) { return ({ confirm: '确认', provide_info: '补充信息', reject_assumption: '拒绝假设', not_applicable: '标记不适用', accept_risk: '接受风险' } as const)[action]; }
