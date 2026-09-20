// 默认推演场景：780km 太阳同步主星 + 碎片/卫星，72h 推演窗口
import {
  DEG,
  R_EARTH,
  add,
  cross,
  dot,
  elementsFromState,
  findContacts,
  makeStateFn,
  norm,
  propagate,
  rtnBasis,
  scale,
  stateFromElements,
  sub,
  unit,
} from './orbital.js';
import { collisionProbability, evaluatePlan, findConjunctions } from './risk.js';

export const HOUR = 3600;
export const DAY = 86400;

export const PRIMARY_ID = 'SAT-1';

export const EPOCH_ISO = '2026-09-21T00:00:00Z';

// 构造异轨面碎片：在 targetTca 与主星交会；speedScale 制造周期差使相邻圈次错开；
// targetMissKm 在 TCA 点沿角动量法向叠加位置偏移，设定该次交会期望最近距离。
function tuneCrossing(primaryEls, targetTca, angleDeg, targetMissKm) {
  const src = stateFromElements(primaryEls, targetTca);
  const rhat = unit(src.r);
  const vRadial = dot(rhat, src.v);
  const vTan0 = sub(src.v, scale(rhat, vRadial));
  const tHat = unit(vTan0);
  const nHat = unit(cross(rhat, tHat));
  const th = angleDeg * DEG;
  const speedScale = 1 - (Math.abs(angleDeg) > 30 ? 0.001 : 0.002);
  const vTan = scale(
    add(scale(tHat, Math.cos(th)), scale(nHat, Math.sin(th))),
    norm(vTan0) * speedScale
  );
  const v = add(vTan, scale(rhat, vRadial));
  const rOffset = add(src.r, scale(nHat, targetMissKm));
  return elementsFromState(rOffset, v, targetTca);
}

// 在 TCA 点叠加沿迹速度差，构造近共面追越目标
function coplanarDebris(primaryEls, id, name, tca, dAlongTKmS, opts = {}) {
  const sat = stateFromElements(primaryEls, tca);
  const b = rtnBasis(sat.r, sat.v);
  const v = add(sat.v, scale(b.t, dAlongTKmS));
  return {
    id,
    name,
    type: 'debris',
    els: elementsFromState(sat.r, v, tca),
    radiusKm: opts.radiusKm ?? 0.00015,
    color: opts.color ?? 0x9aa3ad,
    seedTca: tca,
  };
}

// 数值调谐碎片根数：在初轨基础上二分搜索一个沿法向的小速度增量（在 seedTca 施加），
// 使与主星的全局最小距离落入 [targetMissKm*0.6, targetMissKm*1.4]，再相位对齐到 targetTca。
export function makeDefaultScenario() {
  const t0 = 0;
  const t1 = 72 * HOUR;

  const primary = {
    id: PRIMARY_ID,
    name: '近星-1 号',
    type: 'satellite',
    els: {
      a: R_EARTH + 780,
      e: 0.0012,
      i: 98.6 * DEG,
      raan: 10 * DEG,
      argp: 0,
      M0: 0,
      epoch: 0,
    },
    radiusKm: 0.005,
    color: 0x4da3ff,
  };

  const fn0 = makeStateFn(primary.els, []);

  // 主威胁：36h 处大夹角高速异轨面交会；周期略短，仅在 36h 附近形成一次近距离
  const d1 = {
    id: 'DEB-1',
    name: '碎片 FengYun-1C/8423',
    type: 'debris',
    els: tuneCrossing(primary.els, 36 * HOUR, 75, 0.55),
    radiusKm: 0.00015,
    color: 0x9aa3ad,
  };
  // 51.5h 处近共面追越（相对速度约 60 m/s）
  const d2 = coplanarDebris(primary.els, 'DEB-2', '碎片 Iridium-33/2217', 51.5 * HOUR, -0.06, {
    radiusKm: 0.00012,
    color: 0x8d949c,
  });
  // 19.2h 处小夹角异轨面交会；周期略长，只在此圈接近
  const d3 = {
    id: 'DEB-3',
    name: '碎片 Cosmos-2251/4491',
    type: 'debris',
    els: tuneCrossing(primary.els, 19.2 * HOUR, -14, 3.2),
    radiusKm: 0.0002,
    color: 0xc7cdd6,
  };


  const sat2 = {
    id: 'SAT-2',
    name: '遥感-乙（在轨卫星）',
    type: 'satellite',
    els: {
      a: R_EARTH + 830,
      e: 0.0008,
      i: 99.1 * DEG,
      raan: 42 * DEG,
      argp: 90 * DEG,
      M0: 2.1,
      epoch: 0,
    },
    radiusKm: 0.006,
    color: 0xbf8aff,
  };

  const stations = [
    { id: 'GS-SVA', name: '斯瓦尔巴地面站', lat: 78.22, lon: 15.65 },
    { id: 'GS-BJI', name: '北京地面站', lat: 40.07, lon: 116.6 },
    { id: 'GS-MAL', name: '马林迪地面站', lat: -2.99, lon: 40.19 },
    { id: 'GS-KOU', name: '库鲁地面站', lat: 5.15, lon: -52.65 },
  ];

  const objects = [primary, d1, d2, d3, sat2];

  const fuel = {
    wetKg: 1220,
    propKg: 95,
    isp: 220,
    thrustN: 22,
  };

  const scenario = {
    epochIso: EPOCH_ISO,
    t0,
    t1,
    objects,
    primaryId: PRIMARY_ID,
    stations,
    fuel,
    scanStep: 20,
    conjunctionKm: 120,
    secondaryKm: 10,
    secondaryPc: 1e-5,
    matchWindowSec: 2400,
    settleSec: 300,
    recoverSec: 600,
    sampleStep: 60,
    _deps: { makeStateFn },
  };

  // 基线推演：扫描所有对象交会 + 主星通信窗口
  const eventsByObj = new Map();
  for (const obj of objects) {
    if (obj.id === PRIMARY_ID) continue;
    const objFn = makeStateFn(obj.els, []);
    const evs = findConjunctions(fn0, objFn, t0, t1, scenario.scanStep, {
      minThreshold: scenario.conjunctionKm,
    });
    for (const ev of evs) {
      ev.objectId = obj.id;
      ev.objectName = obj.name;
      ev.pc = collisionProbability(ev, ev.tca / DAY, primary.radiusKm + obj.radiusKm);
    }
    eventsByObj.set(obj.id, evs);
  }
  const samples = propagate(fn0, t0, t1, scenario.sampleStep);
  const contacts = findContacts(samples, stations, 5 * DEG);

  scenario.baseline = { eventsByObj, contacts, samples };
  return scenario;
}

export function runEvaluate(maneuvers, scenario) {
  return evaluatePlan(maneuvers, scenario, scenario.baseline);
}
