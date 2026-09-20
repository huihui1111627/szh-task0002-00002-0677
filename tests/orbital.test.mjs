import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stateFromElements,
  elementsFromState,
  makeStateFn,
  norm,
  sub,
  R_EARTH,
  DEG,
  findContacts,
  elevation,
} from '../js/orbital.js';

const els = {
  a: R_EARTH + 780,
  e: 0.0012,
  i: 98.6 * DEG,
  raan: 10 * DEG,
  argp: 0,
  M0: 0,
  epoch: 0,
};

test('状态→根数→状态 round-trip 保持位置速度一致', () => {
  for (const t of [0, 5000, 129600, 200000]) {
    const st = stateFromElements(els, t);
    const back = elementsFromState(st.r, st.v, t);
    const again = stateFromElements(back, t + 1234.5);
    const ref = stateFromElements(els, t + 1234.5);
    assert.ok(norm(sub(again.r, ref.r)) < 1e-4, `pos mismatch at ${t}`);
    assert.ok(norm(sub(again.v, ref.v)) < 1e-8, `vel mismatch at ${t}`);
  }
});

test('圆轨道和偏心率轨道 round-trip 都成立', () => {
  for (const e of [0, 1e-5, 0.001, 0.02]) {
    const e0 = { ...els, e, i: 53 * DEG, raan: 120 * DEG };
    const st = stateFromElements(e0, 77777);
    const back = elementsFromState(st.r, st.v, 77777);
    const st2 = stateFromElements(back, 77777);
    assert.ok(norm(sub(st.r, st2.r)) < 1e-3, `e=${e}`);
    assert.ok(Math.abs(back.e - e) < 1e-6);
  }
});

test('RTN 冲量变轨后状态连续且速度改变', () => {
  const fn = makeStateFn(els, [{ t: 10000, dR: 0, dT: 0.001, dN: 0 }]);
  const before = fn(9999.999);
  const after = fn(10000.001);
  assert.ok(norm(sub(before.r, after.r)) < 0.02);
  assert.ok(norm(sub(before.v, after.v)) > 0.0008);
});

test('地面站仰角可见性扫描产生合理窗口', () => {
  const fn = makeStateFn(els, []);
  const samples = { time: [], r: [] };
  for (let t = 0; t <= 86400; t += 30) {
    samples.time.push(t);
    samples.r.push(fn(t).r);
  }
  const contacts = findContacts(samples, [{ id: 'x', name: 's', lat: 40, lon: 116 }], 5 * DEG);
  assert.ok(contacts.length >= 2);
  for (const c of contacts) {
    assert.ok(c.maxEl >= 5 * DEG - 0.01);
    assert.ok(c.end > c.start);
  }
});
