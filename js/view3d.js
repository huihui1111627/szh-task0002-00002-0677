import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { R_EARTH, DEG, propagate, makeStateFn } from './orbital.js';
import { riskLevel } from './risk.js';

const KM_SCALE = 1;
const OBJ_MARKER = 0.045;

function fmtT(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `T+${h}h${String(m).padStart(2, '0')}m`;
}

export class View3D {
  constructor(container, store) {
    this.container = container;
    this.store = store;
    this.traces = new Map();
    this.markers = new Map();
    this.eventMarkers = [];
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pickables = [];
    this.init();
  }

  init() {
    const el = this.container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070d);

    this.camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 10, 100000);
    this.camera.position.set(14000, 9000, 14000);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = R_EARTH + 120;
    this.controls.maxDistance = 60000;

    // 光照
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 0.6, 0.4);
    this.scene.add(sun);

    // 星空
    this.addStars();
    // 地球
    this.addEarth();
    window.addEventListener('resize', () => this.onResize());
    this.renderer.domElement.addEventListener('click', (e) => this.onClick(e));
    this.clock = new THREE.Clock();
  }

  addStars() {
    const g = new THREE.BufferGeometry();
    const n = 2200;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random();
      const v = Math.random();
      const th = 2 * Math.PI * u;
      const ph = Math.acos(2 * v - 1);
      const r = 52000;
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      pos[i * 3 + 2] = r * Math.cos(ph);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: 0x8b9bb4, size: 90, sizeAttenuation: true, transparent: true, opacity: 0.8 });
    this.scene.add(new THREE.Points(g, m));
  }

  addEarth() {
    const geo = new THREE.SphereGeometry(R_EARTH, 64, 48);
    const mat = new THREE.MeshPhongMaterial({
      color: 0x0d2b4e,
      specular: 0x2a4d7a,
      shininess: 18,
      transparent: true,
      opacity: 0.96,
    });
    this.earth = new THREE.Mesh(geo, mat);
    this.scene.add(this.earth);

    // 经纬网
    const grid = new THREE.Group();
    const gridMat = new THREE.LineBasicMaterial({ color: 0x1d4a7a, transparent: true, opacity: 0.35 });
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = [];
      for (let lon = 0; lon <= 360; lon += 4) {
        pts.push(this.llToVec(lat, lon, R_EARTH + 1));
      }
      grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
    }
    for (let lon = 0; lon < 360; lon += 30) {
      const pts = [];
      for (let lat = -90; lat <= 90; lat += 4) {
        pts.push(this.llToVec(lat, lon, R_EARTH + 1));
      }
      grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
    }
    this.scene.add(grid);
  }

  llToVec(latDeg, lonDeg, radius) {
    const lat = latDeg * DEG;
    const lon = lonDeg * DEG;
    return new THREE.Vector3(
      radius * Math.cos(lat) * Math.cos(lon),
      radius * Math.cos(lat) * Math.sin(lon),
      radius * Math.sin(lat)
    );
  }

  addStations() {
    if (this.stationGroup) {
      this.scene.remove(this.stationGroup);
      this.stationGroup.traverse((x) => x.geometry && x.geometry.dispose && x.geometry.dispose());
    }
    this.stationGroup = new THREE.Group();
    const sc = this.store.state.scenario;
    const geo = new THREE.ConeGeometry(70, 220, 10);
    for (const st of sc.stations) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x6bd0ff });
      const cone = new THREE.Mesh(geo, mat);
      const v = this.llToVec(st.lat, st.lon, R_EARTH + 110);
      cone.position.copy(v);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.clone().normalize());
      cone.userData = { kind: 'station', id: st.id, name: st.name };
      this.stationGroup.add(cone);
      this.pickables.push(cone);
    }
    this.scene.add(this.stationGroup);
  }

  // 根据状态重建全部轨迹/标记（方案或场景变化时调用）
  rebuild() {
    const s = this.store.state;
    const sc = s.scenario;
    this.clearDynamic();
    this.addStations();

    // 非主星对象：完整轨道 + 当前位置标记
    for (const obj of sc.objects) {
      const isPrimary = obj.id === sc.primaryId;
      const fn = makeStateFn(obj.els, []);
      const samples = propagate(fn, sc.t0, sc.t1, 60);
      if (s.showOrbits) {
        const opacity = isPrimary ? 0.0 : s.selectedId && s.selectedId !== obj.id ? 0.25 : 0.5;
        if (!isPrimary && opacity > 0) {
          this.addTrace(`${obj.id}-orbit`, samples.r, obj.color, opacity, false);
        }
      }
      if (!isPrimary) this.addObjectMarker(obj, fn);
    }

    // 基线主星轨迹（虚线）
    if (s.showBaseline) {
      const fn0 = makeStateFn(sc.objects[0].els, []);
      const baseSamples = propagate(fn0, sc.t0, sc.t1, 60);
      this.addTrace('baseline', baseSamples.r, 0x4da3ff, 0.35, true);
    }

    // 各方案主星轨迹
    for (const plan of s.plans) {
      const active = plan.id === s.activePlanId;
      const compared = s.comparedPlanIds.includes(plan.id);
      if (!active && !compared) continue;
      const fn = this.store.planStateFn(plan.id);
      const samples = propagate(fn, sc.t0, sc.t1, 30);
      this.addTrace(
        `plan-${plan.id}`,
        samples.r,
        plan.color,
        active ? 0.95 : 0.4,
        false,
        active ? 2.2 : 1.2
      );
      // 机动点火点
      for (const m of plan.maneuvers) {
        const st = fn(m.t);
        this.addBurnMarker(st.r, m, plan, active);
      }
      // 主星当前位置（仅活动方案）
      if (active) {
        this.primaryFn = fn;
      }
    }
    if (!this.primaryFn) this.primaryFn = makeStateFn(sc.objects[0].els, []);

    // 主星标记
    this.addPrimaryMarker();
    // 交会点
    this.addConjunctionMarkers();
    this.update(s.simTime);
  }

  clearDynamic() {
    for (const [, obj] of this.traces) {
      this.scene.remove(obj.line);
      obj.line.geometry.dispose();
      obj.line.material.dispose();
    }
    this.traces.clear();
    for (const [, group] of this.markers) {
      this.scene.remove(group);
    }
    this.markers.clear();
    this.pickables = this.pickables.filter((x) => x.userData.kind === 'station');
    this.eventMarkers = [];
    this.primaryMarker = null;
  }

  toV3(p) {
    return new THREE.Vector3(p[0] * KM_SCALE, p[1] * KM_SCALE, p[2] * KM_SCALE);
  }

  addTrace(key, positions, color, opacity, dashed, linewidth = 1) {
    const pts = positions.map((p) => this.toV3(p));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    let mat;
    if (dashed) {
      mat = new THREE.LineDashedMaterial({ color, dashSize: 120, gapSize: 90, transparent: true, opacity });
    } else {
      mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, linewidth });
    }
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    this.scene.add(line);
    this.traces.set(key, { line });
  }

  addObjectMarker(obj, fn) {
    const group = new THREE.Group();
    const radius = obj.type === 'satellite' ? 90 : 55;
    const geo = new THREE.SphereGeometry(radius, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ color: obj.color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { kind: 'object', id: obj.id, name: obj.name };
    group.add(mesh);
    this.pickables.push(mesh);
    this.scene.add(group);
    this.markers.set(obj.id, { group, mesh, fn, baseScale: 1 });
  }

  addPrimaryMarker() {
    const group = new THREE.Group();
    const geo = new THREE.SphereGeometry(110, 20, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0x4da3ff });
    const mesh = new THREE.Mesh(geo, mat);
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(130, 175, 32),
      new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
    );
    group.add(mesh);
    group.add(halo);
    this.scene.add(group);
    this.primaryMarker = { group, halo };
  }

  addBurnMarker(pos, maneuver, plan, active) {
    const group = new THREE.Group();
    const geo = new THREE.OctahedronGeometry(active ? 130 : 95, 0);
    const mat = new THREE.MeshBasicMaterial({ color: plan.color, wireframe: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(this.toV3(pos));
    mesh.userData = { kind: 'burn', planId: plan.id, maneuverId: maneuver.id, name: `${plan.name} 点火 ${fmtT(maneuver.t)}` };
    this.scene.add(mesh);
    this.pickables.push(mesh);
    this.markers.set(`burn-${plan.id}-${maneuver.id}`, { group: mesh, mesh, spin: true });
  }

  addConjunctionMarkers() {
    const s = this.store.state;
    const sc = s.scenario;
    const activePlan = this.store.activePlan();
    const eventSource = activePlan ? activePlan.result.events : this.allBaselineEvents();

    for (const ev of eventSource) {
      const rl = riskLevel(ev.pc);
      const key = `${ev.objectId}@${Math.round(ev.tca)}`;
      const group = new THREE.Group();
      const size = ev.pc >= 1e-4 ? 150 : ev.pc >= 1e-6 ? 105 : 70;
      const geo = new THREE.RingGeometry(size, size * 1.35, 40);
      const mat = new THREE.MeshBasicMaterial({
        color: rl.color,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(geo, mat);
      ring.position.copy(this.toV3(ev.posSat));
      ring.lookAt(0, 0, 0);
      ring.userData = {
        kind: 'event',
        key,
        name: `${ev.objectName} 交会 ${fmtT(ev.tca)}`,
        event: ev,
      };
      this.scene.add(ring);
      this.pickables.push(ring);
      this.eventMarkers.push({ mesh: ring, tca: ev.tca, key });
      this.markers.set(`event-${key}`, { group: ring, mesh: ring });
    }
  }

  allBaselineEvents() {
    const out = [];
    for (const evs of this.store.state.scenario.baseline.eventsByObj.values()) out.push(...evs);
    return out;
  }

  update(simTime) {
    const s = this.store.state;
    const sc = s.scenario;
    // 非主星对象位置
    for (const [id, rec] of this.markers) {
      if (rec.fn) {
        const st = rec.fn(simTime);
        rec.mesh.position.copy(this.toV3(st.r));
        const selected = s.selectedId === id;
        rec.mesh.scale.setScalar(selected ? 1.8 : 1);
      }
      if (rec.spin) rec.mesh.rotation.y += 0.03;
    }
    // 主星
    if (this.primaryMarker) {
      const st = this.primaryFn(simTime);
      this.primaryMarker.group.position.copy(this.toV3(st.r));
      this.primaryMarker.group.lookAt(this.camera.position);
    }
    // 交会点：风险时间窗（TCA±30min）内脉冲高亮
    for (const em of this.eventMarkers) {
      const dt = Math.abs(simTime - em.tca);
      const inWindow = dt < 1800;
      const near = Math.max(0, 1 - dt / 1800);
      em.mesh.material.opacity = inWindow ? 0.55 + 0.45 * near : 0.55;
      const sc2 = inWindow ? 1 + 0.6 * near : 1;
      em.mesh.scale.setScalar(sc2);
      if (s.focusEventKey === em.key) em.mesh.material.opacity = 1;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  focusOnObject(id) {
    const rec = this.markers.get(id);
    if (rec && rec.mesh) this.controls.target.copy(rec.mesh.position);
  }

  focusPosition(pos) {
    this.controls.target.copy(this.toV3(pos));
  }

  onClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    if (!hits.length) return;
    const data = hits[0].object.userData;
    if (data.kind === 'object') {
      this.store.select(data.id);
      this.focusOnObject(data.id);
    } else if (data.kind === 'event') {
      this.store.select(data.event.objectId);
      this.store.focusEvent(data.key);
      this.store.setSimTime(data.event.tca);
    } else if (data.kind === 'station') {
      this.store.select(data.id);
    }
  }

  onResize() {
    const el = this.container;
    this.camera.aspect = el.clientWidth / el.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(el.clientWidth, el.clientHeight);
  }

  startLoop(onTick) {
    const animate = () => {
      this.raf = requestAnimationFrame(animate);
      const dt = this.clock.getDelta();
      if (onTick) onTick(dt);
      this.update(this.store.state.simTime);
    };
    animate();
  }
}
