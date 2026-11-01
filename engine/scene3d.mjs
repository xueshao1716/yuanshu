// ===== scene3d.mjs —— 创作台 3D 空间：户型数据 + 单文件导出（2026-11-01）=====
//
// 来源：Floorplan 3D（一个 html 摆好整个家）与 NVIDIA GATOR（照片→3D 资产）两篇文章。
// 我们做的是**能落地的部分**：
//   · 2D 户型数据（房间/家具）→ 面积、造价估算
//   · 单文件 HTML 导出：不引任何外部依赖，纯 canvas 画等距 3D，双击就能看
// 真正的实时 3D 漫游在前端用 three.js 做（创作台里）。
import fs from "node:fs";
import path from "node:path";

export const SCENE_REL = path.join("生成物", "3D");

export function sceneDir(wsRoot) {
  return path.join(String(wsRoot || "."), SCENE_REL);
}

/** 规整户型：坐标取整到 5cm，尺寸至少 0.5m。 */
export function normalizePlan(plan = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const round = (v) => { const r = Math.round(num(v, 0) * 20) / 20; return Object.is(r, -0) ? 0 : r };
  const rooms = (Array.isArray(plan.rooms) ? plan.rooms : []).map((r, i) => ({
    id: String(r?.id || `room-${i + 1}`),
    name: String(r?.name || `房间${i + 1}`).slice(0, 20),
    x: round(r?.x), z: round(r?.z),
    w: Math.max(0.5, round(r?.w ?? 4)), d: Math.max(0.5, round(r?.d ?? 3)),
    h: Math.max(2.2, round(r?.h ?? 2.8)),
    color: String(r?.color || "#e8e2d8"),
  }));
  const items = (Array.isArray(plan.items) ? plan.items : []).map((it, i) => ({
    id: String(it?.id || `item-${i + 1}`),
    kind: String(it?.kind || "box").slice(0, 20),
    x: round(it?.x), z: round(it?.z),
    w: Math.max(0.2, round(it?.w ?? 0.8)), d: Math.max(0.2, round(it?.d ?? 0.6)),
    h: Math.max(0.2, round(it?.h ?? 0.75)),
    color: String(it?.color || "#b98b5e"),
  }));
  return { version: 1, name: String(plan.name || "未命名空间").slice(0, 40), units: "m", rooms, items };
}

/** 房间面积（㎡）与总价（按每平米单价）。 */
export function planStats(plan = {}, { pricePerSqm = 0 } = {}) {
  const p = normalizePlan(plan);
  const rooms = p.rooms.map((r) => ({ id: r.id, name: r.name, area: Number((r.w * r.d).toFixed(2)) }));
  const area = Number(rooms.reduce((a, r) => a + r.area, 0).toFixed(2));
  return { area, rooms, cost: pricePerSqm > 0 ? Number((area * pricePerSqm).toFixed(2)) : 0, pricePerSqm };
}

/** 场景包围盒（用于自动取景）。 */
export function planBounds(plan = {}) {
  const p = normalizePlan(plan);
  if (!p.rooms.length) return { minX: 0, maxX: 4, minZ: 0, maxZ: 3, cx: 2, cz: 1.5, spanX: 4, spanZ: 3 };
  const minX = Math.min(...p.rooms.map((r) => r.x));
  const maxX = Math.max(...p.rooms.map((r) => r.x + r.w));
  const minZ = Math.min(...p.rooms.map((r) => r.z));
  const maxZ = Math.max(...p.rooms.map((r) => r.z + r.d));
  return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, spanX: maxX - minX, spanZ: maxZ - minZ };
}

/** 外墙线段（去掉相邻房间的共享边，先粗后细：够画等距图）。 */
export function exteriorWalls(plan = {}) {
  const p = normalizePlan(plan);
  const key = (a, b) => [a, b].sort().join("|");
  const seen = new Map();
  for (const r of p.rooms) {
    const corners = [[r.x, r.z], [r.x + r.w, r.z], [r.x + r.w, r.z + r.d], [r.x, r.z + r.d]];
    for (let i = 0; i < 4; i += 1) {
      const a = corners[i].join(","), b = corners[(i + 1) % 4].join(",");
      const k = key(a, b);
      const cur = seen.get(k);
      if (cur) cur.count += 1;
      else seen.set(k, { a: corners[i], b: corners[(i + 1) % 4], count: 1 });
    }
  }
  return [...seen.values()].filter((w) => w.count === 1).map((w) => ({ a: w.a, b: w.b }));
}

/** 保存/读取/列表。 */
export function savePlan(wsRoot, plan) {
  const p = normalizePlan(plan);
  const file = path.join(sceneDir(wsRoot), `${safeName(p.name)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...p, savedAt: new Date().toISOString() }, null, 2), "utf8");
  return { ok: true, file, name: p.name };
}

export function listPlans(wsRoot) {
  try {
    return fs.readdirSync(sceneDir(wsRoot)).filter((f) => f.endsWith(".json")).map((f) => {
      const st = fs.statSync(path.join(sceneDir(wsRoot), f));
      return { name: f.replace(/\.json$/, ""), updatedAt: st.mtimeMs };
    }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  } catch { return [] }
}

export function readPlan(wsRoot, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sceneDir(wsRoot), `${safeName(name)}.json`), "utf8"));
  } catch { return null }
}

export function safeName(name) {
  return String(name || "未命名空间").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "未命名空间";
}

/**
 * 单文件 HTML：等距投影 + 纯 canvas，无任何外部依赖。
 * 双击就能打开，不需要联网、不需要 three.js。
 */
export function exportHtml(plan = {}, { pricePerSqm = 0 } = {}) {
  const p = normalizePlan(plan);
  const stats = planStats(p, { pricePerSqm });
  const data = JSON.stringify(p).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(p.name)} · 3D 空间</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;background:#0f1115;color:#e8e6e3;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  header{padding:14px 18px;border-bottom:1px solid #262a33;display:flex;gap:16px;flex-wrap:wrap;align-items:baseline}
  h1{font-size:15px;margin:0;font-weight:600}
  .stat{font-size:12px;color:#9aa4b2}
  canvas{display:block;width:100%;height:calc(100vh - 56px);cursor:grab}
  canvas:active{cursor:grabbing}
  .hint{font-size:12px;color:#7b8794}
</style></head>
<body>
<header>
  <h1>${escapeHtml(p.name)}</h1>
  <span class="stat">面积 ${stats.area} ㎡</span>
  <span class="stat">房间 ${p.rooms.length} 间</span>
  <span class="stat">家具 ${p.items.length} 件</span>
  ${stats.cost ? `<span class="stat">估算 ¥${stats.cost.toLocaleString()}</span>` : ""}
  <span class="hint">拖动旋转 · 滚轮缩放</span>
</header>
<canvas id="c"></canvas>
<script>
const PLAN = ${data};
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
let yaw = -Math.PI / 5, scale = 1, dpr = Math.min(2, devicePixelRatio || 1);
let drag = null;
function fit() { cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr; draw() }
addEventListener('resize', fit);
cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, yaw }; cv.setPointerCapture(e.pointerId) });
cv.addEventListener('pointermove', e => { if (!drag) return; yaw = drag.yaw + (e.clientX - drag.x) * 0.01; draw() });
cv.addEventListener('pointerup', () => { drag = null });
cv.addEventListener('wheel', e => { e.preventDefault(); scale = Math.max(0.4, Math.min(3, scale * (e.deltaY > 0 ? 0.92 : 1.08))); draw() }, { passive: false });

function project(x, y, z) {
  // 等距：先绕 y 轴转 yaw，再压成等距
  const cx = (PLAN.rooms.length ? PLAN.rooms : [{x:0,z:0,w:4,d:3,h:2.8}]).reduce((a, r) => a + r.x + r.w / 2, 0) / Math.max(1, PLAN.rooms.length);
  const cz = (PLAN.rooms.length ? PLAN.rooms : [{x:0,z:0,w:4,d:3,h:2.8}]).reduce((a, r) => a + r.z + r.d / 2, 0) / Math.max(1, PLAN.rooms.length);
  const dx = x - cx, dz = z - cz;
  const rx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
  const k = Math.min(cv.width / 14, cv.height / 10) * scale;
  return { X: cv.width / 2 + rx * k, Y: cv.height / 2 + (rz * 0.55 - y) * k };
}
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const rooms = PLAN.rooms.length ? PLAN.rooms : [{ x: 0, z: 0, w: 4, d: 3, h: 2.8, color: '#e8e2d8' }];
  // 地面
  for (const r of rooms) {
    const c = [project(r.x, 0, r.z), project(r.x + r.w, 0, r.z), project(r.x + r.w, 0, r.z + r.d), project(r.x, 0, r.z + r.d)];
    ctx.beginPath(); ctx.moveTo(c[0].X, c[0].Y); for (let i = 1; i < 4; i++) ctx.lineTo(c[i].X, c[i].Y); ctx.closePath();
    ctx.fillStyle = r.color; ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = '#2b303a'; ctx.lineWidth = dpr; ctx.stroke();
  }
  // 墙（每间房四个面，画成竖直四边形）
  const faces = [];
  for (const r of rooms) {
    const pts = [[r.x, r.z], [r.x + r.w, r.z], [r.x + r.w, r.z + r.d], [r.x, r.z + r.d]];
    for (let i = 0; i < 4; i++) faces.push({ a: pts[i], b: pts[(i + 1) % 4], h: r.h });
  }
  faces.sort((f, g) => (g.a[1] + g.b[1]) - (f.a[1] + f.b[1]));
  for (const f of faces) {
    const a0 = project(f.a[0], 0, f.a[1]), b0 = project(f.b[0], 0, f.b[1]);
    const a1 = project(f.a[0], f.h, f.a[1]), b1 = project(f.b[0], f.h, f.b[1]);
    ctx.beginPath(); ctx.moveTo(a0.X, a0.Y); ctx.lineTo(b0.X, b0.Y); ctx.lineTo(b1.X, b1.Y); ctx.lineTo(a1.X, a1.Y); ctx.closePath();
    ctx.fillStyle = '#cfc7b8'; ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = '#3a4150'; ctx.stroke();
  }
  // 家具（画成小盒子）
  for (const it of PLAN.items) {
    const x0 = it.x, x1 = it.x + it.w, z0 = it.z, z1 = it.z + it.d, h = it.h;
    const top = [project(x0, h, z0), project(x1, h, z0), project(x1, h, z1), project(x0, h, z1)];
    ctx.beginPath(); ctx.moveTo(top[0].X, top[0].Y); for (let i = 1; i < 4; i++) ctx.lineTo(top[i].X, top[i].Y); ctx.closePath();
    ctx.fillStyle = it.color; ctx.fill(); ctx.strokeStyle = '#1d2129'; ctx.stroke();
    const b0 = project(x0, 0, z1), b1 = project(x1, 0, z1), t1 = project(x1, h, z1), t0 = project(x0, h, z1);
    ctx.beginPath(); ctx.moveTo(b0.X, b0.Y); ctx.lineTo(b1.X, b1.Y); ctx.lineTo(t1.X, t1.Y); ctx.lineTo(t0.X, t0.Y); ctx.closePath();
    ctx.fillStyle = it.color; ctx.globalAlpha = 0.75; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
  }
}
fit();
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** 导出单文件 HTML 到 生成物/3D/<name>.html。 */
export function exportPlanFile(wsRoot, plan, opts = {}) {
  const p = normalizePlan(plan);
  const html = exportHtml(p, opts);
  const file = path.join(sceneDir(wsRoot), `${safeName(p.name)}.html`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, "utf8");
  return { ok: true, file, bytes: Buffer.byteLength(html, "utf8") };
}
