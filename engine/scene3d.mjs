// ===== scene3d.mjs —— 创作台 3D 空间：户型数据 + 单文件导出（2026-11-01）=====
//
// 来源：Floorplan 3D（一个 html 摆好整个家）与 NVIDIA GATOR（照片→3D 资产）两篇文章。
// 我们做的是**能落地的部分**：
//   · 2D 户型数据（房间/家具）→ 面积、造价估算
//   · 单文件 HTML 导出：不引任何外部依赖，纯 canvas 画等距 3D，双击就能看
// 真正的实时 3D 漫游在前端用 three.js 做（创作台里）。
import fs from "node:fs";
import path from "node:path";

/**
 * 家具预设：尺寸（米）、主色、以及 3D 里的部件组合（相对坐标，原点在左下前角）。
 * 部件用盒体拼，够看出是沙发/床/桌，不追求精细建模。
 */
export const FURNITURE_PRESETS = {
  sofa:  { label: "沙发", w: 2.2, d: 0.9, h: 0.8, color: "#8a6b52", parts: [{ x: 0, y: 0, z: 0, w: 2.2, h: 0.45, d: 0.9, c: "seat" }, { x: 0, y: 0.45, z: 0.72, w: 2.2, h: 0.35, d: 0.18, c: "back" }, { x: 0, y: 0, z: 0, w: 0.18, h: 0.6, d: 0.9, c: "back" }, { x: 2.02, y: 0, z: 0, w: 0.18, h: 0.6, d: 0.9, c: "back" }] },
  bed:   { label: "床", w: 1.8, d: 2.0, h: 0.6, color: "#b9b2a6", parts: [{ x: 0, y: 0, z: 0, w: 1.8, h: 0.35, d: 2.0, c: "seat" }, { x: 0, y: 0.35, z: 0, w: 1.8, h: 0.22, d: 1.5, c: "soft" }, { x: 0, y: 0, z: 1.9, w: 1.8, h: 0.9, d: 0.1, c: "back" }] },
  table: { label: "桌子", w: 1.4, d: 0.8, h: 0.75, color: "#9a7b4f", parts: [{ x: 0, y: 0.68, z: 0, w: 1.4, h: 0.07, d: 0.8, c: "top" }, { x: 0.05, y: 0, z: 0.05, w: 0.08, h: 0.68, d: 0.08, c: "leg" }, { x: 1.27, y: 0, z: 0.05, w: 0.08, h: 0.68, d: 0.08, c: "leg" }, { x: 0.05, y: 0, z: 0.67, w: 0.08, h: 0.68, d: 0.08, c: "leg" }, { x: 1.27, y: 0, z: 0.67, w: 0.08, h: 0.68, d: 0.08, c: "leg" }] },
  chair: { label: "椅子", w: 0.5, d: 0.5, h: 0.9, color: "#7d6a55", parts: [{ x: 0, y: 0.42, z: 0, w: 0.5, h: 0.06, d: 0.5, c: "top" }, { x: 0, y: 0.48, z: 0.44, w: 0.5, h: 0.42, d: 0.06, c: "back" }] },
  cabinet: { label: "柜子", w: 1.2, d: 0.45, h: 2.0, color: "#8e8577", parts: [{ x: 0, y: 0, z: 0, w: 1.2, h: 2.0, d: 0.45, c: "body" }] },
  rug:   { label: "地毯", w: 2.4, d: 1.6, h: 0.02, color: "#a89484", parts: [{ x: 0, y: 0, z: 0, w: 2.4, h: 0.02, d: 1.6, c: "soft" }] },
  plant: { label: "绿植", w: 0.5, d: 0.5, h: 1.1, color: "#4c6b4a", parts: [{ x: 0.18, y: 0, z: 0.18, w: 0.14, h: 0.35, d: 0.14, c: "leg" }, { x: 0, y: 0.35, z: 0, w: 0.5, h: 0.75, d: 0.5, c: "soft" }] },
  door:  { label: "门", w: 0.9, d: 0.1, h: 2.0, color: "#6f5a45", parts: [{ x: 0, y: 0, z: 0, w: 0.9, h: 2.0, d: 0.1, c: "body" }] },
  window: { label: "窗", w: 1.4, d: 0.1, h: 1.2, color: "#9fc6d8", parts: [{ x: 0, y: 0.9, z: 0, w: 1.4, h: 1.2, d: 0.1, c: "soft" }] },
};

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
    h: Math.max(0.05, round(it?.h ?? 0.75)),
    rot: ((Math.round(Number(it?.rot) || 0) % 360) + 360) % 360,
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

/** 分房间的造价明细（给报价单用）。 */
export function planCostBreakdown(plan = {}, { pricePerSqm = 0 } = {}) {
  const p = normalizePlan(plan);
  const rows = p.rooms.map((r) => {
    const area = Number((r.w * r.d).toFixed(2));
    return { name: r.name, area, cost: pricePerSqm > 0 ? Number((area * pricePerSqm).toFixed(2)) : 0 };
  });
  const area = Number(rows.reduce((a, r) => a + r.area, 0).toFixed(2));
  return { rows, area, cost: pricePerSqm > 0 ? Number((area * pricePerSqm).toFixed(2)) : 0 };
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

/**
 * 两个房间能否合并：同一轴向上贴边（间距 < 0.15m）或重叠。
 * 合并取包围盒。
 */
export function mergeRooms(a, b) {
  const gap = 0.15;
  const touchX = Math.abs(a.x + a.w - b.x) <= gap || Math.abs(b.x + b.w - a.x) <= gap;
  const touchZ = Math.abs(a.z + a.d - b.z) <= gap || Math.abs(b.z + b.d - a.z) <= gap;
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0;
  const overlapZ = Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z) > 0;
  const adjacent = touchX || touchZ;
  if (!adjacent && !(overlapX && overlapZ)) return { ok: false, reason: "两间不相邻" };
  const x = Math.min(a.x, b.x), z = Math.min(a.z, b.z);
  const w = Math.max(a.x + a.w, b.x + b.w) - x;
  const d = Math.max(a.z + a.d, b.z + b.d) - z;
  return { ok: true, room: { ...a, x, z, w: Number(w.toFixed(2)), d: Number(d.toFixed(2)), name: a.name } };
}

/** 把一间房沿较长的一条边拆成两间。 */
export function splitRoom(room) {
  if (!room) return { ok: false, reason: "没有房间" };
  const alongX = room.w >= room.d;
  if (alongX) {
    const half = Number((room.w / 2).toFixed(2));
    if (half < 0.5) return { ok: false, reason: "太窄了，拆不开" };
    return {
      ok: true,
      rooms: [
        { ...room, w: half, name: `${room.name}A` },
        { ...room, x: Number((room.x + half).toFixed(2)), w: Number((room.w - half).toFixed(2)), name: `${room.name}B` },
      ],
    };
  }
  const half = Number((room.d / 2).toFixed(2));
  if (half < 0.5) return { ok: false, reason: "太浅了，拆不开" };
  return {
    ok: true,
    rooms: [
      { ...room, d: half, name: `${room.name}A` },
      { ...room, z: Number((room.z + half).toFixed(2)), d: Number((room.d - half).toFixed(2)), name: `${room.name}B` },
    ],
  };
}

/**
 * 找出落在这间房四面墙上的门/窗（按轴向和贴边距离判断）。
 * @returns {{side:'N'|'S'|'W'|'E', at:number, len:number, kind:string, sill:number, height:number}[]}
 */
export function openingsForRoom(room, items = []) {
  const eps = 0.3;
  const out = [];
  for (const it of items) {
    if (!["door", "window"].includes(it.kind)) continue;
    const w = it.rot % 180 === 0 ? it.w : it.d;
    const alongX = it.rot % 180 === 0 ? it.x + w / 2 : it.x + it.d / 2;
    const sill = it.kind === "window" ? 0.9 : 0;
    const height = it.kind === "window" ? 1.2 : 2.0;
    // 贴 N/S 墙：z 对齐房间上下边
    if (Math.abs(it.z - room.z) <= eps) out.push({ side: "N", at: alongX - room.x, len: Math.min(w, room.w), kind: it.kind, sill, height });
    else if (Math.abs(it.z + (it.rot % 180 === 0 ? it.d : it.w) - (room.z + room.d)) <= eps) out.push({ side: "S", at: alongX - room.x, len: Math.min(w, room.w), kind: it.kind, sill, height });
    else if (Math.abs(it.x - room.x) <= eps) out.push({ side: "W", at: it.z + w / 2 - room.z, len: Math.min(w, room.d), kind: it.kind, sill, height });
    else if (Math.abs(it.x + (it.rot % 180 === 0 ? it.w : it.d) - (room.x + room.w)) <= eps) out.push({ side: "E", at: it.z + w / 2 - room.z, len: Math.min(w, room.d), kind: it.kind, sill, height });
  }
  return out;
}

/** 一面墙按开口切段：返回若干盒体（含门楣/窗下墙）。 */
export function wallPieces(length, height, openings = []) {
  const segs = openings
    .map((o) => ({ from: Math.max(0, o.at - o.len / 2), to: Math.min(length, o.at + o.len / 2), ...o }))
    .sort((a, b) => a.from - b.from);
  const pieces = [];
  let cursor = 0;
  for (const o of segs) {
    if (o.from > cursor) pieces.push({ from: cursor, to: o.from, y: 0, h: height });
    // 洞下（窗台）与洞上（门楣）
    if (o.sill > 0) pieces.push({ from: o.from, to: o.to, y: 0, h: Math.min(o.sill, height) });
    const top = o.sill + o.height;
    if (top < height) pieces.push({ from: o.from, to: o.to, y: top, h: height - top });
    cursor = Math.max(cursor, o.to);
  }
  if (cursor < length) pieces.push({ from: cursor, to: length, y: 0, h: height });
  return pieces.filter((x) => x.to - x.from > 0.01 && x.h > 0.01);
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
