import {useCallback,useEffect,useState} from 'react';import './styles.css';
const api=(u:string)=>fetch(u).then(r=>r.json());
const post=(u:string,body?:unknown)=>fetch(u,body===undefined?{method:'POST'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
const STATUS:Record<string,string>={draft:'草稿',review:'复核中',approved:'已签发',released:'已放行'};
const QA_METHOD:Record<string,string>={independent_mu:'独立 MU 复算',gamma:'γ 通过率分析',image_guidance:'影像引导验证'};
const ACTION:Record<string,string>={plan_approved:'计划签发',plan_approve_blocked:'签发被阻断',plan_released:'计划放行',plan_release_blocked:'放行被阻断',peer_review:'同行复核记录',peer_checklist:'复核清单更新',independent_check:'独立剂量验证',adaptive_evaluation:'自适应评估',fraction_delivered:'分次治疗',deviation_opened:'偏差登记',deviation_resolved:'偏差关闭'};
const describe=(e:any)=>[e.planId,e.reason==='not_approved'?'计划尚未签发':'',e.blockers?.length?`阻断：${e.blockers.join('；')}`:'',e.item?`${e.item} → ${e.checked?'已勾选':'取消勾选'}`:'',e.method?`${QA_METHOD[e.method]??e.method} · ${String(e.status).toUpperCase()}`:'',e.severity?`${e.severity==='high'?'高':e.severity==='medium'?'中':'低'} · ${e.category}`:'',e.deviationId??'',e.fraction!=null?`第 ${e.fraction} 次`:''].filter(Boolean).join(' · ');
export default function App(){
  const [tab,setTab]=useState('dose');const [patient,setPatient]=useState<any>();const [plans,setPlans]=useState<any[]>([]);const [active,setActive]=useState('PLAN-A');
  const [constraints,setConstraints]=useState<any>();const [dossier,setDossier]=useState<any>();const [compare,setCompare]=useState<any>();const [slice,setSlice]=useState<any>();const [auditLog,setAuditLog]=useState<any[]>([]);
  const [reviewer,setReviewer]=useState('');const [busy,setBusy]=useState(false);const [notice,setNotice]=useState('');
  const [qaMethod,setQaMethod]=useState('independent_mu');const [qaScore,setQaScore]=useState('2.2');
  const [devSeverity,setDevSeverity]=useState('high');const [devCategory,setDevCategory]=useState('');const [devDetail,setDevDetail]=useState('');
  const refresh=useCallback(async(id:string)=>{const[pl,c,d,a]=await Promise.all([api('/api/plans'),api(`/api/plans/${id}/constraints`),api(`/api/plans/${id}/verification-dossier`),api('/api/audit')]);setPlans(pl);setConstraints(c);setDossier(d?.error?undefined:d);setAuditLog(Array.isArray(a)?a:[])},[]);
  useEffect(()=>{api('/api/patient/current').then(setPatient);api('/api/compare').then(setCompare)},[]);
  useEffect(()=>{if(active){setNotice('');refresh(active);api(`/api/plans/${active}/dose-slice?index=12`).then(setSlice)}},[active,refresh]);
  const act=async(fn:()=>Promise<any>)=>{if(busy)return;setBusy(true);try{await fn();await refresh(active)}catch{setNotice('请求失败，请稍后重试')}finally{setBusy(false)}};
  const approve=()=>act(async()=>{const r=await post(`/api/plans/${active}/approve`);setNotice(r.approved?(r.already?'计划已处于签发状态，重复请求未产生新记录':'计划已签发，可进入放行流程'):`签发被阻断：${(r.blockers??[]).join('；')}`)});
  const release=()=>act(async()=>{const r=await post(`/api/plans/${active}/release`);setNotice(r.released?(r.already?'计划已完成放行，重复请求未产生新记录':'放行完成，计划可用于治疗'):r.error==='not_approved'?'放行被阻断：计划尚未签发，请先完成签发':`放行被阻断：${(r.blockers??[]).join('；')}`)});
  const recordReview=()=>act(async()=>{await post(`/api/plans/${active}/peer-review`,{reviewer:reviewer||'未署名复核人',note:'已完成剂量约束复核'});setNotice('同行复核已记录')});
  const toggleItem=(item:string,checked:boolean)=>act(async()=>{await post(`/api/plans/${active}/peer-checklist`,{item,checked,reviewer:reviewer||'未署名复核人'});setNotice(checked?`已勾选：${item}`:`已取消勾选：${item}`)});
  const runQa=()=>act(async()=>{const r=await post(`/api/plans/${active}/independent-check`,{method:qaMethod,score:Number(qaScore)});setNotice(r.error?'计划不存在':`已记录 ${QA_METHOD[r.method]??r.method}：${r.status==='pass'?'通过':r.status==='warn'?'警告':'失败'}${r.status==='fail'?'，签发与放行将被阻断':''}`)});
  const addDeviation=()=>act(async()=>{if(!devCategory||!devDetail){setNotice('请填写偏差类别与描述');return}await post(`/api/plans/${active}/deviations`,{severity:devSeverity,category:devCategory,detail:devDetail});setDevCategory('');setDevDetail('');setNotice('已登记偏差，高等级偏差将阻断签发与放行')});
  const resolveDeviation=(id:string)=>act(async()=>{await post(`/api/plans/${active}/deviations/${id}/resolve`);setNotice(`偏差 ${id} 已关闭`)});
  const plan=plans.find(p=>p.id===active);const gate=dossier?.gate;
  return <main>
    <header><div><span className="eyebrow">RADIATION ONCOLOGY / PLAN QA</span><h1>放射治疗剂量计划验证与器官风险评估系统</h1><p>{patient?.patient?.id} · {patient?.patient?.diagnosis} · 处方 {patient?.patient?.rxDose} Gy / {patient?.patient?.fractions} 次</p></div><div className="badge">物理师复核模式</div></header>
    <nav>{[['dose','剂量阅片'],['constraints','约束校验'],['compare','计划对比'],['release','放行档案']].map(([id,label])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    <section className="toolbar">
      <label>当前计划<select value={active} onChange={e=>setActive(e.target.value)}>{plans.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <div className="statusGroup"><span className={`chip st-${plan?.status}`}>{STATUS[plan?.status]??'—'}</span><span className={`planStatus ${gate}`}>{gate==='ready'?'放行门禁通过':'存在阻断项'}</span></div>
    </section>
    {notice&&<div className="notice">{notice}</div>}
    {tab==='dose'&&<section className="grid">
      <div className="panel imagePanel"><div className="panelHead"><h2>断层切片剂量叠加</h2><span>切片 12 / 32 · 等剂量线：20 / 50 / 95%</span></div><div className="slice">{slice?.data.map((row:number[],y:number)=>row.map((v:number,x:number)=><span key={`${x}-${y}`} style={{background:`hsl(${Math.max(0,240-v*2.2)},${v>80?88:55}%,${25+v*.45}%)`}}/>))}</div><div className="doseLegend"><span style={{background:'#244bd5'}}/>低剂量 <span style={{background:'#f3bb35'}}/>中剂量 <span style={{background:'#ef555b'}}/>高剂量</div></div>
      <div className="panel"><div className="panelHead"><h2>计划参数</h2><span>{active}</span></div>{plan&&Object.entries(plan).filter(([k])=>!['id','status'].includes(k)).map(([k,v])=><div className="kv" key={k}><span>{k}</span><b>{String(v)}</b></div>)}<div className="callout">剂量验证不是单一通过/失败判断，需要同时审查靶区覆盖、危及器官受量、机器跳数和算法版本。</div></div>
    </section>}
    {tab==='constraints'&&<section className="grid">
      <div className="panel"><div className="panelHead"><h2>结构约束校验</h2><span>DVH 指标自动计算</span></div>{constraints?.checks.map((x:any)=><div className="constraint" key={x.structureId}><div><b>{x.name}</b><small>{x.metric} · 限值 {x.limit}{x.unit}</small></div><strong className={x.pass?'pass':'fail'}>{x.value}{x.unit}</strong><span>{x.pass?'PASS':'FAIL'}</span></div>)}</div>
      <div className="panel"><div className="panelHead"><h2>DVH 曲线摘要</h2><span>体积-剂量关系</span></div>{patient?.structures.map((s:any)=><div className="bar" key={s.id}><span>{s.name}</span><div><i style={{width:`${Math.min(100,(constraints?.checks.find((x:any)=>x.structureId===s.id)?.value??0))}%`}}/></div><b>{constraints?.checks.find((x:any)=>x.structureId===s.id)?.value}</b></div>)}
        <div className="review"><input placeholder="复核人姓名" value={reviewer} onChange={e=>setReviewer(e.target.value)}/><button disabled={busy} onClick={recordReview}>记录同行复核</button><button disabled={busy||gate!=='ready'} onClick={approve}>签发计划</button></div>
        {gate==='blocked'&&<div className="blockers"><b>签发门禁未通过（与放行档案口径一致）：</b>{dossier?.blockers.map((b:string)=><span key={b}>· {b}</span>)}<span className="hint">请在「放行档案」页完成清单、QA 与偏差处理后重试。</span></div>}
      </div>
    </section>}
    {tab==='compare'&&<section className="panel"><div className="panelHead"><h2>计划对比与选择</h2><span>同一患者、不同照射技术</span></div><div className="compareGrid">{compare?.plans.map((p:any)=><div key={p.id} className={`compareCard ${p.id===active?'selected':''}`} onClick={()=>setActive(p.id)}><h3>{p.label}</h3><strong>{p.targetCoverage}%</strong><small>PTV D95 覆盖</small><p>MU {p.mu} · 约束失败 {p.checks.filter((x:any)=>!x.pass).length} 项</p>{p.checks.map((x:any)=><div key={x.structureId} className={x.pass?'tinyPass':'tinyFail'}>{x.name}: {x.value}{x.unit}</div>)}</div>)}</div><div className="recommend">系统建议：{compare?.recommendation}</div></section>}
    {tab==='release'&&<section className="grid">
      <div className="panel">
        <div className="panelHead"><h2>放行门禁</h2><span>计划状态：{STATUS[dossier?.releaseState]??'—'}</span></div>
        {dossier&&(gate==='ready'
          ?<div className="gateBanner ready">全部门禁满足{dossier.releaseState==='released'?'，计划已放行':dossier.releaseState==='approved'?'，计划已签发，可执行放行':'，可签发计划'}</div>
          :<div className="gateBanner blocked">存在 {dossier.blockers.length} 项阻断，签发与放行均不可用</div>)}
        {dossier?.blockers.map((b:string)=><div className="blockerRow" key={b}>{b}</div>)}
        <div className="review"><button disabled={busy||gate!=='ready'||dossier?.releaseState==='approved'||dossier?.releaseState==='released'} onClick={approve}>签发计划</button><button disabled={busy||gate!=='ready'||dossier?.releaseState!=='approved'} onClick={release}>完成放行</button></div>
        <h3 className="sub">同行复核清单（门禁项）</h3>
        {dossier?.requiredChecklist.map((item:string)=>{const entry=dossier.checklist.find((x:any)=>x.item===item);const checked=!!entry?.checked;return <div className="checkRow" key={item}><span className={checked?'ok':'pending'}>{checked?'✓':'○'}</span><div><b>{item}</b><small>{entry?`${entry.reviewer} · ${new Date(entry.at).toLocaleString()}`:'待复核'}</small></div><button disabled={busy} onClick={()=>toggleItem(item,!checked)}>{checked?'取消勾选':'勾选'}</button></div>})}
        <h3 className="sub">独立剂量验证（QA，按方法取最新一次）</h3>
        {dossier?.qa.map((q:any)=><div className="qaRow" key={q.id}><b>{q.id}</b><span>{QA_METHOD[q.method]??q.method}</span><strong className={q.status==='pass'?'pass':q.status==='warn'?'warnTxt':'fail'}>{q.status.toUpperCase()}</strong><small>{q.detail} · {new Date(q.createdAt).toLocaleString()}</small></div>)}
        <div className="inlineForm"><select value={qaMethod} onChange={e=>setQaMethod(e.target.value)}><option value="independent_mu">独立 MU 复算</option><option value="gamma">γ 通过率分析</option><option value="image_guidance">影像引导验证</option></select><input value={qaScore} onChange={e=>setQaScore(e.target.value)} placeholder="差异 % / γ 通过率 %"/><button disabled={busy} onClick={runQa}>提交 QA</button></div>
      </div>
      <div className="panel">
        <div className="panelHead"><h2>偏差与递送</h2><span>高等级偏差未关闭将阻断</span></div>
        <div className="kv"><span>已递送分次</span><b>{dossier?.deliverySummary.fractions??0} / {patient?.patient.fractions}</b></div>
        <div className="kv"><span>累积剂量</span><b>{dossier?.deliverySummary.cumulativeDose??0} / {dossier?.deliverySummary.prescriptionDose} Gy</b></div>
        <div className="kv"><span>放射性肺炎风险 NTCP</span><b>{dossier?.ntcp.lungPneumonitis}%</b></div>
        <div className="kv"><span>心脏事件风险 NTCP</span><b>{dossier?.ntcp.heartEvent}%</b></div>
        <h3 className="sub">偏差登记</h3>
        {dossier?.deviations.length===0&&<p className="empty">暂无偏差记录</p>}
        {dossier?.deviations.map((d:any)=><div className="devRow" key={d.id}><span className={`sev ${d.severity}`}>{d.severity==='high'?'高':d.severity==='medium'?'中':'低'}</span><div><b>{d.id} · {d.category}</b><small>{d.detail} · {d.state==='open'?'未关闭':'已关闭'}</small></div>{d.state==='open'&&<button disabled={busy} onClick={()=>resolveDeviation(d.id)}>关闭</button>}</div>)}
        <div className="inlineForm"><select value={devSeverity} onChange={e=>setDevSeverity(e.target.value)}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select><input placeholder="类别" value={devCategory} onChange={e=>setDevCategory(e.target.value)}/><input placeholder="描述" value={devDetail} onChange={e=>setDevDetail(e.target.value)}/><button disabled={busy} onClick={addDeviation}>登记</button></div>
        <h3 className="sub">审计追踪</h3>
        <div className="auditList">{auditLog.filter(a=>!a.planId||a.planId===active).slice(0,14).map((a:any,i:number)=><div className="auditRow" key={i}><small>{new Date(a.at).toLocaleString()}</small><b>{ACTION[a.action]??a.action}</b><span>{describe(a)}</span></div>)}</div>
      </div>
    </section>}
  </main>;
}
