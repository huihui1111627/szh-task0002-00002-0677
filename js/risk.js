// 交会扫描、碰撞概率、燃料/中断窗口/冲突判定、方案评估
import { add, cross, dot, norm, scale, sub, unit, rtnBasis } from './orbital.js';

const DAY = 86400;
const G0 = 9.80665; // m/s^2

// 相对位置 1σ 不确定度（km），随距历元天数增长（R/T/N）
function covarianceRTN(days) {
  return {
    sR: 0.04 + 0.03 * days,
    sT: 0.08 + 0.25 * days,
    sN: 0.04 + 0.05 * days,
  };
}

function goldenMin(f, a, b, tol = 0.2) {
  const gr = (Math.sqrt(5) - 1) / 2;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let k = 0; k < 60 && Math.abs(b - a) > tol; k++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = f(d);
    }
  }
  const x = fc < fd ? c : d;
  return { x, fx: fc < fd ? fc : fd };
}

// 扫描两对象间的近距离交会事件（局部最小距离低于 minThreshold）
// 两级扫描：粗步长标记近距离/凹陷区间，合并为若干连续窗口后细扫，定位阈值内局部极小
export function findConjunctions(fnA, fnB, t0, t1, step, { minThreshold = 120 } = {}) {
  const distAt = (t) => norm(sub(fnA(t).r, fnB(t).r));
  const coarseStep = 5;
  const fineStep = 1;
  const grid = [];
  for (let t = t0; t <= t1 + 1e-9; t += coarseStep) grid.push(t);
  if (grid[grid.length - 1] < t1) grid.push(t1);
  const gd = grid.map(distAt);

  // 标记需要细查的网格区间：端点或中点低于阈值，或出现明显凹陷
  const hot = new Array(grid.length - 1).fill(false);
  for (let k = 0; k < grid.length - 1; k++) {
    const mid = (grid[k] + grid[k + 1]) / 2;
    const dm = distAt(mid);
    if (
      gd[k] <= minThreshold ||
      gd[k + 1] <= minThreshold ||
      dm <= minThreshold ||
      dm < Math.min(gd[k], gd[k + 1]) - 20
    ) {
      hot[k] = true;
    }
  }
  // 合并相邻 hot 区间为连续窗口
  const windows = [];
  for (let k = 0; k < hot.length; k++) {
    if (!hot[k]) continue;
    let j = k;
    while (j + 1 < hot.length && hot[j + 1]) j++;
    windows.push([grid[k], grid[j + 1]]);
    k = j;
  }

  const events = [];
  for (const [lo, hi] of windows) {
    const pts = [];
    for (let t = lo; t <= hi + 1e-9; t += fineStep) pts.push(t);
    if (pts[pts.length - 1] < hi) pts.push(hi);
    for (let k = 1; k < pts.length - 1; k++) {
      const dm = distAt(pts[k - 1]);
      const d = distAt(pts[k]);
      const dp = distAt(pts[k + 1]);
      if (d <= minThreshold && d <= dm && d <= dp) {
        const { x: tca, fx: miss } = goldenMin(distAt, pts[k - 1], pts[k + 1]);
        if (events.length === 0 || Math.abs(tca - events[events.length - 1].tca) > fineStep * 4) {
          const sA = fnA(tca);
          const sB = fnB(tca);
          const relVel = sub(sA.v, sB.v);
          events.push({
            tca,
            miss,
            relVel,
            relSpeed: norm(relVel),
            posSat: sA.r,
            posObj: sB.r,
            velSat: sA.v,
            velObj: sB.v,
          });
        }
      }
    }
  }
  return events;
}

// 短路径近似碰撞概率（Foster-Estes 简化式），在垂直于相对速度的交会平面内积分
// 短路径近似碰撞概率（Alfano/Foster-Estes 式），在垂直于相对速度的交会平面内取高斯积分近似
export function collisionProbability(event, daysFromEpoch, combinedRadiusKm) {
  const { posSat, posObj, relVel, velSat } = event;
  const dr = sub(posSat, posObj);
  const vHat = unit(relVel);
  const b = rtnBasis(posSat, velSat || add(posSat, relVel));
  let u1 = sub(b.n, scale(vHat, dot(b.n, vHat)));
  if (norm(u1) < 1e-6) u1 = sub(b.r, scale(vHat, dot(b.r, vHat)));
  u1 = unit(u1);
  const u2 = unit(cross(vHat, u1));
  // 两对象协方差按相同模型平方和合成（RTN 三轴）
  const c = covarianceRTN(daysFromEpoch);
  const varR = 2 * c.sR * c.sR;
  const varT = 2 * c.sT * c.sT;
  const varN = 2 * c.sN * c.sN;
  const sigmaAlong = (u) =>
    Math.sqrt(
      varR * dot(b.r, u) ** 2 + varT * dot(b.t, u) ** 2 + varN * dot(b.n, u) ** 2
    );
  const s1 = sigmaAlong(u1);
  const s2 = sigmaAlong(u2);
  const m1 = dot(dr, u1);
  const m2 = dot(dr, u2);
  const rc = combinedRadiusKm;
  const p =
    (rc * rc / (2 * s1 * s2)) *
    Math.exp(-(m1 * m1 / (2 * s1 * s1) + m2 * m2 / (2 * s2 * s2)));
  return Math.min(1, Number.isFinite(p) ? p : 0);
}

// 冲量变轨：燃料消耗(kg)、点火时长(s)
export function fuelForBurn(dvMS, massKg, ispSec) {
  const dv = dvMS / (G0 * ispSec);
  const propKg = Math.min(massKg * 0.5, massKg * (1 - Math.exp(-dv)));
  return propKg;
}

export function burnDuration(dvMS, massKg, thrustN) {
  return (massKg * dvMS) / thrustN;
}

// 评估一套变轨方案
// scenario: {t0,t1,objects, primaryId, fuel:{wetKg, propKg, isp, thrustN}, settleSec, recoverSec, pcThreshold}
// objects: [{id,name,type:'satellite'|'debris', els, radiusKm}]
// baseline: {eventsByObj: Map(objId -> events with pc), contacts}
export function evaluatePlan(maneuvers, scenario, baseline) {
  const { t0, t1, objects, primaryId, fuel } = scenario;
  const primary = objects.find((o) => o.id === primaryId);
  const { makeStateFn } = scenario._deps;

  const sorted = maneuvers
    .map((m) => ({ ...m }))
    .sort((a, b) => a.t - b.t);
  const planFn = makeStateFn(primary.els, sorted);

  // 1) 交会扫描 + 碰撞概率
  const planEvents = [];
  for (const obj of objects) {
    if (obj.id === primaryId) continue;
    const objFn = makeStateFn(obj.els, []);
    const evs = findConjunctions(planFn, objFn, t0, t1, scenario.scanStep ?? 30, {
      minThreshold: scenario.conjunctionKm ?? 120,
    });
    for (const ev of evs) {
      ev.objectId = obj.id;
      ev.objectName = obj.name;
      ev.pc = collisionProbability(ev, ev.tca / DAY, primary.radiusKm + obj.radiusKm);
      planEvents.push(ev);
    }
  }
  planEvents.sort((a, b) => a.tca - b.tca);

  // 2) 燃料
  const dvTotal = sorted.reduce((sum, m) => {
    const d = Math.hypot(m.dR || 0, m.dT || 0, m.dN || 0) * 1000;
    m.dvMS = d;
    return sum + d;
  }, 0);
  let mass = fuel.wetKg;
  const burns = [];
  for (const m of sorted) {
    const propKg = fuelForBurn(m.dvMS, mass, fuel.isp);
    const dur = burnDuration(m.dvMS, mass, fuel.thrustN);
    mass -= propKg;
    burns.push({ maneuver: m, propKg, durationSec: dur });
  }
  const propellantUsedKg = burns.reduce((s, x) => s + x.propKg, 0);
  const propellantRemainingKg = fuel.propKg - propellantUsedKg;
  const fuelShortage = propellantRemainingKg < 0;

  // 3) 任务中断窗口（点火前姿态建立 -> 点火 -> 恢复）
  const settle = scenario.settleSec ?? 300;
  const recover = scenario.recoverSec ?? 600;
  const interruptionWindows = burns.map((b) => ({
    start: b.maneuver.t - settle,
    end: b.maneuver.t + b.durationSec + recover,
    maneuver: b.maneuver,
    durationSec: settle + b.durationSec + recover,
  }));
  const interruptionTotalSec = interruptionWindows.reduce((s, w) => s + w.durationSec, 0);

  // 4) 通信窗口冲突：中断窗口与任何过境窗口重叠
  const commConflicts = [];
  for (const w of interruptionWindows) {
    for (const c of baseline.contacts) {
      if (w.start < c.end && w.end > c.start) {
        commConflicts.push({
          stationId: c.stationId,
          stationName: c.stationName,
          contactStart: Math.max(w.start, c.start),
          contactEnd: Math.min(w.end, c.end),
          contact: c,
          window: w,
          maneuver: w.maneuver,
        });
      }
    }
  }

  // 5) 二次交会 / 未缓解判定
  // 仅把基线中真正有威胁（近距离或高 Pc）的事件作为缓解目标
  const baseThreatPc = scenario.threatPc ?? 1e-6;
  const baseThreatKm = scenario.threatKm ?? 25;
  const isThreat = (e) => e.miss <= baseThreatKm || e.pc >= baseThreatPc;
  const secondary = [];
  for (const ev of planEvents) {
    const baseEvs = (baseline.eventsByObj.get(ev.objectId) || []).filter(isThreat);
    const matchWin = scenario.matchWindowSec ?? 900;
    const base = baseEvs.find((b) => Math.abs(b.tca - ev.tca) < matchWin);
    if (base) {
      if (base.pc > 0 && ev.pc >= base.pc * 0.1) {
        secondary.push({
          kind: 'unmitigated',
          event: ev,
          baselineEvent: base,
          objectId: ev.objectId,
          objectName: ev.objectName,
          reason: `与 ${ev.objectName} 的目标交会 Pc=${ev.pc.toExponential(2)} 未降至基线 1/10（基线 ${base.pc.toExponential(2)}）`,
        });
      }
    } else if (
      ev.pc >= (scenario.secondaryPc ?? 1e-5) ||
      ev.miss <= (scenario.secondaryKm ?? 25)
    ) {
      secondary.push({
        kind: 'new',
        event: ev,
        objectId: ev.objectId,
        objectName: ev.objectName,
        reason: `与 ${ev.objectName} 产生二次交会，最近距离 ${ev.miss.toFixed(1)} km，Pc=${ev.pc.toExponential(2)}`,
      });
    }
  }

  const maxPc = planEvents.reduce((m, e) => Math.max(m, e.pc), 0);
  const baselineMaxPc = [...baseline.eventsByObj.values()]
    .flat()
    .reduce((m, e) => Math.max(m, e.pc), 0);

  const affectedItems = [
    ...secondary.map((s) => ({
      type: 'secondary',
      objectId: s.objectId,
      label: s.objectName,
      detail: s.reason,
    })),
    ...commConflicts.map((c) => ({
      type: 'comms',
      objectId: c.stationId,
      label: c.stationName,
      detail: `中断窗口与 ${c.stationName} 通信窗口重叠`,
    })),
    ...(fuelShortage
      ? [
          {
            type: 'fuel',
            objectId: primaryId,
            label: primary.name,
            detail: `推进剂不足，缺口 ${(-propellantRemainingKg).toFixed(2)} kg`,
          },
        ]
      : []),
  ];

  return {
    maneuvers: sorted,
    burns,
    dvTotal,
    propellantUsedKg,
    propellantRemainingKg,
    fuelShortage,
    events: planEvents,
    maxPc,
    baselineMaxPc,
    interruptionWindows,
    interruptionTotalSec,
    commConflicts,
    secondary,
    affectedItems,
    viable: !fuelShortage && secondary.length === 0 && commConflicts.length === 0,
  };
}

// 风险等级（用于着色）
export function riskLevel(pc) {
  if (pc >= 1e-4) return { level: 'high', color: 0xff3b30, label: '高' };
  if (pc >= 1e-6) return { level: 'medium', color: 0xffa500, label: '中' };
  return { level: 'low', color: 0x34c759, label: '低' };
}
