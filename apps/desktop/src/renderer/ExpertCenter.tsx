import { useEffect, useState } from 'react';
import type { ExpertApi, ExpertCase, ExpertComparison, ExpertGrade, ExpertProfile } from '../../../../packages/domain/src/expert';
import type { Session } from '../../../../packages/domain/src';
import './expert-center.css';

const dimensions = ['任务理解','产品版本','引用质量','专业完整度','可执行性','风险边界','交付可用性'];
const average = (scores:number[]) => scores.reduce((sum,n)=>sum+n,0)/scores.length;
const pct = (n:number,d:number) => d ? Math.round(100*n/d)+'%' : '—';

function Review({run,arm,save}:{run:ExpertComparison;arm:'baseline'|'expert';save:(value:ExpertGrade)=>void}) {
  const result = run[arm];
  const [draft,set] = useState<ExpertGrade>(result.grade ?? {scores:Array(7).fill(-1),citation:'不适用',complete:false,mismatch:false,notes:''});
  return <details><summary>{arm === 'baseline' ? '普通 Agent' : '专家'} · {result.status} · {result.grade ? average(result.grade.scores).toFixed(2)+' 分' : '未评分'}</summary>
    <pre>{result.answer || result.error || result.status}</pre>
    {result.status === 'completed' && <><div className="expert-scores">{dimensions.map((s,i)=><label key={s}>{s}<select value={draft.scores[i]} onChange={e=>set({...draft,scores:draft.scores.map((n,j)=>i===j?Number(e.target.value):n)})}><option value="-1">未评</option>{[0,1,2,3,4,5].map(n=><option key={n}>{n}</option>)}</select></label>)}</div>
    <label>引用准确性<select value={draft.citation} onChange={e=>set({...draft,citation:e.target.value as ExpertGrade['citation']})}>{['正确','错误','不适用'].map(v=><option key={v}>{v}</option>)}</select></label>
    <label><input type="checkbox" checked={draft.mismatch} onChange={e=>set({...draft,mismatch:e.target.checked})}/>产品错配</label>
    <label><input type="checkbox" checked={draft.complete} onChange={e=>set({...draft,complete:e.target.checked})}/>关键项完整</label>
    <label>评审备注<textarea value={draft.notes} onChange={e=>set({...draft,notes:e.target.value})}/></label>
    <button disabled={draft.scores.includes(-1)} onClick={()=>save(draft)}>保存人工评分</button></>}
  </details>;
}

export function ExpertCenter({api,sessions}:{api:ExpertApi;sessions:Session[]}) {
  const [profiles,setProfiles]=useState<ExpertProfile[]>([]), [cases,setCases]=useState<ExpertCase[]>([]), [records,setRecords]=useState<ExpertComparison[]>([]);
  const [tab,setTab]=useState('档案'),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [selected,setProfile]=useState('mes-wms-engineering'),[editing,setEditing]=useState<ExpertProfile>();
  const [role,setRole]=useState(''),[product,setProduct]=useState(''),[draft,setCase]=useState<ExpertCase>();
  const [sessionId,setSession]=useState(sessions[0]?.id ?? ''),[evalProfile,setEvalProfile]=useState('');
  const profile = profiles.find(p=>p.id === selected), roles = profiles.filter(p=>p.role);
  const filtered = cases.filter(c=>(!role || c.profileId===role) && (!product || c.product===product));
  const visible = records.filter(r=>(!role || r.case.profileId===role) && (!product || r.case.product===product));
  const comparisonGroups = new Map<string,ExpertComparison[]>();
  for (const record of visible) {
    const key = JSON.stringify([record.case.profileId,record.runtime,record.provider,record.model,record.effort,record.strategy,record.profileHash]);
    const group = comparisonGroups.get(key) ?? [];
    group.push(record); comparisonGroups.set(key,group);
  }
  async function refresh() {const [p,c,r]=await Promise.all([api.profiles(),api.cases(),api.comparisons()]);setProfiles(p);setCases(c);setRecords(r);}
  useEffect(()=>{void refresh().catch(e=>setMessage(String(e)));},[api]);
  async function act(work:()=>Promise<unknown>) {
    setBusy(true);setMessage('');
    try {await work();await refresh();} catch(e){setMessage(String(e));} finally{setBusy(false);}
  }
  async function change(action:Parameters<ExpertApi['profile']>[0]) {
    if (!profile) return;
    await act(async()=>{
      const list=await api.profile(action,profile.id,action==='edit' && editing ? {name:editing.name,output:editing.output,steps:editing.steps,version:editing.version} : undefined);
      if(action==='copy') setProfile(list.find(p=>!profiles.some(old=>old.id===p.id))!.id);
      if(action==='delete') setProfile('mes-wms-engineering');setEditing(undefined);
    });
  }
  const [comparing,setComparing]=useState(false);
  useEffect(()=>{if (!comparing) return;const timer=setInterval(()=>void api.comparisons().then(setRecords).catch(e=>setMessage(String(e))),1500);return ()=>clearInterval(timer);},[api,comparing]);
  const editingCase = draft && cases.find(c=>c.id===draft.id);
  const savedCase = draft && editingCase && (Object.keys(draft) as Array<keyof ExpertCase>).every(key=>draft[key]===editingCase[key]);
  return <section className="expert-center"><h3>专家中心</h3><div className="expert-actions">{['档案','评测工作台'].map(t=><button disabled={tab===t} key={t} onClick={()=>setTab(t)}>{t}</button>)}</div>
    {message && <p className="form-error" role="alert">{message}</p>}
    {tab==='档案' && <><label>专家档案<select value={selected} onChange={e=>{setProfile(e.target.value);setEditing(undefined);}}>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}{p.isDefault?' · 默认':''}{p.enabled?'':' · 停用'}</option>)}</select></label>
    {profile && <><p>{profile.familyId} · {profile.role ?? '路由专家'} · v{profile.version} · {profile.builtin?'内置':'自定义'}</p><code>{profile.contentHash}</code>
    <h4>工作流</h4><ol>{profile.steps.map((s,i)=><li key={i}>{s}</li>)}</ol><p>知识来源 · {profile.sources.join('、')}</p><p>Skill 标签 · {profile.skillTags.join('、') || '按任务匹配'}</p><p>输出 · {profile.output}</p><p>验收 · {profile.checks}</p>
    <div className="expert-actions"><button disabled={busy} onClick={()=>void change('copy')}>复制档案</button><button disabled={busy || !profile.enabled || profile.isDefault} onClick={()=>void change('default')}>设为默认</button><button disabled={busy || profile.isDefault} onClick={()=>void change('toggle')}>{profile.enabled?'停用':'启用'}</button>
    {profile.builtin ? <button disabled={busy} onClick={()=>void change('restore')}>恢复内置配置</button> : <><button disabled={busy} onClick={()=>setEditing(profile)}>编辑</button><button disabled={busy || profile.isDefault} onClick={()=>void change('delete')}>删除档案</button></>}</div>
    {editing && <><label>名称<input value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})}/></label><label>工作步骤（每行一项）<textarea value={editing.steps.join('\n')} onChange={e=>setEditing({...editing,steps:e.target.value.split('\n')})}/></label><label>输出规范<textarea value={editing.output} onChange={e=>setEditing({...editing,output:e.target.value})}/></label><button disabled={busy} onClick={()=>void change('edit')}>保存档案</button></>}</>}</>}
    {tab==='评测工作台' && <><div className="expert-actions"><label>岗位<select value={role} onChange={e=>{setRole(e.target.value);setCase(undefined);}}><option value="">全部岗位</option>{roles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>产品<select value={product} onChange={e=>{setProduct(e.target.value);setCase(undefined);}}><option value="">全部产品</option>{['MES5','MES6','WMS'].map(v=><option key={v}>{v}</option>)}</select></label></div>
    <label>案例（{filtered.length}）<select aria-label="评测案例" value={draft?.id ?? ''} onChange={e=>setCase(cases.find(c=>c.id===e.target.value))}><option value="">选择案例</option>{filtered.map(c=><option key={c.id} value={c.id}>{c.product} · {c.prompt}</option>)}</select></label>
    <button onClick={()=>setCase({id:crypto.randomUUID(),product:'MES5',profileId:role||roles[0].id,prompt:'',expected:'',reference:''})}>新增案例</button>
    {draft && <><label>案例产品<select value={draft.product} onChange={e=>setCase({...draft,product:e.target.value as ExpertCase['product']})}>{['MES5','MES6','WMS'].map(v=><option key={v}>{v}</option>)}</select></label><label>预期角色<select value={draft.profileId} onChange={e=>setCase({...draft,profileId:e.target.value})}>{roles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    {(['prompt','expected','reference'] as const).map((k,i)=><label key={k}>{['任务输入','预期关键点','评审依据'][i]}<textarea value={draft[k]} onChange={e=>setCase({...draft,[k]:e.target.value})}/></label>)}
    <div className="expert-actions"><button disabled={busy} onClick={()=>void act(()=>api.saveCase(draft))}>保存案例</button><button disabled={busy||!editingCase} onClick={()=>void act(async()=>{await api.deleteCase(draft.id);setCase(undefined);})}>删除案例</button></div>
    <label>对照配置<select value={sessionId} onChange={e=>setSession(e.target.value)}><option value="">选择已配置模型的会话</option>{sessions.map(s=><option key={s.id} value={s.id}>{s.title} · {s.runtimeKind ?? 'codex'} · {s.model}</option>)}</select></label><label>对照专家<select value={evalProfile} onChange={e=>setEvalProfile(e.target.value)}><option value="">使用案例预期角色</option>{profiles.filter(p=>p.enabled).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <button disabled={busy||!sessionId||!savedCase} onClick={()=>void act(async()=>{setComparing(true);try{await api.compare(sessionId,draft.id,evalProfile||draft.profileId);}finally{setComparing(false);}})}>运行普通与专家对照</button></>}
    <button disabled={!comparing && !records.some(r=>r.baseline.status==='running'||r.expert.status==='running')} onClick={()=>void api.stop().catch(e=>setMessage(String(e)))}>停止评测</button>
    <h4>人工评审</h4><p>七项各 0–5 分，平均分达到 4 分计为达标。比例仅包含已评分结果，引用准确率仅包含适用项。</p>
    {[...comparisonGroups].map(([key,group])=>{const sample=group[0];return <div key={key}><strong>{profiles.find(p=>p.id===sample.case.profileId)?.name ?? sample.case.profileId} · {sample.runtime} · {sample.provider} · {sample.model} · {sample.effort ?? '默认强度'} · {sample.profileHash.slice(0,8)}</strong>{(['baseline','expert'] as const).map(arm=>{
      const grades=group.flatMap(r=>r[arm].grade?[r[arm].grade!]:[]),scores=grades.map(g=>average(g.scores));
      return <p key={arm}>{arm==='expert'?'专家':'普通'} · 已评 {grades.length}/{group.length} · 均分 {scores.length?average(scores).toFixed(2):'—'} · 达标 {pct(scores.filter(n=>n>=4).length,scores.length)} · 引用正确 {pct(grades.filter(g=>g.citation==='正确').length,grades.filter(g=>g.citation!=='不适用').length)} · 产品错配 {pct(grades.filter(g=>g.mismatch).length,grades.length)} · 完整 {pct(grades.filter(g=>g.complete).length,grades.length)}</p>;
    })}</div>;})}
    {visible.map(r=><details key={r.id}><summary>{r.case.product} · {r.case.prompt} · {r.baseline.status}/{r.expert.status}</summary><p>{r.createdAt} · {r.runtime} · {r.provider} · {r.model} · {r.effort} · {r.profileId} v{r.profileVersion}</p><p>预期 · {r.case.expected}</p><p>参考 · {r.case.reference}</p><p>检索来源 · {r.sources.map(s=>s.label).join('、')||'无'}</p>{(['baseline','expert'] as const).map(arm=><Review key={arm} run={r} arm={arm} save={g=>void act(()=>api.grade(r.id,arm,g))}/>)}</details>)}
    {!visible.length && <p>当前筛选范围尚无评测结果。</p>}<div className="expert-actions">{(['json','md'] as const).map(f=><button key={f} onClick={()=>void act(()=>api.export(f))}>导出 {f.toUpperCase()}</button>)}</div></>}
  </section>;
}
