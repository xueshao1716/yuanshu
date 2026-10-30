// 行为题库跑分 CLI（2026-10-30）
//
// 用法：
//   node scripts/bench-run.mjs                # 跑全部用例
//   node scripts/bench-run.mjs --only self-portrait-driven
//   node scripts/bench-run.mjs --tag after-fix
//   node scripts/bench-run.mjs --compare 评测/跑分/before-xxx.json
//
// 执行器走本机 API（和人工使用同一条通道），所以跑的是**真实行为**。
import fs from "node:fs";
import path from "node:path";
import { loadCases, runBench, compareRuns, saveRun, casesPath } from "../engine/behavior-bench.mjs";

const argv = process.argv.slice(2);
const arg = (name, def = "") => { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] || def) : def };
const wsRoot = process.env.YUANSHU_WS || "D:/pi-workspace";
const token = (() => {
  try { return fs.readFileSync("C:/Users/xuexiaofeng/AppData/Local/Programs/Yuanshu/app/.token", "utf8").trim() } catch { return process.env.YUANSHU_TOKEN || "" }
})();
const base = process.env.YUANSHU_BASE || "http://127.0.0.1:8787";
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const only = arg("--only");
const tag = arg("--tag", "run");
const compareFile = arg("--compare");
const perCaseTimeoutMs = Number(arg("--timeout", "300")) * 1000;

let cases = loadCases(wsRoot);
if (!cases.length) cases = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..", "assets", "behavior-cases.json"), "utf8")).cases;
if (only) cases = cases.filter((c) => c.id === only);
if (!cases.length) { console.log("没有用例可跑"); process.exit(1) }

/** 从事件流里累加 token 用量（有多少算多少）。 */
function collectUsage(raw) {
  let total = 0, input = 0, output = 0;
  for (const m of String(raw || "").matchAll(/"usage":\{([^}]*)\}/g)) {
    const seg = m[1];
    input += Number((seg.match(/"input"\s*:\s*(\d+)/) || [])[1] || 0);
    output += Number((seg.match(/"output"\s*:\s*(\d+)/) || [])[1] || 0);
    total += Number((seg.match(/"total"\s*:\s*(\d+)/) || [])[1] || 0);
  }
  return total || input + output ? { total: total || input + output, input, output } : null;
}

/** 读 SSE 直到终态或空闲，返回累计文本 + 工具名（不依赖服务端关连接）。 */
async function collectRunEvents(runId, { idleMs = 6000, hardMs = 300000 } = {}) {
  const dec = new TextDecoder();
  let acc = "";
  const started = Date.now();
  const terminal = /"(?:type|status)":"(?:done|completed|failed|stopped|interrupted)"/;
  while (Date.now() - started < hardMs) {
    const ctrl = new AbortController();
    const idle = setTimeout(() => ctrl.abort(), idleMs);
    try {
      const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events?after=0`, { headers: H, signal: ctrl.signal });
      const reader = res.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        if (terminal.test(acc)) { try { await reader.cancel() } catch {} ; return acc }
      }
    } catch { /* abort 或网络中断：带着已收到的继续判 */ }
    finally { clearTimeout(idle) }
    if (terminal.test(acc)) return acc;
  }
  return acc;
}

/** 从会话落地消息里取助手正文（比事件里的 delta 可靠）。 */
async function fetchSessionText(sessionId) {
  try {
    const j = await (await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/messages`, { headers: H })).json();
    const msgs = j.messages || j.items || [];
    return msgs.filter((m) => String(m.role || m.type) === "assistant")
      .map((m) => String(m.content || m.text || ""))
      .join(String.fromCharCode(10));
  } catch { return "" }
}

/** 从文本里挑出真正的评分 JSON（从后往前，只认 score 是数字的）。 */
function pickScoreJson(text) {
  const raw = String(text || "");
  const blocks = [...raw.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).reverse();
  for (const b of blocks) {
    try {
      const o = JSON.parse(b);
      if (o && Number.isFinite(Number(o.score))) return o;
    } catch { /* 跳过模板 */ }
  }
  return null;
}

/** 主观判定：直调模型按 rubric 打分，输出 {score 0~1, reason}。 */
async function judgeAnswer({ rubric, answer, caseId }) {
  const prompt = [
    "你是评分员。只做一件事：按下面的标准给「答案」打分。",
    "评分标准：", String(rubric || "答案是否切题、具体、可用。"),
    "答案：", String(answer || "").slice(0, 4000),
    "严格只输出一行，格式：SCORE: <0到1的小数> | REASON: <一句话理由>",
    "不要解释、不要思考过程、不要别的任何文字。",
  ].join("\n");
  try {
    const r = await fetch(`${base}/api/judge`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ provider: "deepseek", modelId: "deepseek-flash", message: prompt, maxTokens: 2000 }),
    });
    const j = await r.json();
    const text = String(j.text || "");
    // 2026-10-30：模型常先"想一遍"再给 JSON；取第一个花括号会抓到提示词里的模板（含 "0~1" 那种），
    // 所以从后往前找，只认 score 是数字的那个对象。
    // 优先认 "SCORE: 0.8 | REASON: ..."；没有再退回 JSON（模型有时还是给 JSON）
    const line = text.match(/SCORE\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/i);
    let score = line ? Number(line[1]) : NaN;
    let reason = (text.match(/REASON\s*[:：]\s*([^\n|]+)/i) || [])[1] || "";
    if (!Number.isFinite(score)) {
      const parsed = pickScoreJson(text);
      if (parsed) { score = Number(parsed.score); reason = String(parsed.reason || reason || ""); }
    }
    if (!Number.isFinite(score)) {
      return { score: 0, reason: `评分输出无法解析：${text.replace(/\s+/g, " ").slice(0, 120)}` };
    }
    if (score > 1) score = score / 100;
    score = Math.max(0, Math.min(1, score));
    return { score, reason: String(reason || "").trim().slice(0, 200) };
  } catch (e) {
    return { score: 0, reason: `评分失败：${String(e?.message || e).slice(0, 80)}` };
  }
}

async function executor({ input }) {
  const s = await (await fetch(`${base}/api/sessions`, { method: "POST", headers: H, body: JSON.stringify({ name: `题库-${tag}`, group: "bench" }) })).json();
  const r = await fetch(`${base}/api/runs`, { method: "POST", headers: H, body: JSON.stringify({ sessionId: s.id, message: input, clientRequestId: `bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, backgroundRecovery: false }) });
  const j = await r.json();
  if (!j.runId) return { error: `run 创建失败：${JSON.stringify(j).slice(0, 120)}` };
  const all = await collectRunEvents(j.runId, { idleMs: 8000, hardMs: perCaseTimeoutMs });
  const toolCalls = [...new Set([...all.matchAll(/"name":"([a-z0-9_]+)"/g)].map((m) => m[1]))];
  const texts = [...all.matchAll(/"text":"((?:[^"\\]|\\.){0,400})"/g)].map((m) => m[1].replace(/\\n/g, " "));
  const errorEv = /"type":"error"/.test(all) ? (all.match(/"type":"error"[\s\S]{0,200}/) || [""])[0].slice(0, 160) : "";
  const ok = /"(?:type|status)":"(?:done|completed)"/.test(all);
  // 2026-10-30：done 事件可能早于消息落盘，重试几下（最多 ~6s）
  let sessionText = await fetchSessionText(s.id);
  for (let i = 0; i < 5 && !sessionText.trim(); i += 1) {
    await new Promise((x) => setTimeout(x, 1200));
    sessionText = await fetchSessionText(s.id);
  }
  const text = sessionText.trim() || texts.join(" ");
  const usage = collectUsage(all);
  return { text, toolCalls, error: ok ? errorEv : (errorEv || "运行没有正常结束（未见 done/completed）"), usage };
}

console.log(`题库：${casesPath(wsRoot)} · ${cases.length} 条用例`);
// 主观用例：拿到正文后现场评分，塞进 result.judges
const judgedExecutor = async (args) => {
  const out = await executor(args);
  const c = cases.find((x) => x.id === args.id);
  const judgeChecks = (c?.checks || []).filter((x) => x.kind === "judge");
  if (judgeChecks.length && out.text) {
    out.judges = {};
    for (const chk of judgeChecks) {
      out.judges[chk.name || "default"] = await judgeAnswer({ rubric: chk.rubric, answer: out.text, caseId: args.id });
    }
  }
  return out;
};

const run = await runBench({ cases, executor: judgedExecutor, timeoutMs: perCaseTimeoutMs + 20000, onCase: (r) => console.log(`  ${r.pass ? "✔" : "✘"} ${r.title}${r.pass ? "" : " — " + r.failures.join("；")}`) });
run.tag = tag;
const saved = saveRun(wsRoot, run, { tag });
console.log(`\n通过 ${run.passed}/${run.total}（${run.score}%）→ ${saved}`);

if (compareFile) {
  const before = JSON.parse(fs.readFileSync(compareFile, "utf8"));
  const cmp = compareRuns(before, run);
  console.log(`对照：${cmp.summary}`);
  if (cmp.regressions.length) for (const r of cmp.regressions) console.log(`  退化：${r.title} — ${r.failures.join("；")}`);
  if (cmp.verdict === "worse") process.exitCode = 3;
}
