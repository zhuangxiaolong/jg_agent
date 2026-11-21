import { useEffect, useState } from 'react';
import type { Session } from '../../../../packages/domain/src';
import type { ExpertProfile, ExpertRun, ExpertSelection } from '../../../../packages/domain/src/expert';

export function ExpertSession({ session, running, open }: {session:Session; running:boolean; open:()=>void}) {
  const api = window.jinggong.experts;
  const [profiles,setProfiles] = useState<ExpertProfile[]>([]);
  const [selection,setSelection] = useState<ExpertSelection>({profileId:'auto',scope:'auto'});
  const [runs,setRuns] = useState<ExpertRun[]>([]);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  useEffect(()=>{
    let live = true;
    if (api) Promise.all([api.profiles(),api.session(session.id)]).then(([p,s])=>{
      if (live) {setProfiles(p); setSelection(s.selection); setRuns(s.runs);}
    }).catch(e=>{if (live) setError(String(e));});
    return ()=>{live=false;};
  },[api,session.id,session.status,running]);
  async function select(next:ExpertSelection) {
    if (!api) return;
    setBusy(true);
    try {await api.select(session.id,next);setSelection(next);setError('');} catch(e){setError(String(e));} finally {setBusy(false);}
  }
  if (!api) return null;
  const defaultName = profiles.find(p=>p.isDefault)?.name ?? '专家';
  const scope = selection.scope === 'auto' ? session.manualKnowledgeScope && session.manualKnowledgeScope !== 'auto' ? session.manualKnowledgeScope : session.system : selection.scope;
  const selectedName = selection.profileId === 'off' ? '普通 Agent' : profiles.find(p=>p.id === selection.profileId)?.name;
  return <details className="expert-session"><summary>{selectedName ?? (['MES5','MES6','WMS'].includes(scope ?? '') ? defaultName : '普通 Agent')}{runs[0] && ' · 最近运行 '+runs[0].name} · 专家设置</summary>
    <section><label>专家角色<select value={selection.profileId} disabled={running || busy} onChange={e=>void select({...selection,profileId:e.target.value})}><option value="auto">自动路由</option><option value="off">普通 Agent</option>{profiles.filter(p=>p.enabled).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>产品知识范围<select value={selection.scope} disabled={running || busy} onChange={e=>void select({...selection,scope:e.target.value as ExpertSelection['scope']})}>{['auto','off','MES5','MES6','WMS','SRM','JMOM','PDA'].map(s=><option key={s} value={s}>{s === 'auto' ? '自动 · '+(scope ?? '未知') : s === 'off' ? '关闭手册' : s}</option>)}</select></label>
    <button type="button" onClick={open}>专家中心</button>{error && <p role="alert">{error}</p>}
    {runs.map(run=><details key={run.id}><summary>{run.createdAt.slice(0,19).replace('T',' ')} UTC · {run.name} · {run.status}</summary>
      <p>{run.router} → {run.name} v{run.version} · {run.reason} · {run.workflowId}</p>
      <p>{run.scope.join(' + ')} · {run.runtime} · {run.provider} · {run.model}</p><code>{run.hash}</code>
      {run.error && <p>{run.error}</p>}<p>本轮检索及加载记录</p><ul>{run.sources.map((s,i)=><li key={i}>{s.kind} · {s.label} {s.version} · <code>{s.hash.slice(0,12)}</code></li>)}</ul>
      <select aria-label="回答反馈" value={run.feedback?.rating ?? ''} onChange={async e=>{try {await api.feedback(session.id,run.id,{rating:e.target.value as '有帮助'|'无帮助'|'不准确'});setRuns((await api.session(session.id)).runs);} catch(e){setError(String(e));}}}><option value="" disabled>评价回答</option>{['有帮助','无帮助','不准确'].map(t=><option key={t}>{t}</option>)}</select>
      {run.feedback?.rating === '不准确' && <select aria-label="不准确原因" value={run.feedback.reason ?? ''} onChange={async e=>{try {await api.feedback(session.id,run.id,{rating:'不准确',reason:e.target.value});setRuns((await api.session(session.id)).runs);} catch(e){setError(String(e));}}}><option disabled value="">选择原因</option>{['知识引用错误','产品版本不匹配','业务理解错误','流程遗漏','代码建议错误','其他'].map(t=><option key={t}>{t}</option>)}</select>}
    </details>)}</section></details>;
}
