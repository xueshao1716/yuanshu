// 3D 空间：户型规格化、面积、外墙、单文件导出（2026-11-01）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePlan, planStats, planBounds, exteriorWalls, savePlan, listPlans, readPlan, exportHtml, exportPlanFile, safeName, FURNITURE_PRESETS, planCostBreakdown, mergeRooms, splitRoom, openingsForRoom, wallPieces } from "../../engine/scene3d.mjs";

const plan = {
  name: "两室样板",
  rooms: [
    { name: "客厅", x: 0, z: 0, w: 5, d: 4, h: 2.8 },
    { name: "卧室", x: 5, z: 0, w: 3, d: 4, h: 2.8 },
  ],
  items: [{ kind: "sofa", x: 1, z: 1, w: 2, d: 0.9, h: 0.8 }],
};

test("规整：坐标取整到 5cm，尺寸下限生效", () => {
  const p = normalizePlan({ rooms: [{ x: 1.03, z: -0.02, w: 0.1, d: 3, h: 1 }], items: [] });
  assert.equal(p.rooms[0].x, 1.05);
  assert.equal(p.rooms[0].z, 0);
  assert.equal(p.rooms[0].w, 0.5);
  assert.equal(p.rooms[0].h, 2.2);
  assert.equal(p.version, 1);
  assert.equal(p.units, "m");
});

test("面积：按房间累加，单价算总价", () => {
  const s = planStats(plan, { pricePerSqm: 3000 });
  assert.equal(s.area, 32); // 20 + 12
  assert.equal(s.cost, 96000);
  assert.equal(s.rooms.length, 2);
});

test("包围盒：覆盖所有房间", () => {
  const b = planBounds(plan);
  assert.equal(b.minX, 0);
  assert.equal(b.maxX, 8);
  assert.equal(b.spanX, 8);
  assert.equal(b.spanZ, 4);
});

test("外墙：相邻房间的共享边只留一条（共享边不计入外墙）", () => {
  const walls = exteriorWalls(plan);
  // 两个 4x3 房间贴在一起：总边数 8，去掉共享边 2 条 = 6 条
  assert.equal(walls.length, 6);
});

test("保存/读取/列表", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scene-"));
  const out = savePlan(root, plan);
  assert.equal(out.ok, true);
  const list = listPlans(root);
  assert.equal(list.length, 1);
  const back = readPlan(root, "两室样板");
  assert.equal(back.rooms.length, 2);
  assert.equal(back.name, "两室样板");
});

test("文件名安全：非法字符被替换", () => {
  assert.equal(safeName('a/b:c*?"<>|'), "a_b_c______");
});

test("单文件 HTML：内嵌数据、无外部依赖", () => {
  const html = exportHtml(plan, { pricePerSqm: 3000 });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /const PLAN = \{/);
  assert.match(html, /面积 32 ㎡/);
  assert.ok(!/src="http/.test(html), "不应引外部脚本");
  assert.ok(!/import .*three/i.test(html), "不应依赖 three");
});

test("导出文件：写到 生成物/3D 并可再次打开", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scene2-"));
  const out = exportPlanFile(root, plan, { pricePerSqm: 3000 });
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(out.file));
  const html = fs.readFileSync(out.file, "utf8");
  assert.match(html, /两室样板/);
});

test("空户型也能出图（不崩）", () => {
  const html = exportHtml({ name: "空" }, {});
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /const PLAN = \{/);
});

test('旋转归一：只接受 0/90/180/270', () => {
  assert.equal(normalizePlan({ items: [{ rot: 450, w: 1, d: 1, h: 1 }] }).items[0].rot, 90);
  assert.equal(normalizePlan({ items: [{ rot: -90, w: 1, d: 1, h: 1 }] }).items[0].rot, 270);
  assert.equal(normalizePlan({ items: [{ rot: 'x', w: 1, d: 1, h: 1 }] }).items[0].rot, 0);
});

test('家具预设：9 种，每种都有尺寸与部件', () => {
  const kinds = Object.keys(FURNITURE_PRESETS);
  assert.equal(kinds.length, 9);
  for (const k of ['sofa', 'bed', 'table', 'chair', 'cabinet', 'rug', 'plant', 'door', 'window']) assert.ok(kinds.includes(k), k);
  for (const k of kinds) {
    const p = FURNITURE_PRESETS[k];
    assert.ok(p.w > 0 && p.d > 0 && p.h >= 0, k);
    assert.ok(Array.isArray(p.parts) && p.parts.length >= 1, k);
  }
});

test('分房间造价明细', () => {
  const r = planCostBreakdown({ rooms: [{ name: '客厅', w: 5, d: 4 }, { name: '卧室', w: 3, d: 4 }] }, { pricePerSqm: 3000 });
  assert.equal(r.area, 32);
  assert.equal(r.cost, 96000);
  assert.deepEqual(r.rows.map((x) => x.name), ['客厅', '卧室']);
  assert.equal(r.rows[0].cost, 60000);
});

test('合并：相邻两间取包围盒', () => {
  const a = { x: 0, z: 0, w: 4, d: 3, h: 2.8, name: '客厅' };
  const b = { x: 4, z: 0, w: 3, d: 3, h: 2.8, name: '卧室' };
  const r = mergeRooms(a, b);
  assert.equal(r.ok, true);
  assert.deepEqual([r.room.x, r.room.z, r.room.w, r.room.d], [0, 0, 7, 3]);
});

test('合并：不相邻的被拒', () => {
  const a = { x: 0, z: 0, w: 2, d: 2, h: 2.8 };
  const b = { x: 10, z: 10, w: 2, d: 2, h: 2.8 };
  assert.equal(mergeRooms(a, b).ok, false);
});

test('拆分：沿长边对半，两间面积相加等于原来', () => {
  const a = { x: 0, z: 0, w: 5, d: 3, h: 2.8, name: '客厅' };
  const r = splitRoom(a);
  assert.equal(r.ok, true);
  assert.equal(r.rooms.length, 2);
  assert.equal(r.rooms[0].w + r.rooms[1].w, 5);
  assert.equal(r.rooms[1].x, 2.5);
});

test('开口：贴墙的门能被认出来，不贴墙的不会', () => {
  const room = { x: 0, z: 0, w: 4, d: 3, h: 2.8 };
  const onWall = openingsForRoom(room, [{ kind: 'door', x: 1, z: 0, w: 0.9, d: 0.1, rot: 0 }]);
  assert.equal(onWall.length, 1);
  assert.equal(onWall[0].side, 'N');
  const floating = openingsForRoom(room, [{ kind: 'door', x: 1, z: 1.5, w: 0.9, d: 0.1, rot: 0 }]);
  assert.equal(floating.length, 0);
});

test('切段：门洞上方留门楣，下方不留；窗洞上下都留', () => {
  const door = wallPieces(4, 2.8, [{ at: 2, len: 1, sill: 0, height: 2 }]);
  assert.equal(door.length, 3);
  const lintel = door.find((p) => p.y > 0);
  assert.ok(lintel && Math.abs(lintel.h - 0.8) < 0.001, '门楣高 0.8');
  const win = wallPieces(4, 2.8, [{ at: 2, len: 1, sill: 0.9, height: 1.2 }]);
  assert.equal(win.length, 4);
  assert.ok(win.some((p) => p.y === 0 && Math.abs(p.h - 0.9) < 1e-6), '窗下墙');
});
