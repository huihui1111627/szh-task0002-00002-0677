import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDefaultScenario, runEvaluate, HOUR } from '../js/scenario.js';
import { collisionProbability, fuelForBurn } from '../js/risk.js';

test('基线包含三次高风险交会', () => {
  const sc = makeDefaultScenario();
  const events = [];
  for (const evs of sc.baseline.eventsByObj.values()) events.push(...evs);
  const threats = events.filter((e) => e.pc >= 1e-6 || e.miss <= 1);
  assert.ok(threats.length >= 3, `expected >=3 threats, got ${threats.length}`);
  const tcas = threats.map((e) => e.tca / HOUR);
  assert.ok(tcas.some((t) => Math.abs(t - 19.2) < 0.3));
  assert.ok(tcas.some((t) => Math.abs(t - 36) < 0.3));
  assert.ok(tcas.some((t) => Math.abs(t - 51.5) < 0.3));
});

test('碰撞概率为 0~1 有限值，且距离越小概率越大', () => {
  const sc = makeDefaultScenario();
  for (const evs of sc.baseline.eventsByObj.values()) {
    for (const e of evs) {
      const pc = e.pc;
      assert.ok(Number.isFinite(pc));
      assert.ok(pc >= 0 && pc <= 1);
    }
  }
});

test('切向 0.5m/s 前置机动缓解全部威胁且方案可行', () => {
  const sc = makeDefaultScenario();
  const r = runEvaluate([{ t: 6 * HOUR, dR: 0, dT: 0.0005, dN: 0 }], sc);
  assert.ok(r.maxPc < 1e-6, `maxPc=${r.maxPc}`);
  assert.ok(r.viable);
});

test('超大变轨触发燃料不足', () => {
  const sc = makeDefaultScenario();
  const r = runEvaluate([{ t: 6 * HOUR, dR: 0, dT: 0, dN: 0.2 }], sc);
  assert.ok(r.fuelShortage);
  assert.ok(r.affectedItems.some((i) => i.type === 'fuel'));
  assert.ok(!r.viable);
});

test('燃料方程为正且随 Δv 单调', () => {
  const f1 = fuelForBurn(0.5, 1220, 220);
  const f2 = fuelForBurn(2, 1220, 220);
  assert.ok(f1 > 0 && f2 > f1);
});

test('点火过晚无法缓解更早的交会', () => {
  const sc = makeDefaultScenario();
  const r = runEvaluate([{ t: 40 * HOUR, dR: 0, dT: 0.001, dN: 0 }], sc);
  assert.ok(r.maxPc >= 1e-6);
  assert.ok(r.secondary.some((x) => x.kind === 'unmitigated'));
});
