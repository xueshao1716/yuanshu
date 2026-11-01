// 3D 空间：户型规格化、面积、外墙、单文件导出（2026-11-01）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePlan, planStats, planBounds, exteriorWalls, savePlan, listPlans, readPlan, exportHtml, exportPlanFile, safeName } from "../../engine/scene3d.mjs";

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
