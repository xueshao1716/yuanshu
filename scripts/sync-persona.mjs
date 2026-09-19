// 一台机器上的"她"只该有一份核心定义：这个脚本把 记忆/人格定义.json 同步到各端。
// 用法：node scripts/sync-persona.mjs [--check]   （--check 只报告，不写）
import { loadPersonaDefinition, syncAllSurfaces } from "../engine/persona-def.mjs";

const wsRoot = process.env.PI_WORKSPACE || "D:\\pi-workspace";
const check = process.argv.includes("--check");
const { def, source, problems } = loadPersonaDefinition(wsRoot);
console.log(`[persona] 核心定义来源=${source} 名字=${def.name} 年龄=${def.age}${problems.length ? " 问题:" + problems.join("；") : ""}`);
if (check) {
  const dry = await import("node:fs");
  const fake = { ...dry, writeFileSync: () => {} };
  const r = syncAllSurfaces(def, { wsRoot, fsMod: fake });
  for (const x of r) console.log(`  ${x.surface.padEnd(10)} ${x.file} → ${x.error ? "✗ " + x.error : (x.changed ? "需要同步" : "已一致")}`);
  process.exit(r.some((x) => x.changed) ? 1 : 0);
}
const r = syncAllSurfaces(def, { wsRoot });
let changed = 0;
for (const x of r) { if (x.changed) changed++; console.log(`  ${x.surface.padEnd(10)} ${x.file} → ${x.error ? "✗ " + x.error : (x.changed ? "已同步" : "已是最新")}`); }
console.log(`[persona] 完成：${changed} 个文件更新`);
