// 回归测试：lateRefs.cultivation 必须在模块初始化期赋值（2026-10-31 真机事故：被塞进 onRunFinished 回调）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const src = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
const lines = src.split(/\r?\n/);

test("lateRefs.cultivation 只有一个赋值，且在 createCultivationRuntime 调用之外（模块初始化期）", () => {
  const hits = lines.map((l, i) => ({ l, i })).filter((x) => /lateRefs\.cultivation\s*=/.test(x.l) && !x.l.trim().startsWith("//"));
  assert.equal(hits.length, 1, `应该有且只有一个赋值点，实际 ${hits.length}`);

  const at = hits[0].i;
  const decl = lines.findIndex((l) => l.includes("const cultivationRuntime = createCultivationRuntime("));
  const after = lines.findIndex((l, i) => i > decl && l.includes("const cultivationApi = createCultivationApi("));
  assert.ok(decl > 0 && after > decl, "找不到运行时声明 / 后续 API 声明");
  assert.ok(at > decl && at < after, "赋值必须在 createCultivationRuntime 之后、createCultivationApi 之前");

  // 关键：赋值行不能落在 createCultivationRuntime 的 options 对象里
  // 也就是它前面最近的一个 "});" 必须是这次调用的收尾
  const lastClose = lines.slice(0, at).map((l, i) => ({ l: l.trim(), i })).filter((x) => x.l === "});").at(-1);
  assert.ok(lastClose && lastClose.i > decl, "赋值前面必须有 createCultivationRuntime 的收尾 });");
});

test("cultivation 工具入口对未就绪有明确错误码（不是笼统 unavailable）", () => {
  assert.match(src, /cultivation_not_ready/);
  assert.ok(src.includes("if (!lateRefs.cultivation)"), "工具入口应先检查运行时是否就绪");
});
