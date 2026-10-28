// 指纹前后对照：拿运行记录比"变化前 vs 变化后"的失败率/工具成功率（2026-10-28）
//
// 用法：node scripts/fingerprint-compare.mjs [--days 14]
// 数据源：记忆/运行时/模型指纹.json（变化时间点）+ agent 的 yuanshu-runs（运行记录）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const days = Number(args[args.indexOf("--days") + 1]) || 14;
const wsRoot = process.env.YUANSHU_WS || "D:/pi-workspace";

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return fallback }
}

// ① 指纹变化时间点
const fp = readJson(path.join(wsRoot, "记忆", "运行时", "模型指纹.json"), { history: [] });
const changes = (fp.history || []).slice().sort((a, b) => a.at - b.at);
if (!changes.length) {
  console.log("没有指纹变化记录——先跑几次直调模型，或等平台换快照。");
  console.log("（今天已记录基线：", Object.values(fp.models || {}).map((m) => `${m.requested} → ${String(m.served).slice(0, 12)}`).join("、") || "无", "）");
  process.exit(0);
}
const last = changes[changes.length - 1];
const when = new Date(last.at);
console.log(`最近一次快照变化：${when.toLocaleString("zh-CN", { hour12: false })}  ${last.requested}  ${String(last.from).slice(0, 12)} → ${String(last.to).slice(0, 12)}`);

// ② 运行记录
const runsDir = path.join(process.env.AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "yuanshu-runs");
const cutoff = Date.now() - days * 86400_000;
let files = [];
try { files = fs.readdirSync(runsDir).filter((f) => f.endsWith(".json")) } catch { console.log("读不到运行记录目录：", runsDir); process.exit(0) }

const runs = [];
for (const f of files) {
  const full = path.join(runsDir, f);
  let st;
  try { st = fs.statSync(full) } catch { continue }
  if (st.mtimeMs < cutoff) continue;
  const j = readJson(full, null);
  if (!j) continue;
  const at = Number(j.createdAt || j.startedAt || st.mtimeMs) || st.mtimeMs;
  runs.push({ at, status: String(j.status || j.state || ""), tools: Array.isArray(j.toolCalls) ? j.toolCalls : [], raw: j });
}

function summarize(rows) {
  const total = rows.length;
  const failed = rows.filter((r) => /fail|error|abort/i.test(r.status)).length;
  let toolOk = 0, toolErr = 0;
  for (const r of rows) for (const t of r.tools) (/error|fail/i.test(String(t?.status || t?.result || "")) ? toolErr++ : toolOk++);
  return { total, failed, failRate: total ? Math.round((failed / total) * 100) : 0, toolOk, toolErr };
}

const before = runs.filter((r) => r.at < last.at);
const after = runs.filter((r) => r.at >= last.at);
const b = summarize(before), a = summarize(after);

const pct = (x) => `${x}%`;
console.log("");
console.log("项目            变化前            变化后");
console.log("运行数          ", String(b.total).padEnd(16), a.total);
console.log("失败率          ", pct(b.failRate).padEnd(16), pct(a.failRate));
console.log("工具调用成功/失败", `${b.toolOk}/${b.toolErr}`.padEnd(15), `${a.toolOk}/${a.toolErr}`);
if (before.length < 5 || after.length < 5) console.log("\n⚠ 样本太少（<5 条），结论不可靠，只作趋势参考。");
