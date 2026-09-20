// 应用状态、方案管理与"推演节点"持久化（localStorage）
import { makeDefaultScenario, runEvaluate } from './scenario.js';
import { makeStateFn, propagate } from './orbital.js';

const STORAGE_KEY = 'leo-collision-workspace-v1';

// 推演节点：用户确认（确认推演）时保存的检查点，刷新/中断后可回到最近确认节点继续
function emptyWorkspace() {
  return {
    scenario: null,
    simTime: 0,
    playing: false,
    selectedId: null,
    focusEventKey: null,
    plans: [], // {id,name,color,maneuvers:[{id,t,dR,dT,dN}],result,confirmedAt}
    activePlanId: null,
    comparedPlanIds: [],
    checkpoint: null, // 最近确认的推演节点
    showBaseline: true,
    showOrbits: true,
    showContacts: true,
  };
}

class Store {
  constructor() {
    this.state = emptyWorkspace();
    this.listeners = new Set();
  }

  init() {
    this.state.scenario = makeDefaultScenario();
    const restored = this.load();
    if (restored) {
      // 场景定义是代码内置的，推演窗口/对象始终重建；恢复用户的方案、时间与节点
      this.state.simTime = restored.simTime ?? 0;
      this.state.selectedId = restored.selectedId ?? null;
      this.state.plans = restored.plans ?? [];
      this.state.activePlanId = restored.activePlanId ?? null;
      this.state.comparedPlanIds = restored.comparedPlanIds ?? [];
      this.state.checkpoint = restored.checkpoint ?? null;
      this.state.showBaseline = restored.showBaseline ?? true;
      this.state.showOrbits = restored.showOrbits ?? true;
      this.state.showContacts = restored.showContacts ?? true;
      // 恢复的方案 result 不持久化，重建场景后统一重新评估
      for (const p of this.state.plans) p.result = null;
    } else {
      // 初始无活动方案，中央与左侧先展示无机动基线（含全部威胁）
      this.state.activePlanId = null;
      this.state.comparedPlanIds = [];
    }
    this.reevaluateAll();
    this.emit();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  save() {
    const s = this.state;
    const payload = {
      simTime: s.simTime,
      selectedId: s.selectedId,
      plans: s.plans.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        maneuvers: p.maneuvers,
        confirmedAt: p.confirmedAt ?? null,
      })),
      activePlanId: s.activePlanId,
      comparedPlanIds: s.comparedPlanIds,
      checkpoint: s.checkpoint,
      showBaseline: s.showBaseline,
      showOrbits: s.showOrbits,
      showContacts: s.showContacts,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* 存储不可用时静默降级 */
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // ---- 时间 / 选择 ----
  setSimTime(t) {
    const { t0, t1 } = this.state.scenario;
    this.state.simTime = Math.min(t1, Math.max(t0, t));
    this.emit();
  }

  setPlaying(p) {
    this.state.playing = p;
    this.emit();
  }

  select(id) {
    this.state.selectedId = id;
    this.state.focusEventKey = null;
    this.save();
    this.emit();
  }

  focusEvent(key) {
    this.state.focusEventKey = key;
    this.emit();
  }

  toggleFlag(key) {
    this.state[key] = !this.state[key];
    this.save();
    this.emit();
  }

  // ---- 方案 ----
  addPlan(name) {
    const palette = [0x34c759, 0xff9f0a, 0xbf5af2, 0x00c7be, 0xff6482];
    const plan = {
      id: 'plan-' + Math.random().toString(36).slice(2, 8),
      name: name || `方案 ${this.state.plans.length + 1}`,
      color: palette[this.state.plans.length % palette.length],
      maneuvers: [],
      result: null,
      confirmedAt: null,
    };
    this.state.plans.push(plan);
    this.state.activePlanId = plan.id;
    if (this.state.comparedPlanIds.length < 3) {
      this.state.comparedPlanIds.push(plan.id);
    }
    this.reevaluate(plan.id);
    this.save();
    this.emit();
    return plan;
  }

  removePlan(id) {
    this.state.plans = this.state.plans.filter((p) => p.id !== id);
    this.state.comparedPlanIds = this.state.comparedPlanIds.filter((x) => x !== id);
    if (this.state.activePlanId === id) {
      this.state.activePlanId = this.state.plans[0]?.id ?? null;
    }
    this.save();
    this.reevaluateAll();
    this.emit();
  }

  renamePlan(id, name) {
    const p = this.state.plans.find((x) => x.id === id);
    if (p) p.name = name;
    this.save();
    this.emit();
  }

  duplicatePlan(id) {
    const src = this.state.plans.find((x) => x.id === id);
    if (!src) return;
    const copy = this.addPlan(src.name + '（副本）');
    copy.maneuvers = src.maneuvers.map((m) => ({ ...m, id: 'mn-' + Math.random().toString(36).slice(2, 8) }));
    this.reevaluate(copy.id);
    this.save();
    this.emit();
    return copy;
  }

  setActivePlan(id) {
    this.state.activePlanId = id;
    if (id && !this.state.comparedPlanIds.includes(id) && this.state.comparedPlanIds.length < 3) {
      this.state.comparedPlanIds.push(id);
    }
    this.save();
    this.emit();
  }

  toggleCompare(id) {
    const ids = this.state.comparedPlanIds;
    const i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1);
    else if (ids.length < 3) ids.push(id);
    this.save();
    this.emit();
  }

  addManeuver(planId, partial = {}) {
    const plan = this.state.plans.find((p) => p.id === planId);
    if (!plan) return;
    const t =
      partial.t ??
      (plan.maneuvers.length ? plan.maneuvers[plan.maneuvers.length - 1].t + 6 * 3600 : 6 * 3600);
    plan.maneuvers.push({
      id: 'mn-' + Math.random().toString(36).slice(2, 8),
      t,
      dR: partial.dR ?? 0,
      dT: partial.dT ?? 0.0005,
      dN: partial.dN ?? 0,
    });
    plan.confirmedAt = null;
    this.reevaluate(planId);
    this.save();
    this.emit();
  }

  updateManeuver(planId, mnId, patch) {
    const plan = this.state.plans.find((p) => p.id === planId);
    if (!plan) return;
    const m = plan.maneuvers.find((x) => x.id === mnId);
    if (!m) return;
    Object.assign(m, patch);
    plan.confirmedAt = null;
    this.reevaluate(planId);
    this.save();
    this.emit();
  }

  removeManeuver(planId, mnId) {
    const plan = this.state.plans.find((p) => p.id === planId);
    if (!plan) return;
    plan.maneuvers = plan.maneuvers.filter((x) => x.id !== mnId);
    plan.confirmedAt = null;
    this.reevaluate(planId);
    this.save();
    this.emit();
  }

  reevaluate(planId) {
    const plan = this.state.plans.find((p) => p.id === planId);
    if (!plan) return;
    plan.result = runEvaluate(plan.maneuvers, this.state.scenario);
  }

  reevaluateAll() {
    for (const p of this.state.plans) this.reevaluate(p.id);
  }

  activePlan() {
    return this.state.plans.find((p) => p.id === this.state.activePlanId) || null;
  }

  // 生成方案对应的主星状态函数（供三维视图采样）
  planStateFn(planId) {
    const sc = this.state.scenario;
    const plan = this.state.plans.find((p) => p.id === planId);
    return makeStateFn(sc.objects[0].els, plan ? plan.maneuvers : []);
  }

  // ---- 推演节点：确认当前方案快照 ----
  confirmCheckpoint(planId) {
    const plan = this.state.plans.find((p) => p.id === planId);
    if (!plan) return;
    this.reevaluate(planId);
    plan.confirmedAt = Date.now();
    this.state.checkpoint = {
      planId,
      planName: plan.name,
      maneuvers: plan.maneuvers.map((m) => ({ ...m })),
      simTime: this.state.simTime,
      summary: {
        dvTotal: plan.result.dvTotal,
        maxPc: plan.result.maxPc,
        fuelRemainingKg: plan.result.propellantRemainingKg,
        interruptionTotalSec: plan.result.interruptionTotalSec,
        conflicts: plan.result.affectedItems.length,
        viable: plan.result.viable,
      },
      confirmedAt: Date.now(),
    };
    this.save();
    this.emit();
  }

  resumeCheckpoint() {
    const cp = this.state.checkpoint;
    if (!cp) return;
    // 找到或恢复对应方案
    let plan = this.state.plans.find((p) => p.id === cp.planId);
    if (!plan) {
      plan = this.addPlan(cp.planName + '（恢复）');
      plan.maneuvers = cp.maneuvers.map((m) => ({ ...m }));
      cp.planId = plan.id;
      this.reevaluate(plan.id);
    }
    this.state.activePlanId = plan.id;
    this.state.simTime = cp.simTime ?? 0;
    this.save();
    this.emit();
  }

  clearCheckpoint() {
    this.state.checkpoint = null;
    this.save();
    this.emit();
  }
}

export const store = new Store();
