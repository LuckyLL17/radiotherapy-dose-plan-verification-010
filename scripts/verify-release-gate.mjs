// 端到端验证：计划状态、签发/放行门禁、放行档案与审计记录的一致性。
// 运行前提：API 已在 127.0.0.1:6202 启动（全新内存状态）。用法：node scripts/verify-release-gate.mjs
const base=process.env.API_BASE??'http://127.0.0.1:6202';
const get=u=>fetch(base+u).then(r=>r.json());
const post=(u,b)=>fetch(base+u,b===undefined?{method:'POST'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
let failures=0;
const check=(name,cond,extra='')=>{console.log(`${cond?'PASS':'FAIL'}  ${name}${extra?`  — ${extra}`:''}`);if(!cond)failures++;};
const REQUIRED=['靶区轮廓与处方一致性','危及器官约束复核','束角与碰撞检查','独立剂量验证'];

// 场景 1：清单缺项 —— 约束全部通过，但签发必须被清单阻断，计划状态不得改变
let d=await get('/api/plans/PLAN-A/verification-dossier');
check('初始门禁 blocked（清单缺项）',d.gate==='blocked'&&d.blockers.filter(b=>b.startsWith('同行复核缺失')).length===4,JSON.stringify(d.blockers));
let r=await post('/api/plans/PLAN-A/approve');
check('清单缺项时签发被拒绝',r.approved===false&&r.blockers.some(b=>b.includes('同行复核缺失')));
let plans=await get('/api/plans');
check('签发被拒后计划状态仍为 review',plans.find(p=>p.id==='PLAN-A').status==='review');

// 场景 2：QA 失败 —— 清单补齐后，失败 QA 阻断签发
for(const item of REQUIRED)await post('/api/plans/PLAN-A/peer-checklist',{item,checked:true,reviewer:'验证脚本'});
d=await get('/api/plans/PLAN-A/verification-dossier');
check('清单补齐后门禁 ready',d.gate==='ready'&&d.blockers.length===0);
const qaFail=await post('/api/plans/PLAN-A/independent-check',{method:'gamma',score:80});
check('QA 复测判定为 fail',qaFail.status==='fail');
r=await post('/api/plans/PLAN-A/approve');
check('QA 失败时签发被拒绝',r.approved===false&&r.blockers.some(b=>b.includes('QA 失败')),JSON.stringify(r.blockers));

// 场景 3：恢复 —— QA 复测通过（按方法取最新一次），签发成功
await post('/api/plans/PLAN-A/independent-check',{method:'gamma',score:97.5});
d=await get('/api/plans/PLAN-A/verification-dossier');
check('QA 复测通过后门禁恢复 ready',d.gate==='ready');
r=await post('/api/plans/PLAN-A/approve');
check('门禁满足后签发成功',r.approved===true&&r.plan.status==='approved');

// 场景 4：重复请求 —— 重复签发幂等，不产生重复审计
r=await post('/api/plans/PLAN-A/approve');
check('重复签发幂等返回 already',r.approved===true&&r.already===true);
let audits=await get('/api/audit');
check('plan_approved 审计仅一条',audits.filter(a=>a.action==='plan_approved').length===1);

// 场景 5：高等级偏差 —— 已签发但放行被阻断，状态不倒退也不前进
await post('/api/plans/PLAN-A/deviations',{severity:'high',category:'chart_review',detail:'验证脚本：计划单与处方不一致'});
r=await post('/api/plans/PLAN-A/release');
check('高等级偏差未关闭时放行被拒绝',r.released===false&&r.blockers.some(b=>b.includes('未关闭偏差')),JSON.stringify(r.blockers));
plans=await get('/api/plans');
check('放行被拒后计划状态保持 approved',plans.find(p=>p.id==='PLAN-A').status==='approved');
r=await post('/api/plans/PLAN-A/release');
check('阻断期间重复放行仍被拒绝且一致',r.released===false&&r.gate==='blocked');

// 场景 6：恢复后重新放行 —— 关闭偏差，放行成功；重复放行幂等
r=await post('/api/plans/PLAN-A/deviations/DEV-1/resolve');
check('偏差关闭成功',r.ok===true&&r.deviation.state==='resolved');
d=await get('/api/plans/PLAN-A/verification-dossier');
check('偏差关闭后门禁 ready',d.gate==='ready'&&d.blockers.length===0);
r=await post('/api/plans/PLAN-A/release');
check('恢复后放行成功',r.released===true&&r.releaseState==='released');
r=await post('/api/plans/PLAN-A/release');
check('重复放行幂等返回 already',r.released===true&&r.already===true);
audits=await get('/api/audit');
check('plan_released 审计仅一条',audits.filter(a=>a.action==='plan_released').length===1);

// 场景 7：刷新一致性 —— 重新拉取后页面、接口、审计互相解释
plans=await get('/api/plans');
d=await get('/api/plans/PLAN-A/verification-dossier');
const c=await get('/api/plans/PLAN-A/constraints');
check('刷新后状态一致：released + 门禁 ready + 约束全过',plans.find(p=>p.id==='PLAN-A').status==='released'&&d.gate==='ready'&&d.releaseState==='released'&&c.gate==='ready');

// 场景 8：约束失败计划 —— 签发被拒；未签发不得放行
r=await post('/api/plans/PLAN-B/approve');
check('约束失败时签发被拒绝（脊髓 Dmax 超限）',r.approved===false&&r.blockers.some(b=>b.includes('脊髓')),JSON.stringify(r.blockers));
r=await post('/api/plans/PLAN-B/release');
check('未签发的计划放行被拒绝（not_approved）',r.released===false&&r.error==='not_approved');

// 场景 9：治疗递送触发高等级偏差 —— 阻断出现；重复分次被拒；关闭后阻断消除
d=await post('/api/plans/PLAN-B/delivery/fractions',{fraction:1,deliveredGy:2,setupShift:{x:6,y:0,z:0}});
check('大摆位偏移自动生成高等级偏差并进入阻断',d.blockers.some(b=>b.includes('未关闭偏差：setup_shift')));
r=await post('/api/plans/PLAN-B/delivery/fractions',{fraction:1,deliveredGy:2,setupShift:{x:1,y:0,z:0}});
check('重复分次递送被拒绝',r.ok===false&&r.error==='duplicate_fraction');
r=await post('/api/plans/PLAN-B/deviations/DEV-2/resolve');
check('递送偏差可关闭',r.ok===true);
d=await get('/api/plans/PLAN-B/verification-dossier');
check('偏差关闭后阻断消除（约束失败仍在）',!d.blockers.some(b=>b.includes('未关闭偏差'))&&d.blockers.some(b=>b.includes('脊髓')));

// 场景 10：审计可解释 —— 关键事件齐全、顺序正确、阻断记录带原因
audits=await get('/api/audit');
const actions=audits.map(a=>a.action);
check('审计包含签发/放行/阻断/偏差全链路',['plan_approved','plan_released','plan_approve_blocked','plan_release_blocked','deviation_opened','deviation_resolved'].every(a=>actions.includes(a)));
check('审计按时间倒序（放行记录在签发之前出现）',actions.indexOf('plan_released')<actions.indexOf('plan_approved'));
check('阻断类审计均携带原因',audits.filter(a=>a.action.endsWith('_blocked')).every(a=>Array.isArray(a.blockers)||a.reason==='not_approved'));

console.log(failures?`\n${failures} 项检查失败`:'\n全部检查通过');
process.exit(failures?1:0);
