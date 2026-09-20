// 轨道力学内核（单位：km、s、km/s；二体传播，机动为瞬时冲量）
export const MU = 398600.4418; // 地球引力常数 km^3/s^2
export const R_EARTH = 6378.137; // 地球赤道半径 km
export const OMEGA_E = 7.2921159e-5; // 地球自转角速度 rad/s
export const DEG = Math.PI / 180;

export function norm(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function unit(v) {
  const n = norm(v) || 1;
  return scale(v, 1 / n);
}

// 求解开普勒方程 M = E - e sin E
export function solveKepler(M, e, tol = 1e-10) {
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 60; k++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < tol) break;
  }
  return E;
}

// 近焦点/角动量单位基（P=偏心率方向，W=角动量方向）
function basisFromAngles(i, raan, argp) {
  const cO = Math.cos(raan);
  const sO = Math.sin(raan);
  const ci = Math.cos(i);
  const si = Math.sin(i);
  const cw = Math.cos(argp);
  const sw = Math.sin(argp);
  const p = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const q = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  return { p, q };
}

// 由轨道根数得到任意时刻 ECI 状态
// els: {a, e, i, raan, argp, M0, epoch, pVec?, qVec?}
export function stateFromElements(els, t) {
  const { a, e, i, raan, argp, M0 } = els;
  const epoch = els.epoch ?? 0;
  const n = Math.sqrt(MU / (a * a * a));
  const M = ((M0 + n * (t - epoch)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const E = solveKepler(M, e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const sqrt1e2 = Math.sqrt(Math.max(1 - e * e, 0));
  // 近焦点坐标系
  const x = a * (cosE - e);
  const y = a * sqrt1e2 * sinE;
  const fac = Math.sqrt(MU * a) / (a * (1 - e * cosE));
  const vx = -fac * sinE;
  const vy = fac * sqrt1e2 * cosE;
  const basis = els.pVec
    ? { p: els.pVec, q: els.qVec }
    : basisFromAngles(i ?? 0, raan ?? 0, argp ?? 0);
  return {
    r: add(scale(basis.p, x), scale(basis.q, y)),
    v: add(scale(basis.p, vx), scale(basis.q, vy)),
  };
}

// 由 ECI 状态反算轨道根数（epoch 为状态所在时刻）
function normalize(x) {
  return Math.min(1, Math.max(-1, x));
}

// 由 ECI 状态反算轨道根数（epoch 为状态所在时刻）。
// 同时返回近焦点基 pVec/qVec，前向传播直接使用基向量，避免近圆轨道角度组合退化。
export function elementsFromState(r, v, epoch = 0) {
  const R = norm(r);
  const V2 = dot(v, v);
  const h = cross(r, v);
  const hn = norm(h);
  const wVec = scale(h, 1 / hn);
  const k = [0, 0, 1];
  const nVec = cross(k, h);
  const nn = norm(nVec);
  const ev = sub(scale(cross(v, h), 1 / MU), scale(r, 1 / R));
  const e = norm(ev);
  const a = 1 / (2 / R - V2 / MU);
  const inc = Math.acos(normalize(h[2] / hn));
  const raan = nn > 1e-12 ? Math.atan2(nVec[1], nVec[0]) : 0;
  let pVec;
  let argp = 0;
  if (e > 1e-9) {
    pVec = scale(ev, 1 / e);
    argp =
      nn > 1e-12
        ? Math.atan2(dot(cross(nVec, ev), h) / hn, dot(nVec, ev) / nn)
        : Math.atan2(ev[1], ev[0]);
  } else {
    // 圆轨道：以升交点方向作为近地点参考
    pVec = nn > 1e-12 ? scale(nVec, 1 / nn) : [1, 0, 0];
  }
  const qVec = cross(wVec, pVec);
  // 由轨道方程反解偏近点角：r = a(1 - e cos E)，r·v = e sqrt(μa) sin E
  let M0;
  if (e > 1e-9) {
    const cosE = normalize((1 - R / a) / e);
    const sinE = normalize(dot(r, v) / (e * Math.sqrt(MU * a)));
    const E = Math.atan2(sinE, cosE);
    M0 = E - e * Math.sin(E);
  } else {
    // 圆轨道：M = 纬度幅角
    M0 = Math.atan2(dot(r, qVec), dot(r, pVec));
  }
  M0 = ((M0 % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { a, e, i: inc, raan, argp, M0, epoch, pVec, qVec };
}

// RTN（径向 R、沿迹 T、法向 N）正交基
export function rtnBasis(r, v) {
  const R = unit(r);
  const N = unit(cross(r, v));
  const T = cross(N, R);
  return { r: R, t: unit(T), n: N };
}

// 构造分段状态函数：在指定时刻叠加 RTN 冲量，重构根数继续传播
// maneuvers: [{t, dR, dT, dN}] (km/s)
export function makeStateFn(els0, maneuvers = []) {
  const sorted = [...maneuvers].sort((p, q) => p.t - q.t);
  const segs = [{ tStart: -Infinity, els: els0 }];
  for (const m of sorted) {
    const prev = segs[segs.length - 1].els;
    const { r, v } = stateFromElements(prev, m.t);
    const b = rtnBasis(r, v);
    const dv = add(
      add(scale(b.r, m.dR || 0), scale(b.t, m.dT || 0)),
      scale(b.n, m.dN || 0)
    );
    segs.push({ tStart: m.t, els: elementsFromState(r, add(v, dv), m.t) });
  }
  return function stateAt(t) {
    let seg = segs[0];
    for (const s of segs) if (s.tStart <= t + 1e-9) seg = s;
    return stateFromElements(seg.els, t);
  };
}

// 传播一条对象轨迹，返回 {time:[], r:[vec3], v:[vec3]}
export function propagate(stateAt, t0, t1, step) {
  const time = [];
  const r = [];
  const v = [];
  for (let t = t0; t <= t1 + 1e-9; t += step) {
    const s = stateAt(t);
    time.push(t);
    r.push(s.r);
    v.push(s.v);
  }
  return { time, r, v };
}

// 简化 GMST：以推演历元为零转角（仅用于地面站可见性，相对相位不影响结论）
export function eciToEcef(r, t) {
  const th = OMEGA_E * t;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2]];
}

export function geodeticToEcef(latDeg, lonDeg, altKm = 0) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const R = R_EARTH + altKm;
  return [R * Math.cos(lat) * Math.cos(lon), R * Math.cos(lat) * Math.sin(lon), R * Math.sin(lat)];
}

// 地面站对某 ECI 位置的仰角（弧度）与斜距（km）
export function elevation(latDeg, lonDeg, rEci, t) {
  const p = eciToEcef(rEci, t);
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const c = Math.cos(lat);
  const up = [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const rho = sub(p, geodeticToEcef(latDeg, lonDeg));
  const d = norm(rho);
  const el = Math.asin(dot(up, rho) / d);
  return {
    el,
    range: d,
    az: Math.atan2(dot(east, rho), dot(north, rho)),
  };
}

// 扫描通信窗口（仰角高于 horizonRad 的连续区间）
export function findContacts(samples, stations, horizonRad = 5 * DEG) {
  const contacts = [];
  for (const st of stations) {
    let open = null;
    let maxEl = 0;
    for (let k = 0; k < samples.time.length; k++) {
      const t = samples.time[k];
      const { el } = elevation(st.lat, st.lon, samples.r[k], t);
      if (el >= horizonRad) {
        if (open === null) open = t;
        maxEl = Math.max(maxEl, el);
      } else if (open !== null) {
        contacts.push({ stationId: st.id, stationName: st.name, start: open, end: t, maxEl });
        open = null;
        maxEl = 0;
      }
    }
    if (open !== null) {
      contacts.push({
        stationId: st.id,
        stationName: st.name,
        start: open,
        end: samples.time[samples.time.length - 1],
        maxEl,
      });
    }
  }
  contacts.sort((a, b) => a.start - b.start);
  return contacts;
}
