import Fastify from 'fastify';
import cors from '@fastify/cors';

type Structure = {
  id: string; name: string; type: 'target' | 'organ'; volume: number;
  priority: 'high' | 'medium' | 'low';
  constraint: { metric: 'D95' | 'Dmax' | 'V20'; limit: number; unit: string };
};
type PlanStatus = 'draft' | 'review' | 'approved' | 'released';
type Plan = {
  id: string; label: string; beamCount: number; energy: string;
  algorithm: string; mu: number; createdAt: string; status: PlanStatus;
};
type QaRun = {
  id: string; planId: string;
  method: 'independent_mu' | 'gamma' | 'image_guidance';
  status: 'pass' | 'warn' | 'fail'; score: number; detail: string;
  createdAt: string; active: boolean;
};
type ChecklistItem = { item: string; checked: boolean; reviewer: string; at: string };
type Deviation = {
  id: string; planId: string; severity: 'low' | 'medium' | 'high';
  category: string; detail: string; state: 'open' | 'resolved';
  createdAt: string; resolvedAt?: string;
};
type GateCode = 'constraint_failed' | 'qa_failed' | 'peer_review_missing' | 'high_deviation_open' | 'plan_not_approved';
type GateReason = { code: GateCode; message: string };

const patient = { id: 'PT-2026-0917', name: '示例患者', diagnosis: '肺部肿瘤（演示数据）', site: '右肺下叶', fractions: 30, rxDose: 60 };
const structures: Structure[] = [
  { id: 'PTV', name: 'PTV-60', type: 'target', volume: 84, priority: 'high', constraint: { metric: 'D95', limit: 95, unit: '%' } },
  { id: 'LUNG', name: '双肺-PTV', type: 'organ', volume: 4200, priority: 'high', constraint: { metric: 'V20', limit: 25, unit: '%' } },
  { id: 'HEART', name: '心脏', type: 'organ', volume: 720, priority: 'high', constraint: { metric: 'V20', limit: 15, unit: '%' } },
  { id: 'CORD', name: '脊髓', type: 'organ', volume: 58, priority: 'high', constraint: { metric: 'Dmax', limit: 45, unit: 'Gy' } },
  { id: 'ESOPH', name: '食管', type: 'organ', volume: 88, priority: 'medium', constraint: { metric: 'Dmax', limit: 50, unit: 'Gy' } },
];
const plans: Plan[] = [
  { id: 'PLAN-A', label: 'VMAT 主计划', beamCount: 2, energy: '6MV FFF', algorithm: 'Acuros XB 18.0', mu: 634, createdAt: '2026-09-30T08:20:00Z', status: 'review' },
  { id: 'PLAN-B', label: 'IMRT 对照计划', beamCount: 7, energy: '6MV', algorithm: 'AAA 16.1', mu: 712, createdAt: '2026-09-29T16:40:00Z', status: 'draft' },
];
const audits: Array<Record<string, unknown>> = [];
const REQUIRED_CHECKLIST = ['靶区轮廓与处方一致性', '危及器官约束复核', '束角与碰撞检查', '独立剂量验证'];
const QA_METHOD_LABEL: Record<QaRun['method'], string> = {
  independent_mu: '独立 MU 复算', gamma: 'Gamma 通过率', image_guidance: '影像引导核验',
};

function audit(entry: Record<string, unknown>) {
  audits.unshift({ at: new Date().toISOString(), ...entry });
}

function metrics(plan: Plan) {
  const bias = plan.id === 'PLAN-A' ? 0 : 3;
  return structures.map(s => {
    let value = s.type === 'target' ? 96.4 - bias
      : s.id === 'LUNG' ? 21.3 + bias
      : s.id === 'HEART' ? 10.2 + bias * .7
      : s.id === 'CORD' ? 42.1 + bias * 1.1
      : 46.8 + bias;
    return {
      structureId: s.id, name: s.name, metric: s.constraint.metric,
      value: +value.toFixed(2), limit: s.constraint.limit, unit: s.constraint.unit,
      pass: value <= s.constraint.limit || s.type === 'target',
      delta: +(value - s.constraint.limit).toFixed(2), doseVolume: s.volume,
    };
  });
}
function dvh(plan: Plan) {
  return structures.map(s => ({
    structureId: s.id, name: s.name,
    points: Array.from({ length: 11 }, (_, i) => ({
      dose: +(i * plan.mu / 110).toFixed(1),
      volume: +(100 - i * (s.type === 'target' ? 8.3 : 10.6)).toFixed(1),
    })),
  }));
}
function slice(index: number) {
  return Array.from({ length: 32 }, (_, y) => Array.from({ length: 32 }, (_, x) => {
    const lung = Math.pow(x - 11, 2) + Math.pow(y - 16, 2) < 105 || Math.pow(x - 23, 2) + Math.pow(y - 15, 2) < 90;
    const tumor = Math.pow(x - 22, 2) + Math.pow(y - 18, 2) < 12;
    const dose = tumor ? 95 : lung ? 48 + Math.max(0, 25 - Math.abs(x - 18)) * 1.4 : 10;
    return Math.round(dose + Math.sin((x + index) * .7) * 3);
  }));
}

const qaRuns: QaRun[] = [
  { id: 'QA-071', planId: 'PLAN-A', method: 'independent_mu', status: 'pass', score: 1.7, detail: '独立 MU 复算差异 1.7%，低于 3% 阈值', createdAt: '2026-09-30T09:16:00Z', active: true },
  { id: 'QA-072', planId: 'PLAN-A', method: 'gamma', status: 'pass', score: 98.4, detail: '3%/3mm γ 通过率 98.4%，高于 95% 阈值', createdAt: '2026-09-30T09:23:00Z', active: true },
];
const peerChecklist = new Map<string, ChecklistItem[]>();
const deliveries = new Map<string, Array<{ fraction: number; deliveredGy: number; setupShift: { x: number; y: number; z: number }; at: string }>>();
const deviations: Deviation[] = [];

// 唯一的放行门禁评估：约束页、签发接口、放行接口、放行档案全部以此为准
function evaluateGate(plan: Plan) {
  const checks = metrics(plan);
  const failedChecks = checks.filter(x => !x.pass);
  const failedQa = qaRuns.filter(x => x.planId === plan.id && x.active && x.status === 'fail');
  const checklist = peerChecklist.get(plan.id) ?? [];
  const missingChecklist = REQUIRED_CHECKLIST.filter(
    item => !checklist.some(x => x.item === item && x.checked),
  );
  const openHighDeviations = deviations.filter(
    x => x.planId === plan.id && x.severity === 'high' && x.state === 'open',
  );
  const reasons: GateReason[] = [
    ...failedChecks.map(x => ({ code: 'constraint_failed' as const, message: `${x.name} 约束失败（${x.metric} ${x.value}${x.unit} / 限值 ${x.limit}${x.unit}）` })),
    ...failedQa.map(x => ({ code: 'qa_failed' as const, message: `${QA_METHOD_LABEL[x.method]} QA 失败：${x.detail}` })),
    ...missingChecklist.map(x => ({ code: 'peer_review_missing' as const, message: `同行复核缺失：${x}` })),
    ...openHighDeviations.map(x => ({ code: 'high_deviation_open' as const, message: `未关闭高等级偏差：${x.category}（${x.detail}）` })),
  ];
  return {
    gate: reasons.length ? ('blocked' as const) : ('ready' as const),
    blockers: reasons.map(x => x.message),
    reasons,
    failedChecks,
    failedQa,
    missingChecklist,
    openHighDeviations,
  };
}

function releaseDossier(planId: string) {
  const plan = plans.find(p => p.id === planId);
  if (!plan) return { error: 'plan_not_found' as const };
  const gate = evaluateGate(plan);
  const qa = qaRuns.filter(x => x.planId === planId);
  const checklist = peerChecklist.get(planId) ?? [];
  const delivery = deliveries.get(planId) ?? [];
  const planDeviations = deviations.filter(x => x.planId === planId);
  const lungV20 = metrics(plan).find(x => x.structureId === 'LUNG')!;
  const heartV20 = metrics(plan).find(x => x.structureId === 'HEART')!;
  return {
    plan,
    checks: metrics(plan),
    qa,
    checklist,
    requiredChecklist: REQUIRED_CHECKLIST,
    deviations: planDeviations,
    deliverySummary: {
      fractions: delivery.length,
      cumulativeDose: +delivery.reduce((s, x) => s + x.deliveredGy, 0).toFixed(2),
      prescriptionDose: patient.rxDose,
    },
    ...gate,
    ntcp: {
      lungPneumonitis: +Math.max(1, Math.min(35, lungV20.value * 1.08)).toFixed(1),
      heartEvent: +Math.max(.2, Math.min(20, heartV20.value * .46)).toFixed(1),
    },
  };
}

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

app.get('/api/health', async () => ({ status: 'ok', service: 'radiotherapy-dose-plan-verification' }));
app.get('/api/patient/current', async () => ({ patient, structures }));
app.get('/api/plans', async () => plans);
app.get('/api/plans/:id/dose-slice', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!plans.some(p => p.id === id)) return reply.code(404).send({ error: 'plan_not_found' });
  const q = req.query as { index?: string };
  return { planId: id, index: Number(q.index ?? 12), size: 32, data: slice(Number(q.index ?? 12)) };
});
app.get('/api/plans/:id/dvh', async (req, reply) => {
  const p = plans.find(x => x.id === (req.params as { id: string }).id);
  return p ? dvh(p) : reply.code(404).send({ error: 'plan_not_found' });
});
// 约束页门禁与放行档案使用同一个 evaluateGate，避免两处结论不一致
app.get('/api/plans/:id/constraints', async (req, reply) => {
  const p = plans.find(x => x.id === (req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ error: 'plan_not_found' });
  return { plan: p, checks: metrics(p), ...evaluateGate(p) };
});
app.get('/api/compare', async () => ({
  plans: plans.map(p => ({ id: p.id, label: p.label, checks: metrics(p), targetCoverage: metrics(p)[0].value, mu: p.mu })),
  recommendation: 'PLAN-A 在靶区覆盖和危及器官约束之间取得更优平衡',
}));

// 签发：任何阻断条件存在都不能成功；重复请求幂等，不产生矛盾状态或重复审计
app.post('/api/plans/:id/approve', async (req, reply) => {
  const p = plans.find(x => x.id === (req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ error: 'plan_not_found' });
  const gate = evaluateGate(p);
  if (gate.gate === 'blocked') {
    audit({ action: 'plan_approve_blocked', planId: p.id, statusBefore: p.status, blockers: gate.blockers });
    return reply.code(409).send({ approved: false, plan: p, ...gate });
  }
  if (p.status === 'approved' || p.status === 'released') {
    return { approved: true, idempotent: true, plan: p, ...gate };
  }
  const statusBefore = p.status;
  p.status = 'approved';
  audit({ action: 'plan_approved', planId: p.id, statusBefore, statusAfter: p.status });
  return { approved: true, plan: p, ...gate };
});

app.post('/api/plans/:id/peer-review', async (req, reply) => {
  const p = plans.find(x => x.id === (req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ error: 'plan_not_found' });
  const body = req.body as { reviewer?: string; note?: string };
  audit({ action: 'peer_review', planId: p.id, reviewer: body?.reviewer ?? '', note: body?.note ?? '' });
  return { ok: true, planId: p.id, reviewer: body?.reviewer ?? '' };
});
app.get('/api/audit', async () => audits);
app.get('/api/plans/:id/verification-dossier', async (req, reply) => {
  const dossier = releaseDossier((req.params as { id: string }).id);
  return 'error' in dossier ? reply.code(404).send(dossier) : dossier;
});

// QA 重测：同一方法新结果取代旧记录，只有当前生效记录参与门禁（失败后复测通过即可恢复）
app.post('/api/plans/:id/independent-check', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const plan = plans.find(p => p.id === id);
  if (!plan) return reply.code(404).send({ error: 'plan_not_found' });
  const body = (req.body ?? {}) as { method?: QaRun['method']; score?: number };
  const method = body.method ?? 'independent_mu';
  const score = body.score ?? (method === 'gamma' ? 97.1 : 2.2);
  const status: QaRun['status'] = method === 'gamma'
    ? (score >= 95 ? 'pass' : score >= 90 ? 'warn' : 'fail')
    : (score <= 3 ? 'pass' : score <= 5 ? 'warn' : 'fail');
  for (const old of qaRuns.filter(x => x.planId === id && x.method === method && x.active)) old.active = false;
  const run: QaRun = {
    id: `QA-${String(qaRuns.length + 71).padStart(3, '0')}`, planId: id, method, status, score,
    detail: method === 'gamma' ? `γ 通过率 ${score}%（阈值 95%）` : `独立核验差异 ${score}%（阈值 3%）`,
    createdAt: new Date().toISOString(), active: true,
  };
  qaRuns.unshift(run);
  audit({ action: 'independent_check', planId: id, qaId: run.id, method: run.method, status: run.status, score: run.score });
  return run;
});

app.post('/api/plans/:id/peer-checklist', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const plan = plans.find(p => p.id === id);
  if (!plan) return reply.code(404).send({ error: 'plan_not_found' });
  const body = req.body as { item?: string; checked?: boolean; reviewer?: string };
  if (!body.item || !REQUIRED_CHECKLIST.includes(body.item)) {
    return reply.code(400).send({ error: 'unknown_checklist_item', required: REQUIRED_CHECKLIST });
  }
  const list = peerChecklist.get(id) ?? [];
  const existing = list.find(x => x.item === body.item);
  const checked = body.checked !== false;
  const at = new Date().toISOString();
  if (existing) {
    existing.checked = checked; existing.reviewer = body.reviewer ?? existing.reviewer; existing.at = at;
  } else {
    list.push({ item: body.item, checked, reviewer: body.reviewer ?? '', at });
  }
  peerChecklist.set(id, list);
  audit({ action: 'peer_checklist', planId: id, item: body.item, checked, reviewer: body.reviewer ?? '' });
  return { planId: id, items: list, ...evaluateGate(plan) };
});

app.post('/api/plans/:id/adaptive-evaluation', async (req) => {
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as { weightChange?: number; tumorShift?: number; lungDensityChange?: number };
  const shift = Math.abs(body.tumorShift ?? 0);
  const weight = Math.abs(body.weightChange ?? 0);
  const density = Math.abs(body.lungDensityChange ?? 0);
  const coverage = +(96.4 - shift * .7 - weight * .18).toFixed(2);
  const lungV20 = +(21.3 + density * .8 + shift * .12).toFixed(2);
  const recommendation = coverage < 95 || lungV20 > 25 ? '需要自适应重计划评估' : '可按原计划继续治疗';
  const event = {
    id: `ADP-${Date.now()}`, planId: id, coverage, lungV20,
    anatomyChange: { weight, shift, density }, recommendation, createdAt: new Date().toISOString(),
  };
  audit({ at: event.createdAt, action: 'adaptive_evaluation', ...event });
  return event;
});

app.post('/api/plans/:id/delivery/fractions', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const plan = plans.find(p => p.id === id);
  if (!plan) return reply.code(404).send({ error: 'plan_not_found' });
  const body = req.body as { fraction?: number; deliveredGy?: number; setupShift?: { x: number; y: number; z: number } };
  const list = deliveries.get(id) ?? [];
  if (body.fraction == null || list.some(x => x.fraction === body.fraction)) {
    return reply.code(409).send({ ok: false, error: 'duplicate_fraction' });
  }
  list.push({
    fraction: body.fraction, deliveredGy: body.deliveredGy ?? 0,
    setupShift: body.setupShift ?? { x: 0, y: 0, z: 0 }, at: new Date().toISOString(),
  });
  deliveries.set(id, list);
  const magnitude = Math.hypot(body.setupShift?.x ?? 0, body.setupShift?.y ?? 0, body.setupShift?.z ?? 0);
  if (magnitude > 5) {
    const event: Deviation = {
      id: `DEV-${deviations.length + 1}`, planId: id, severity: 'high', category: 'setup_shift',
      detail: `第 ${body.fraction} 次摆位偏移 ${magnitude.toFixed(1)} mm`,
      state: 'open', createdAt: new Date().toISOString(),
    };
    deviations.unshift(event);
    audit({ action: 'deviation_logged', planId: id, deviationId: event.id, severity: event.severity, category: event.category });
  }
  audit({ at: new Date().toISOString(), action: 'fraction_delivered', planId: id, fraction: body.fraction });
  return releaseDossier(id);
});

// 完成放行：必须已签发且所有门禁满足；已放行的重复请求幂等返回，不重复写审计
app.post('/api/plans/:id/release', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const p = plans.find(x => x.id === id);
  if (!p) return reply.code(404).send({ error: 'plan_not_found' });
  const gate = evaluateGate(p);
  if (gate.gate === 'blocked') {
    audit({ action: 'plan_release_blocked', planId: p.id, statusBefore: p.status, blockers: gate.blockers });
    return reply.code(409).send({ released: false, code: 'gate_blocked', ...releaseDossier(id) });
  }
  if (p.status === 'released') {
    return { released: true, idempotent: true, ...releaseDossier(id) };
  }
  if (p.status !== 'approved') {
    audit({ action: 'plan_release_blocked', planId: p.id, statusBefore: p.status, blockers: ['计划尚未签发'] });
    return reply.code(409).send({ released: false, code: 'plan_not_approved', ...releaseDossier(id) });
  }
  p.status = 'released';
  audit({ action: 'plan_released', planId: p.id, statusBefore: 'approved', statusAfter: 'released' });
  return { released: true, ...releaseDossier(id) };
});

app.post('/api/plans/:id/deviations', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const plan = plans.find(p => p.id === id);
  if (!plan) return reply.code(404).send({ error: 'plan_not_found' });
  const body = (req.body ?? {}) as { severity?: Deviation['severity']; category?: string; detail?: string };
  const event: Deviation = {
    id: `DEV-${deviations.length + 1}`, planId: id,
    severity: body.severity ?? 'medium', category: body.category ?? 'manual', detail: body.detail ?? '',
    state: 'open', createdAt: new Date().toISOString(),
  };
  deviations.unshift(event);
  audit({ action: 'deviation_logged', planId: id, deviationId: event.id, severity: event.severity, category: event.category, detail: event.detail });
  return event;
});

// 关闭偏差：高等级偏差关闭后门禁才可恢复 ready
app.post('/api/plans/:id/deviations/:devId/resolve', async (req, reply) => {
  const { id, devId } = req.params as { id: string; devId: string };
  const plan = plans.find(p => p.id === id);
  if (!plan) return reply.code(404).send({ error: 'plan_not_found' });
  const event = deviations.find(d => d.id === devId && d.planId === id);
  if (!event) return reply.code(404).send({ error: 'deviation_not_found' });
  if (event.state === 'resolved') return { ok: true, idempotent: true, deviation: event, ...evaluateGate(plan) };
  event.state = 'resolved';
  event.resolvedAt = new Date().toISOString();
  audit({ action: 'deviation_resolved', planId: id, deviationId: event.id, severity: event.severity, category: event.category });
  return { ok: true, deviation: event, ...evaluateGate(plan) };
});

await app.listen({ host: '127.0.0.1', port: 6202 });
