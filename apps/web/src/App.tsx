import { useEffect, useState } from 'react';
import './styles.css';

const api = (u: string, opts?: RequestInit) =>
  fetch(u, opts).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error('request_failed'), { data, status: r.status });
    return data;
  });

type Dossier = any;

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', review: '待签发', approved: '已签发 · 待放行', released: '已放行',
};

export default function App() {
  const [tab, setTab] = useState('dose');
  const [patient, setPatient] = useState<any>();
  const [plans, setPlans] = useState<any[]>([]);
  const [active, setActive] = useState('PLAN-A');
  const [constraints, setConstraints] = useState<any>();
  const [compare, setCompare] = useState<any>();
  const [slice, setSlice] = useState<any>();
  const [dossier, setDossier] = useState<Dossier>();
  const [audits, setAudits] = useState<any[]>([]);
  const [reviewer, setReviewer] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api('/api/patient/current').then(setPatient);
    api('/api/plans').then(setPlans);
    api('/api/compare').then(setCompare);
  }, []);

  const refreshDossier = () =>
    Promise.all([
      api(`/api/plans/${active}/constraints`).then(setConstraints),
      api(`/api/plans/${active}/verification-dossier`).then(setDossier),
      api('/api/audit').then(setAudits),
      api('/api/plans').then(setPlans),
    ]);

  useEffect(() => { setNotice(null); refreshDossier(); api(`/api/plans/${active}/dose-slice?index=12`).then(setSlice); }, [active]);

  // 所有状态变更动作走同一入口：请求期间禁用按钮防重复点击，结束后以服务端数据为准刷新
  const action = async (fn: () => Promise<any>, success: string) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice({ ok: true, text: success });
    } catch (e: any) {
      const d = e.data ?? {};
      const blockers = d.blockers?.length ? `：${d.blockers.join('；')}` : (d.code === 'plan_not_approved' ? '：计划尚未签发' : '');
      setNotice({ ok: false, text: `操作被服务端拒绝${blockers}` });
    } finally {
      await refreshDossier();
      setBusy(false);
    }
  };

  const post = (u: string, body?: any) => api(u, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const plan = plans.find(p => p.id === active);
  const gate = dossier?.gate;              // 放行档案是门禁的唯一权威来源
  const ready = gate === 'ready';
  const status = dossier?.plan?.status ?? plan?.status;
  const approved = status === 'approved' || status === 'released';
  const released = status === 'released';

  const approve = () => action(() => post(`/api/plans/${active}/approve`), '计划已签发');
  const release = () => action(() => post(`/api/plans/${active}/release`), '放行完成，计划进入已放行状态');

  return <main>
    <header>
      <div>
        <span className="eyebrow">RADIATION ONCOLOGY / PLAN QA</span>
        <h1>放射治疗剂量计划验证与器官风险评估系统</h1>
        <p>{patient?.patient?.id} · {patient?.patient?.diagnosis} · 处方 {patient?.patient?.rxDose} Gy / {patient?.patient?.fractions} 次</p>
      </div>
      <div className="badge">物理师复核模式</div>
    </header>
    <nav>
      {[['dose', '剂量阅片'], ['constraints', '约束校验'], ['release', '放行档案'], ['compare', '计划对比']].map(([id, label]) =>
        <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    <section className="toolbar">
      <label>当前计划
        <select value={active} onChange={e => setActive(e.target.value)}>
          {plans.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <div className="toolbarRight">
        <span className={`planStatus ${ready ? 'ready' : 'blocked'}`}>{ready ? '放行门禁通过' : `放行门禁阻断（${dossier?.blockers?.length ?? 0} 项）`}</span>
        <span className={`planStatus status-${status}`}>{STATUS_LABEL[status ?? 'draft'] ?? status}</span>
      </div>
    </section>
    {notice && <div className={notice.ok ? 'notice ok' : 'notice fail'}>{notice.text}</div>}

    {tab === 'dose' && <section className="grid">
      <div className="panel imagePanel">
        <div className="panelHead"><h2>断层切片剂量叠加</h2><span>切片 12 / 32 · 等剂量线：20 / 50 / 95%</span></div>
        <div className="slice">{slice?.data.map((row: number[], y: number) => row.map((v, x) =>
          <span key={`${x}-${y}`} style={{ background: `hsl(${Math.max(0, 240 - v * 2.2)},${v > 80 ? 88 : 55}%,${25 + v * .45}%)` }} />))}</div>
        <div className="doseLegend">
          <span style={{ background: '#244bd5' }} />低剂量 <span style={{ background: '#f3bb35' }} />中剂量 <span style={{ background: '#ef555b' }} />高剂量
        </div>
      </div>
      <div className="panel">
        <div className="panelHead"><h2>计划参数</h2><span>{active}</span></div>
        {plan && Object.entries(plan).filter(([k]) => !['id', 'status'].includes(k)).map(([k, v]) =>
          <div className="kv" key={k}><span>{k}</span><b>{String(v)}</b></div>)}
        <div className="callout">剂量验证不是单一通过/失败判断，需要同时审查靶区覆盖、危及器官受量、机器跳数和算法版本。</div>
      </div>
    </section>}

    {tab === 'constraints' && <section className="grid">
      <div className="panel">
        <div className="panelHead"><h2>结构约束校验</h2><span>DVH 指标自动计算</span></div>
        {constraints?.checks.map((x: any) =>
          <div className="constraint" key={x.structureId}>
            <div><b>{x.name}</b><small>{x.metric} · 限值 {x.limit}{x.unit}</small></div>
            <strong className={x.pass ? 'pass' : 'fail'}>{x.value}{x.unit}</strong>
            <span className={x.pass ? 'pass' : 'fail'}>{x.pass ? 'PASS' : 'FAIL'}</span>
          </div>)}
      </div>
      <div className="panel">
        <div className="panelHead"><h2>DVH 曲线摘要</h2><span>体积-剂量关系</span></div>
        {patient?.structures.map((s: any) =>
          <div className="bar" key={s.id}>
            <span>{s.name}</span>
            <div><i style={{ width: `${Math.min(100, constraints?.checks.find((x: any) => x.structureId === s.id)?.value ?? 0)}%` }} /></div>
            <b>{constraints?.checks.find((x: any) => x.structureId === s.id)?.value}</b>
          </div>)}
        <div className="gateBox">
          <strong className={ready ? 'pass' : 'fail'}>{ready ? '所有放行门禁满足，可以签发' : '存在阻断项，签发按钮已锁定'}</strong>
          {dossier?.blockers?.map((b: string, i: number) => <small key={i} className="blockerLine">· {b}</small>)}
        </div>
        <div className="review">
          <input placeholder="复核人姓名" value={reviewer} onChange={e => setReviewer(e.target.value)} />
          <button disabled={busy || !reviewer.trim()} onClick={() => action(
            () => post(`/api/plans/${active}/peer-review`, { reviewer, note: '已完成剂量约束复核' }), '同行复核意见已记录')}>
            记录同行复核
          </button>
          <button className="primary" disabled={busy || !ready || approved} onClick={approve}>
            {released ? '已放行' : approved ? '已签发' : '签发计划'}
          </button>
        </div>
      </div>
    </section>}

    {tab === 'release' && <section className="grid releaseGrid">
      <div className="panel">
        <div className="panelHead"><h2>放行门禁与阻断项</h2><span>{active} · {STATUS_LABEL[status ?? 'draft']}</span></div>
        <div className={`gateBanner ${gate}`}>
          {ready ? '✓ 所有门禁满足，可完成放行' : '✕ 以下阻断项未消除，不能签发或放行'}
        </div>
        {dossier?.blockers?.length > 0
          ? dossier.blockers.map((b: string, i: number) => <div key={i} className="blockerRow">✕ {b}</div>)
          : <div className="blockerRow ok">✓ 剂量约束、QA、同行复核清单、高等级偏差全部通过</div>}

        <div className="actionRow">
          <button className="primary" disabled={busy || !ready || approved} onClick={approve}>
            {released ? '已放行' : approved ? '已签发' : '1. 签发计划'}
          </button>
          <button className="primary" disabled={busy || !ready || !approved || released} onClick={release}>
            {released ? '已完成放行' : approved ? '2. 完成放行' : '2. 完成放行（需先签发）'}
          </button>
          <button disabled={busy} onClick={() => refreshDossier()}>刷新状态</button>
        </div>

        <h3 className="subTitle">独立 QA 记录（同方法以最新一次为准）</h3>
        {dossier?.qa?.map((q: any) =>
          <div className={`qaRow ${q.status} ${q.active ? '' : 'inactive'}`} key={q.id}>
            <b>{q.id}</b><span>{q.method}</span><strong>{q.score}</strong>
            <em className={q.status}>{q.status.toUpperCase()}{q.active ? '' : '（已被重测取代）'}</em>
            <small>{q.detail}</small>
          </div>)}
        <QaForm busy={busy} onRun={(method, score) => action(() => post(`/api/plans/${active}/independent-check`, { method, score }), 'QA 已重测，门禁按最新结果重新评估')} />
      </div>

      <div className="panel">
        <div className="panelHead"><h2>同行复核清单</h2><span>{dossier?.missingChecklist?.length ?? 0} 项缺失</span></div>
        {(dossier?.requiredChecklist ?? []).map((item: string) => {
          const done = dossier?.checklist?.find((x: any) => x.item === item);
          return <label className="checkRow" key={item}>
            <input type="checkbox" checked={!!done?.checked} disabled={busy || !reviewer.trim() || !!done?.checked}
              onChange={() => action(() => post(`/api/plans/${active}/peer-checklist`, { item, checked: true, reviewer }), `已勾选：${item}`)} />
            <span className={done?.checked ? 'done' : ''}>{item}</span>
            <small>{done?.checked ? `${done.reviewer} · ${new Date(done.at).toLocaleString('zh-CN')}` : '待复核'}</small>
          </label>;
        })}
        <input className="fullInput" placeholder="复核人姓名（勾选前必填）" value={reviewer} onChange={e => setReviewer(e.target.value)} />

        <h3 className="subTitle">偏差登记{dossier?.deviations?.length ? `（${dossier.deviations.length}）` : ''}</h3>
        {dossier?.deviations?.length ? dossier.deviations.map((d: any) =>
          <div className={`devRow ${d.state}`} key={d.id}>
            <b className={`sev sev-${d.severity}`}>{d.severity.toUpperCase()}</b>
            <span>{d.category} · {d.detail}</span>
            {d.state === 'open'
              ? <button className="small" disabled={busy} onClick={() => action(() => post(`/api/plans/${active}/deviations/${d.id}/resolve`), `偏差 ${d.id} 已关闭`)}>关闭</button>
              : <em className="resolved">已关闭 {d.resolvedAt ? new Date(d.resolvedAt).toLocaleString('zh-CN') : ''}</em>}
          </div>) : <small className="muted">暂无偏差记录</small>}
        <div className="actionRow">
          <button disabled={busy} onClick={() => action(
            () => post(`/api/plans/${active}/deviations`, { severity: 'high', category: 'manual_check', detail: '手工登记的高等级偏差' }),
            '已登记高等级偏差（门禁将阻断）')}>模拟：登记高等级偏差</button>
        </div>

        <h3 className="subTitle">治疗执行摘要</h3>
        <div className="kv"><span>已执行分次</span><b>{dossier?.deliverySummary?.fractions ?? 0} / {patient?.patient?.fractions ?? 30}</b></div>
        <div className="kv"><span>累计剂量</span><b>{dossier?.deliverySummary?.cumulativeDose ?? 0} Gy（处方 {dossier?.deliverySummary?.prescriptionDose ?? 60} Gy）</b></div>
        <div className="kv"><span>NTCP 放射性肺炎</span><b>{dossier?.ntcp?.lungPneumonitis}%</b></div>
        <div className="kv"><span>NTCP 心脏事件</span><b>{dossier?.ntcp?.heartEvent}%</b></div>
      </div>

      <div className="panel auditPanel">
        <div className="panelHead"><h2>审计记录</h2><span>页面状态与接口动作的完整轨迹</span></div>
        <table className="auditTable">
          <thead><tr><th>时间</th><th>动作</th><th>计划</th><th>详情</th></tr></thead>
          <tbody>
            {audits.map((a, i) =>
              <tr key={i} className={String(a.action).includes('blocked') ? 'auditBlocked' : ''}>
                <td>{new Date(a.at).toLocaleString('zh-CN')}</td>
                <td><b>{a.action}</b></td>
                <td>{a.planId ?? '—'}</td>
                <td>{a.blockers ? a.blockers.join('；')
                  : a.statusAfter ? `${a.statusBefore} → ${a.statusAfter}`
                  : a.item ? `${a.item}：${a.checked ? '已勾选' : '取消'}（${a.reviewer}）`
                  : a.method ? `${a.method} ${a.status} ${a.score ?? ''}`
                  : a.category ? `${a.severity ?? ''} ${a.category}${a.detail ? ' · ' + a.detail : ''}`
                  : a.reviewer ? `复核人 ${a.reviewer}`
                  : a.fraction ? `第 ${a.fraction} 次` : ''}</td>
              </tr>)}
          </tbody>
        </table>
      </div>
    </section>}

    {tab === 'compare' && <section className="panel">
      <div className="panelHead"><h2>计划对比与选择</h2><span>同一患者、不同照射技术</span></div>
      <div className="compareGrid">
        {compare?.plans.map((p: any) =>
          <div key={p.id} className={`compareCard ${p.id === active ? 'selected' : ''}`} onClick={() => setActive(p.id)}>
            <h3>{p.label}</h3>
            <strong>{p.targetCoverage}%</strong><small>PTV D95 覆盖</small>
            <p>MU {p.mu} · 约束失败 {p.checks.filter((x: any) => !x.pass).length} 项</p>
            {p.checks.map((x: any) => <div key={x.structureId} className={x.pass ? 'tinyPass' : 'tinyFail'}>{x.name}: {x.value}{x.unit}</div>)}
          </div>)}
      </div>
      <div className="recommend">系统建议：{compare?.recommendation}</div>
    </section>}
  </main>;
}

function QaForm({ busy, onRun }: { busy: boolean; onRun: (method: string, score: number) => void }) {
  const [method, setMethod] = useState('gamma');
  const [score, setScore] = useState('92');
  return <div className="qaForm">
    <select value={method} onChange={e => setMethod(e.target.value)}>
      <option value="gamma">Gamma 通过率 (%)</option>
      <option value="independent_mu">独立 MU 差异 (%)</option>
      <option value="image_guidance">影像引导核验 (%)</option>
    </select>
    <input value={score} onChange={e => setScore(e.target.value)} placeholder="分数" />
    <button className="small" disabled={busy || Number.isNaN(Number(score))} onClick={() => onRun(method, Number(score))}>重测并记录</button>
  </div>;
}
