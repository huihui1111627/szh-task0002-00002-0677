import { store } from './store.js';
import { View3D } from './view3d.js';
import { riskLevel } from './risk.js';

const HOUR = 3600;
const DAY = 86400;

function fmtClock(t) {
  const d = Math.floor(t / DAY);
  const h = Math.floor((t % DAY) / HOUR);
  const m = Math.floor((t % HOUR) / 60);
  return `${d}天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function fmtPc(pc) {
  if (pc === 0) return '≈0';
  if (pc < 1e-6) return pc.toExponential(1);
  return pc.toExponential(2);
}

function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

class UI {
  constructor() {
    this.view = null;
  }

  boot() {
    const container = document.getElementById('viewport');
    this.view = new View3D(container, store);
    store.init();
    this.bindGlobal();
    this.renderAll();
    store.subscribe(() => this.renderAll());

    // 时间推进：每真实秒推进 30 分钟推演时间
    this.view.startLoop((dt) => {
      const s = store.state;
      if (s.playing) {
        let t = s.simTime + dt * 1800;
        if (t >= s.scenario.t1) {
          t = s.scenario.t1;
          store.setPlaying(false);
        }
        store.setSimTime(t);
      }
    });
  }

  bindGlobal() {
    document.getElementById('btn-reset-view').addEventListener('click', () => {
      store.state.playing && store.setPlaying(false);
      store.setSimTime(0);
    });
    document.getElementById('toggle-orbits').addEventListener('change', (e) => store.toggleFlag('showOrbits'));
    document.getElementById('toggle-baseline').addEventListener('change', (e) => store.toggleFlag('showBaseline'));
    document.getElementById('toggle-contacts').addEventListener('change', (e) => store.toggleFlag('showContacts'));
    document.getElementById('btn-add-plan').addEventListener('click', () => store.addPlan());
  }

  renderAll() {
    const s = store.state;
    if (!s.scenario) return;
    this.view.rebuild();
    this.renderTimeline();
    this.renderObjectList();
    this.renderEventList();
    this.renderPlanPanel();
    this.renderCompare();
    this.renderCheckpointBar();
    this.renderContactList();
    document.getElementById('clock').textContent = fmtClock(s.simTime);
  }

  // ---------- 时间轴 ----------
  renderTimeline() {
    const s = store.state;
    const sc = s.scenario;
    const track = document.getElementById('timeline-track');
    track.innerHTML = '';
    const pct = (t) => `${(t / sc.t1) * 100}%`;

    // 交会事件刻度
    const activePlan = store.activePlan();
    const events = activePlan ? activePlan.result.events : this.allBaseEvents();
    for (const ev of events) {
      const rl = riskLevel(ev.pc);
      const tick = el(`<div class="tk-event" style="left:${pct(ev.tca)};background:#${rl.color.toString(16).padStart(6, '0')}" title="${ev.objectName} ${fmtClock(ev.tca)} Pc=${fmtPc(ev.pc)}"></div>`);
      tick.addEventListener('click', () => {
        store.select(ev.objectId);
        store.setSimTime(ev.tca);
      });
      track.appendChild(tick);
    }

    // 机动刻度
    for (const plan of s.plans) {
      if (!s.comparedPlanIds.includes(plan.id) && plan.id !== s.activePlanId) continue;
      for (const m of plan.maneuvers) {
        const mk = el(`<div class="tk-burn" style="left:${pct(m.t)};border-color:#${plan.color.toString(16).padStart(6, '0')}"></div>`);
        mk.title = `${plan.name} 点火 ${fmtClock(m.t)}`;
        track.appendChild(mk);
      }
    }

    // 当前时间游标
    const cursor = el(`<div class="tk-cursor" style="left:${pct(s.simTime)}"></div>`);
    track.appendChild(cursor);

    const slider = document.getElementById('timeline-slider');
    slider.min = sc.t0;
    slider.max = sc.t1;
    slider.step = 60;
    slider.value = s.simTime;
    slider.oninput = (e) => store.setSimTime(Number(e.target.value));
    document.getElementById('btn-play').textContent = s.playing ? '⏸ 暂停' : '▶ 播放';
    document.getElementById('btn-play').onclick = () => store.setPlaying(!s.playing);
  }

  allBaseEvents() {
    const out = [];
    for (const evs of store.state.scenario.baseline.eventsByObj.values()) out.push(...evs);
    return out.sort((a, b) => a.tca - b.tca);
  }

  // ---------- 对象列表 ----------
  renderObjectList() {
    const s = store.state;
    const list = document.getElementById('object-list');
    list.innerHTML = '';
    for (const obj of s.scenario.objects) {
      const selected = s.selectedId === obj.id;
      const item = el(`
        <div class="obj-item ${selected ? 'sel' : ''}" data-id="${obj.id}">
          <span class="dot" style="background:#${obj.color.toString(16).padStart(6, '0')}"></span>
          <span class="obj-name">${obj.name}</span>
          <span class="obj-type">${obj.type === 'satellite' ? '卫星' : '碎片'}</span>
        </div>`);
      item.addEventListener('click', () => {
        store.select(obj.id);
        if (obj.id !== s.scenario.primaryId) this.view.focusOnObject(obj.id);
      });
      list.appendChild(item);
    }
  }

  // ---------- 交会/风险时间窗列表 ----------
  renderEventList() {
    const s = store.state;
    const box = document.getElementById('event-list');
    box.innerHTML = '';
    const activePlan = store.activePlan();
    const events = (activePlan ? activePlan.result.events : this.allBaseEvents())
      .filter((e) => e.pc >= 1e-8 || e.miss <= 15)
      .sort((a, b) => a.tca - b.tca);

    const baseByKey = new Map();
    for (const e of this.allBaseEvents()) baseByKey.set(`${e.objectId}@${Math.round(e.tca / 100)}`, e);

    const head = el(`<div class="section-hint">${activePlan ? `方案「${activePlan.name}」` : '无机动基线'} · 点击定位</div>`);
    box.appendChild(head);

    if (!events.length) box.appendChild(el('<div class="muted small">推演窗口内无显著交会</div>'));
    for (const ev of events) {
      const rl = riskLevel(ev.pc);
      const inWindow = Math.abs(s.simTime - ev.tca) < 1800;
      const base = baseByKey.get(`${ev.objectId}@${Math.round(ev.tca / 100)}`);
      const delta = base ? Math.log10((ev.pc + 1e-300) / (base.pc + 1e-300)) : null;
      const row = el(`
        <div class="event-row ${inWindow ? 'risk-window' : ''}" style="border-left-color:#${rl.color.toString(16).padStart(6, '0')}">
          <div class="ev-main">
            <span class="ev-name">${ev.objectName}</span>
            <span class="ev-badge" style="background:#${rl.color.toString(16).padStart(6, '0')}">${rl.label}风险</span>
          </div>
          <div class="ev-meta">TCA ${fmtClock(ev.tca)} · 最近距离 ${ev.miss.toFixed(2)} km · 相对速度 ${ev.relSpeed.toFixed(2)} km/s</div>
          <div class="ev-meta">碰撞概率 Pc=${fmtPc(ev.pc)}${delta !== null && Number.isFinite(delta) ? `（${delta <= 0 ? '↓' : '↑'}${Math.abs(delta).toFixed(1)} 数量级）` : '（新增交会）'}</div>
          <div class="ev-window">风险时间窗 ${fmtClock(ev.tca - 1800)} ~ ${fmtClock(ev.tca + 1800)}</div>
        </div>`);
      row.addEventListener('click', () => {
        store.select(ev.objectId);
        store.focusEvent(`${ev.objectId}@${Math.round(ev.tca)}`);
        store.setSimTime(ev.tca);
        this.view.focusPosition(ev.posSat);
      });
      box.appendChild(row);
    }
  }

  // ---------- 方案编辑 ----------
  renderPlanPanel() {
    const s = store.state;
    const host = document.getElementById('plan-panel');
    host.innerHTML = '';

    // 方案标签页
    const tabs = el('<div class="plan-tabs"></div>');
    for (const p of s.plans) {
      const tab = el(`
        <div class="plan-tab ${p.id === s.activePlanId ? 'active' : ''}" data-id="${p.id}">
          <span class="tab-dot" style="background:#${p.color.toString(16).padStart(6, '0')}"></span>${p.name}
        </div>`);
      tab.addEventListener('click', () => store.setActivePlan(p.id));
      tabs.appendChild(tab);
    }
    host.appendChild(tabs);

    const plan = store.activePlan();
    if (!plan) {
      host.appendChild(el('<div class="muted">尚未创建方案，点击右上角「+ 新方案」。</div>'));
      return;
    }
    const r = plan.result;

    const card = el('<div class="plan-card"></div>');
    card.innerHTML = `
      <div class="plan-head">
        <input class="plan-name-input" value="${plan.name.replace(/"/g, '&quot;')}">
        <div class="plan-actions">
          <button class="btn-mini" data-act="dup">复制</button>
          <button class="btn-mini danger" data-act="del">删除</button>
        </div>
      </div>
      <label class="cmp-line"><input type="checkbox" data-act="cmp" ${s.comparedPlanIds.includes(plan.id) ? 'checked' : ''}> 加入并排比较</label>
    `;
    card.querySelector('.plan-name-input').addEventListener('change', (e) => store.renamePlan(plan.id, e.target.value));
    card.querySelector('[data-act=dup]').addEventListener('click', () => store.duplicatePlan(plan.id));
    card.querySelector('[data-act=del]').addEventListener('click', () => store.removePlan(plan.id));
    card.querySelector('[data-act=cmp]').addEventListener('change', (e) => {
      if (!e.target.checked && s.comparedPlanIds.includes(plan.id)) store.toggleCompare(plan.id);
      if (e.target.checked) store.toggleCompare(plan.id);
    });

    // 机动列表
    const mnBox = el('<div class="mn-list"></div>');
    plan.maneuvers
      .slice()
      .sort((a, b) => a.t - b.t)
      .forEach((m) => mnBox.appendChild(this.maneuverRow(plan, m)));
    card.appendChild(mnBox);

    const addBtn = el('<button class="btn-outline">+ 增加一次机动</button>');
    addBtn.addEventListener('click', () => store.addManeuver(plan.id));
    card.appendChild(addBtn);

    // 评估结果
    const metrics = el(`
      <div class="metrics">
        <div class="metric"><label>总 Δv</label><strong>${r.dvTotal.toFixed(2)} m/s</strong></div>
        <div class="metric"><label>推进剂消耗</label><strong>${r.propellantUsedKg.toFixed(2)} kg</strong></div>
        <div class="metric"><label>推进剂剩余</label><strong class="${r.fuelShortage ? 'bad' : ''}">${r.propellantRemainingKg.toFixed(1)} kg</strong></div>
        <div class="metric"><label>任务中断合计</label><strong>${fmtDuration(r.interruptionTotalSec)}</strong></div>
        <div class="metric"><label>最大 Pc</label><strong class="${r.maxPc >= 1e-4 ? 'bad' : r.maxPc >= 1e-6 ? 'warn' : 'good'}">${fmtPc(r.maxPc)}</strong></div>
        <div class="metric"><label>基线最大 Pc</label><strong>${fmtPc(r.baselineMaxPc)}</strong></div>
      </div>`);
    card.appendChild(metrics);

    // 冲突标注
    if (r.affectedItems.length) {
      const conf = el('<div class="conflict-box"></div>');
      for (const item of r.affectedItems) {
        const typeLabel = { secondary: '二次交会', comms: '通信冲突', fuel: '燃料不足' }[item.type];
        conf.appendChild(el(`
          <div class="conflict-row ${item.type}">
            <span class="cf-tag">${typeLabel}</span>
            <span class="cf-label">${item.label}</span>
            <span class="cf-detail">${item.detail}</span>
          </div>`));
      }
      card.appendChild(conf);
    } else {
      card.appendChild(el('<div class="ok-line">✓ 未发现二次交会、燃料或通信冲突</div>'));
    }

    const verdict = el(`<div class="verdict ${r.viable ? 'ok' : 'no'}">${r.viable ? '方案可行：全部威胁缓解且无约束冲突' : '方案不可行：存在未缓解威胁或约束冲突'}</div>`);
    card.appendChild(verdict);

    const confirmBtn = el('<button class="btn-primary">确认推演节点</button>');
    confirmBtn.addEventListener('click', () => store.confirmCheckpoint(plan.id));
    card.appendChild(confirmBtn);
    if (plan.confirmedAt) {
      card.appendChild(el(`<div class="muted small">已于 ${new Date(plan.confirmedAt).toLocaleString('zh-CN')} 确认节点</div>`));
    }

    host.appendChild(card);
  }

  maneuverRow(plan, m) {
    const row = el(`
      <div class="mn-row">
        <div class="mn-title">点火 @ T+<input type="number" min="0" max="72" step="1" class="mn-th" style="width:52px"> 小时 <input type="number" min="0" max="59" step="1" class="mn-tm" style="width:46px"> 分</div>
        <div class="mn-grid">
          <label>径向 R (m/s)<input type="number" step="0.01" class="mn-r"></label>
          <label>沿迹 T (m/s)<input type="number" step="0.01" class="mn-t"></label>
          <label>法向 N (m/s)<input type="number" step="0.01" class="mn-n"></label>
        </div>
        <div class="mn-mag">Δv 大小 <strong class="mn-dv"></strong> m/s · 点火时长 <span class="mn-dur"></span></div>
        <button class="btn-mini danger mn-del">移除</button>
      </div>`);
    const hInput = row.querySelector('.mn-th');
    const mInput = row.querySelector('.mn-tm');
    hInput.value = Math.floor(m.t / HOUR);
    mInput.value = Math.floor((m.t % HOUR) / 60);
    const commitTime = () => {
      const h = Math.max(0, Math.min(72, Number(hInput.value) || 0));
      const mi = Math.max(0, Math.min(59, Number(mInput.value) || 0));
      store.updateManeuver(plan.id, m.id, { t: h * HOUR + mi * 60 });
    };
    hInput.addEventListener('change', commitTime);
    mInput.addEventListener('change', commitTime);
    const bind = (cls, key) => {
      const input = row.querySelector(cls);
      input.value = (m[key] * 1000).toFixed(2);
      input.addEventListener('input', () => {
        store.updateManeuver(plan.id, m.id, { [key]: Number(input.value) / 1000 });
      });
    };
    bind('.mn-r', 'dR');
    bind('.mn-t', 'dT');
    bind('.mn-n', 'dN');
    const dv = Math.hypot(m.dR, m.dT, m.dN) * 1000;
    row.querySelector('.mn-dv').textContent = dv.toFixed(2);
    const burn = plan.result.burns.find((b) => b.maneuver.id === m.id);
    if (burn) row.querySelector('.mn-dur').textContent = burn.durationSec.toFixed(0) + ' s';
    row.querySelector('.mn-del').addEventListener('click', () => store.removeManeuver(plan.id, m.id));
    return row;
  }

  // ---------- 多方案并排比较 ----------
  renderCompare() {
    const s = store.state;
    const host = document.getElementById('compare-table');
    const plans = s.plans.filter((p) => s.comparedPlanIds.includes(p.id));
    host.innerHTML = '';
    if (!plans.length) {
      host.appendChild(el('<div class="muted">勾选「加入并排比较」以在此并列指标（最多 3 套）。</div>'));
      return;
    }
    const rows = [
      ['总 Δv (m/s)', (r) => r.dvTotal.toFixed(2)],
      ['推进剂消耗 (kg)', (r) => r.propellantUsedKg.toFixed(2)],
      ['推进剂剩余 (kg)', (r) => r.propellantRemainingKg.toFixed(1)],
      ['任务中断', (r) => fmtDuration(r.interruptionTotalSec)],
      ['最大 Pc', (r) => fmtPc(r.maxPc)],
      ['近距离交会数 (<15km)', (r) => r.events.filter((e) => e.miss < 15).length],
      ['二次交会', (r) => r.secondary.length],
      ['通信冲突', (r) => r.commConflicts.length],
      ['燃料不足', (r) => (r.fuelShortage ? '是' : '否')],
      ['结论', (r) => (r.viable ? '可行' : '不可行')],
    ];
    const table = el('<table class="cmp-table"></table>');
    const thead = el('<tr><th>指标</th></tr>');
    for (const p of plans) {
      const th = el('<th></th>');
      th.appendChild(el(`<span class="tab-dot" style="background:#${p.color.toString(16).padStart(6, '0')}"></span>`));
      th.appendChild(document.createTextNode(' ' + p.name));
      thead.appendChild(th);
    }
    table.appendChild(thead);
    for (const [label, fn] of rows) {
      const tr = el('<tr></tr>');
      tr.appendChild(el(`<td class="cmp-k">${label}</td>`));
      for (const p of plans) {
        let val = fn(p.result);
        const cls = label === '结论' ? (p.result.viable ? 'good' : 'bad') : '';
        tr.appendChild(el(`<td class="${cls}">${val}</td>`));
      }
      table.appendChild(tr);
    }
    host.appendChild(table);

    // 受影响对象（取所有比较方案的并集）
    const aff = el('<div class="affected-box"></div>');
    const seen = new Set();
    for (const p of plans) {
      for (const item of p.result.affectedItems) {
        const key = p.id + item.type + item.objectId + item.detail;
        if (seen.has(key)) continue;
        seen.add(key);
        const typeLabel = { secondary: '二次交会', comms: '通信冲突', fuel: '燃料不足' }[item.type];
        aff.appendChild(el(`
          <div class="conflict-row ${item.type}">
            <span class="cf-plan" style="color:#${p.color.toString(16).padStart(6, '0')}">${p.name}</span>
            <span class="cf-tag">${typeLabel}</span>
            <span class="cf-label">${item.label}</span>
          </div>`));
      }
    }
    if (!seen.size) aff.appendChild(el('<div class="muted small">所选方案均无受影响对象。</div>'));
    host.appendChild(aff);
  }

  // ---------- 通信窗口 ----------
  renderContactList() {
    const s = store.state;
    const host = document.getElementById('contact-list');
    host.innerHTML = '';
    const activePlan = store.activePlan();
    // 通信冲突优先展示
    if (activePlan) {
      for (const c of activePlan.result.commConflicts) {
        host.appendChild(el(`
          <div class="conflict-row comms">
            <span class="cf-tag">冲突</span>
            <span class="cf-label">${c.stationName}</span>
            <span class="cf-detail">${fmtClock(c.contactStart)} ~ ${fmtClock(c.contactEnd)} 与中断窗口重叠</span>
          </div>`));
      }
    }
    const contacts = s.scenario.baseline.contacts.filter((c) => c.start <= s.simTime + 6 * HOUR && c.end >= s.simTime - HOUR);
    for (const c of contacts.slice(0, 8)) {
      const active = s.simTime >= c.start && s.simTime <= c.end;
      host.appendChild(el(`
        <div class="contact-row ${active ? 'live' : ''}">
          <span>${c.stationName}</span>
          <span class="muted">${fmtClock(c.start)} – ${fmtClock(c.end)}</span>
        </div>`));
    }
  }

  // ---------- 推演节点恢复条 ----------
  renderCheckpointBar() {
    const s = store.state;
    const bar = document.getElementById('checkpoint-bar');
    bar.innerHTML = '';
    if (s.checkpoint) {
      const cp = s.checkpoint;
      const sum = cp.summary;
      bar.classList.add('has-cp');
      bar.innerHTML = `
        <span class="cp-title">最近确认推演节点：${cp.planName}</span>
        <span class="cp-meta">Δv ${sum.dvTotal.toFixed(2)} m/s · 最大 Pc ${fmtPc(sum.maxPc)} · ${sum.viable ? '可行' : '不可行'} · ${new Date(cp.confirmedAt).toLocaleString('zh-CN')}</span>
        <button class="btn-mini" id="cp-resume">从此节点继续</button>
        <button class="btn-mini" id="cp-clear">清除</button>`;
      bar.querySelector('#cp-resume').addEventListener('click', () => store.resumeCheckpoint());
      bar.querySelector('#cp-clear').addEventListener('click', () => store.clearCheckpoint());
    } else {
      bar.classList.remove('has-cp');
      bar.innerHTML = '<span class="muted small">尚无确认节点 —— 方案调整满意后点击「确认推演节点」，刷新或中断可从该节点继续。</span>';
    }
  }
}

export const ui = new UI();
