import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import type { Session } from '../packages/domain/src';
import { LocalStore } from '../packages/storage/src';
import { benchmarkCases } from '../packages/expert-engine/src/cases';
import { builtinProfiles, resolveExpert, expertInstructions } from '../packages/expert-engine/src';
import { registerExpertCenter } from '../apps/desktop/src/main/expert-center';

const auto = {profileId:'auto',scope:'auto'} as const;
test('两个家族八个岗位按当轮输入切换，40 个匿名案例独立解析',()=>{
  assert.equal(builtinProfiles.filter(p=>p.role).length,8);
  assert.equal(benchmarkCases.length,40);
  for (const c of benchmarkCases) {
    const r = resolveExpert(builtinProfiles,{projectId:'p',system:c.product},auto,c.prompt);
    assert.equal(r.profile?.id,c.profileId,c.prompt);
    assert.deepEqual(r.scope,[c.product,'COMMON']);
    assert.ok(expertInstructions(r).includes(r.profile!.output));
  }
});
test('手动家族仅在本家族路由，显式角色优先，已停用、未知产品与损坏档案安全降级',()=>{
  const session = {system:'MES6',projectId:'p'} as const;
  assert.equal(resolveExpert(builtinProfiles,session,{...auto,profileId:'project-delivery'},'后端接口').profile?.id,'project-delivery');
  assert.equal(resolveExpert(builtinProfiles,session,{...auto,profileId:'project-manager'},'@后端开发专家 检查事务').profile?.role,'backend_developer');
  assert.equal(resolveExpert(builtinProfiles,{system:'前端',projectId:'p'},auto,'WMS 页面').profile,undefined);
  assert.equal(resolveExpert(builtinProfiles,{},auto,'通用问题').profile,undefined);
  assert.deepEqual(resolveExpert(builtinProfiles,session,auto,'比较 WMS 操作').scope,['MES6','COMMON']);
  assert.equal(resolveExpert(builtinProfiles.map(p=>p.role==='backend_developer'?{...p,output:'被篡改'}:p),session,auto,'后端事务').profile,undefined);
  assert.equal(expertInstructions(resolveExpert(builtinProfiles,session,{...auto,profileId:'off'},'后端事务')),'');
});

test('v17 升级保留会话并备份原始字节，持久化档案、隔离来源、同条件双臂评测与人工评分',async()=>{
  const directory = await mkdtemp(path.join(tmpdir(),'jinggong-expert-')), filename=path.join(directory,'test.db');
  let store = await LocalStore.open(filename);
  const session:Session = {id:'session-a',model:'demo',providerId:'p',runtimeKind:'codex',workspacePath:directory,createdAt:new Date().toISOString(),status:'idle',title:'旧会话'};
  const previousFetch = globalThis.fetch;
  try {
    store.saveSession(session);store.close();
    const sql = await initSqlJs(), db = new sql.Database(await readFile(filename));
    db.run('DROP TABLE expert_profiles; DROP TABLE expert_runs; DROP TABLE expert_bindings; DROP TABLE expert_eval_runs; DROP TABLE expert_eval_cases; PRAGMA user_version=17');
    const before=Buffer.from(db.export());db.close();await writeFile(filename,before);
    store=await LocalStore.open(filename);
    const backup=(await readdir(directory)).find(n=>n.includes('pre-v19-from-v17-'));
    assert.deepEqual(await readFile(path.join(directory,backup!)),before);
    const handlers=new Map<string,(...args:any[])=>any>();
    const call=(name:string,...args:any[])=>handlers.get('experts:'+name)!(...args);
    const sessionById=(value:unknown)=>{const item=store.getSession(String(value));if(!item)throw new Error('无会话');return item;};
    registerExpertCenter({store,handle:(k,v)=>handlers.set(k,v),session:sessionById,idle:()=>{},directory,manuals:()=>undefined,manualEnabled:()=>false,
      credentials:()=>({provider:'p',apiKey:'unit-test',baseUrl:'https://unit.invalid'}),secrets:()=>[],redact:v=>v,exportPath:async()=>undefined});
    assert.deepEqual(call('session',session.id).selection,auto);
    const copy=call('profile','copy','mes-wms-backend').find((p:any)=>!p.builtin);
    call('profile','edit',copy.id,{name:'后端评审',output:'验证事务',steps:['检查源码'],version:1});
    assert.throws(()=>call('profile','edit',copy.id,{name:'过期',output:'旧',steps:['旧'],version:1}),/版本/);
    assert.throws(()=>call('profile','edit','mes-wms-backend',{}),/复制/);
    call('select',session.id,{profileId:copy.id,scope:'WMS'});
    assert.equal(store.getSession(session.id)?.system,undefined);
    assert.throws(()=>call('select',session.id,{profileId:'missing',scope:'WMS'}),/不存在/);
    assert.throws(()=>call('save-case',{...benchmarkCases[0],prompt:'password=secret123'}),/敏感/);
    type RequestBody={instructions:string;input:any[];model:string;tools:{name:string}[]};
    const payloads:RequestBody[]=[];
    globalThis.fetch=async (_url,init)=>{
      payloads.push(JSON.parse(String(init?.body)));
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'测试替身结果'}]}]});
    };
    await call('compare',session.id,benchmarkCases[0].id,'mes-wms-requirements');
    assert.equal(payloads.length,2);assert.equal(payloads[0].model,payloads[1].model);assert.deepEqual(payloads[0].input,payloads[1].input);
    assert.deepEqual(payloads[0].tools,payloads[1].tools);assert.ok(payloads[0].tools.every(t=>!/(shell|write|agent_task)/.test(t.name)));
    assert.ok(!payloads[0].instructions.includes('【本轮专业工作流】'));assert.ok(payloads[1].instructions.includes('【本轮专业工作流】'));
    const record=store.expertComparisons()[0];assert.equal(record.expert.status,'completed');assert.equal(record.baseline.answer,'测试替身结果');
    call('grade',record.id,'expert',{scores:[3,4,5,2,3,4,5],citation:'不适用',mismatch:false,complete:true,notes:'人工样例'});
    const speakers = [undefined, {id:copy.id,name:'后端评审'}, {id:'project-manager',name:'项目经理专家'}];
    speakers.forEach((expert,index)=>store.appendEvent({
      id:'answer-'+index, sessionId:session.id, type:index===1?'delta':'message',
      text:'测试回复', createdAt:new Date().toISOString(), expert
    }));
    store.close();store=await LocalStore.open(filename);
    assert.deepEqual(store.events(session.id).map(event=>event.expert),speakers);
    assert.equal(store.expertComparisons()[0].expert.grade?.scores.length,7);
    assert.equal(store.expertProfiles().length,11);assert.equal(store.expertCases().length,40);
    assert.equal(store.expertSelection(session.id).profileId,copy.id);
    store.deleteSession(session.id);assert.deepEqual(store.expertSelection(session.id),auto);
  } finally {globalThis.fetch=previousFetch;store.close();await rm(directory,{recursive:true,force:true});}
});
