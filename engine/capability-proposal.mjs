// ===== capability-proposal.mjs —— 让知识长出代码（2026-10-26）=====
//
// 用户的原话：知识进化有两个层次——① 给小语长经验（记忆）；② 给元枢长能力（加代码）。
// 「我更想作用到二」。
//
// 但规则抽出来的 claim 是噪声（真实抽样："**好消息**——我之前的判断要修正"），
// 拿它喂代码提案只会产出一堆废话。所以第二层不建在 prose 上，建在**结构化信号**上：
//   ① 外部报回来的崩溃（feedback，带研判结论）
//   ② 卡死/失败的作业（job_status 的 blocked/failed）
//   ③ 我们自己踩过的坑（操作日志里"坑/教训/根因"那些行）
//
// 每个提案必须带四样，缺一不算数：
//   evidence（证据在哪，能点回去）· area（动哪块）· test（用什么测证明修好了）· effect（修了对谁有用）
//
// 生命周期：proposed → accepted → shipped（必须有 version + commit + test）→ verified
// 「shipped 但写不出 test」的提案不允许标记完成——这是"真进化"的底线。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const FILE = path.join("记忆", "运行时", "能力提案.json");
export const MAX_PROPOSALS = 20;

const AREAS = [
  { area: "audio", label: "音频/交付验收", re: /ffmpeg|ebur128|LUFS|响度|音轨|audio|earshot/i },
  { area: "knowledge", label: "知识沉淀", re: /知识|claim|journal|entry|沉淀|租约|admission/i },
  { area: "feedback", label: "反馈/上报", re: /上报|反馈|工单|crash|崩溃|telemetry|ticket/i },
  { area: "render", label: "渲染/视频", re: /渲染|宣传片|视频|ffmpeg.*导出|重渲染|mp4|movie/i },
  { area: "shell", label: "脚本/编码", re: /powershell|pwsh|乱码|utf-?8|bom|encoding/i },
  { area: "deploy", label: "部署/进程", re: /重启|watchdog|端口|EADDRINUSE|release|部署/i },
  { area: "mcp", label: "外部工具", re: /mcp|模型|网关|timeout|超时/i },
];

export function areaOf(text) {
  const s = String(text || "");
  for (const a of AREAS) if (a.re.test(s)) return a;
  return { area: "general", label: "其它" };
}

/**
 * 归一化：抹掉每次都会变的部分（pid / uptime / 退出码 / 时间戳），
 * 否则同一个根因会因为 pid 不同被拆成好几组（真机：三条 code=1 报告成了三条提案）。
 */
export function normalizeSymptom(text) {
  return String(text || "")
    .replace(/pid=\d+/gi, "pid=*")
    .replace(/uptime=\d+s?/gi, "uptime=*")
    .replace(/code=-?\d+/gi, "code=*")
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?/g, "<time>")
    .replace(/\b0x[0-9a-f]+\b/gi, "0x*")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprintOf(area, symptom) {
  const norm = normalizeSymptom(symptom).toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, "").slice(0, 80);
  return createHash("sha1").update(`${area}:${norm}`).digest("hex").slice(0, 12);
}

/**
 * 从三类结构化信号里挖候选能力提案。
 * @returns {{proposals: object[], stats: object}}
 */
export function mineSignals({ wsRoot, now = Date.now() } = {}) {
  const root = String(wsRoot || ".");
  const signals = [];

  // ① 外部崩溃/反馈
  try {
    const box = JSON.parse(fs.readFileSync(path.join(root, "feedback", "inbox.json"), "utf8"));
    for (const it of box.items || []) {
      if (it.kind !== "crash" && !/crash|崩溃/i.test(String(it.title))) continue;
      // code=0 是正常退出（运维 stop/update 触发），不是能力缺口——别再让它变成提案
      if (/\[exit\]\s*code=0\b/i.test(String(it.title))) continue;
      signals.push({
        source: "feedback", at: it.at || 0, id: it.id,
        symptom: String(it.title || "").replace("[自动上报]", "").trim().slice(0, 120),
        severity: 3, detail: String(it.detail || "").slice(0, 400),
      });
    }
  } catch {}

  // ② 卡死/失败的作业
  try {
    const st = JSON.parse(fs.readFileSync(path.join(root, "记忆", "知识", "state.json"), "utf8"));
    const jobs = st.jobs && typeof st.jobs === "object" ? Object.values(st.jobs) : [];
    const byReason = new Map();
    for (const j of jobs) {
      if (!["blocked", "failed"].includes(j.state)) continue;
      const reason = String(j.reason || "unknown");
      byReason.set(reason, (byReason.get(reason) || 0) + 1);
    }
    for (const [reason, count] of byReason) {
      signals.push({
        source: "job", at: now, id: `job:${reason}`,
        symptom: `${count} 个知识作业卡在 ${reason}`,
        severity: 2, detail: `重复 ${count} 次`,
      });
    }
  } catch {}

  // ③ 操作日志暂不作为信号源：试过，抽出来是"第二个坑""根因还有一层"这类半句话，
  //    污染提案列表。宁可少一个来源，也不要有噪声。（真要利用，得先让日志写成结构化条目。）
  // ③ 失败/卡住的后台作业（结构化台账：哪类活老失败）
  try {
    const file = path.join(root, "记忆", "运行时", "待汇报.json");
    const led = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(led.items) ? led.items : Array.isArray(led) ? led : [];
    const byLabel = new Map();
    for (const r of rows) {
      if (!["failed", "stalled"].includes(String(r.state || ""))) continue;
      const label = String(r.label || r.id || "未知作业").replace(/[（(].*?[)）]/g, "").trim().slice(0, 40);
      byLabel.set(label, (byLabel.get(label) || 0) + 1);
    }
    for (const [label, count] of byLabel) {
      if (count < 2) continue; // 一次失败不算模式
      signals.push({ source: "jobledger", at: now, id: `job:${label}`, symptom: `作业「${label}」反复失败 ${count} 次`, severity: 2, detail: "" });
    }
  } catch {}

  // 聚合成提案：同一 area 的多条信号合成一条（重复出现 = 优先级更高）
  const groups = new Map();
  for (const s of signals) {
    const a = areaOf(`${s.symptom} ${s.detail}`);
    const fp = fingerprintOf(a.area, s.symptom);
    const g = groups.get(fp) || { id: fp, area: a.area, areaLabel: a.label, symptoms: [], evidence: [], severity: 0, lastAt: 0 };
    g.symptoms.push(s.symptom);
    g.evidence.push({ source: s.source, id: s.id, at: s.at });
    g.severity = Math.max(g.severity, s.severity);
    g.lastAt = Math.max(g.lastAt, s.at || 0);
    groups.set(fp, g);
  }

  const proposals = [...groups.values()]
    .map((g) => ({
      id: g.id,
      area: g.area,
      areaLabel: g.areaLabel,
      title: `[${g.areaLabel}] ${shortSymptom(g.symptoms[0])}（同类 ${g.symptoms.length} 次）`,
      symptom: g.symptoms[0],
      recurrence: g.symptoms.length,
      severity: g.severity,
      score: Math.round((g.severity * 10 + g.symptoms.length * 5) * 10) / 10,
      evidence: g.evidence.slice(0, 6),
      test: testIdeaFor(g.area),
      effect: effectFor(g.area),
      state: "proposed",
      at: now,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PROPOSALS);

  return { proposals, stats: { signals: signals.length, areas: new Set(proposals.map((p) => p.area)).size } };
}

function shortSymptom(text) {
  const cleaned = normalizeSymptom(text)
    .replace(/^[-*>\s#]+/, "")
    .replace(/\[自动上报\]/g, "")
    .replace(/^crash:\s*/i, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 优先留下"哪里炸的"：文件:行 + 调用点（真机报告长这样：
  // [exit] code=* uptime=* pid=* caller=at Timeout._onTimeout (…/server.mjs:2314:28) <- …）
  const loc = cleaned.match(/([\w.-]+\.(?:mjs|cjs|js|ts)):(\d+)/);
  const fn = cleaned.match(/caller=at\s+([A-Za-z_$.]+)/);
  if (loc) return `进程异常退出于 ${loc[1]}:${loc[2]}${fn ? `（${fn[1]}）` : ""}`;
  // 报告标题在 120 字处被截断，常常截不到「xxx.mjs:行号」——那就只报调用点
  if (fn) return `进程异常退出（${fn[1]} 里的未捕获异常）`;
  const short = cleaned.split(/[。；;（(]/)[0].trim().slice(0, 44);
  return short || "未命名问题";
}

function testIdeaFor(area) {
  return {
    audio: "拿一条真实导出跑 output_check，断言 LUFS/真峰值/音画差在阈值内",
    knowledge: "造一份带已知 claim 的样本，断言入库后 claimType/expiresAt 正确，且 entries() 校验通过",
    feedback: "造一条缺构建号的报告，断言研判为 no_build 且回信含「要补什么」",
    shell: "写一个含中文的脚本跑一遍，断言输出无乱码（对比 UTF-8 字节）",
    deploy: "连续两次 release-restart，断言端口释放、health 200、只有一份实例",
    mcp: "断网场景下调一次外部工具，断言超时后降级而不是挂死",
    general: "补一条能复现该现象的最小测试",
  }[area] || "补一条能复现该现象的最小测试";
}

function effectFor(area) {
  return {
    audio: "交付物不再带着没听过的声音发出去",
    knowledge: "沉淀台里的东西能用、不过期得莫名其妙",
    feedback: "外部报回来的 bug 能被认出来并回信",
    shell: "脚本里不再因为编码问题静默出错",
    deploy: "改一行不会让服务反复重启",
    mcp: "外部依赖挂了也只是降级，不是整台服务崩",
    general: "少一类重复问题",
  }[area] || "少一类重复问题";
}

export function readProposals(wsRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(String(wsRoot), FILE), "utf8")); }
  catch { return { v: 1, updatedAt: 0, items: [] }; }
}

export function writeProposals(wsRoot, data) {
  const file = path.join(String(wsRoot), FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, updatedAt: Date.now(), items: data.items.slice(-MAX_PROPOSALS) }, null, 2), "utf8");
  return data;
}

/** 刷新：保留已 accepted/shipped 的状态与笔记，只更新 proposed 部分。 */
export function refreshProposals(wsRoot, { now = Date.now() } = {}) {
  const old = readProposals(wsRoot);
  const kept = (old.items || []).filter((p) => p.state !== "proposed");
  const { proposals, stats } = mineSignals({ wsRoot, now });
  const keptIds = new Set(kept.map((p) => p.id));
  return { ...writeProposals(wsRoot, { items: [...proposals.filter((p) => !keptIds.has(p.id)), ...kept] }), stats };
}

/** 标记状态；shipped 必须带 version + commit + test，否则拒绝（不许空喊"做完了"）。 */
export function markProposal(wsRoot, id, patch = {}) {
  const data = readProposals(wsRoot);
  const p = (data.items || []).find((x) => x.id === id);
  if (!p) return { error: "not_found" };
  const state = String(patch.state || "");
  if (!["accepted", "shipped", "dropped"].includes(state)) return { error: "invalid_state" };
  if (state === "shipped") {
    const missing = ["version", "commit", "test"].filter((k) => !String(patch[k] || "").trim());
    if (missing.length) return { error: `shipped 缺少 ${missing.join("/")}——写不出「用哪个测试证明修好了」就不算做完` };
    Object.assign(p, { version: String(patch.version), commit: String(patch.commit), test: String(patch.test), shippedAt: Date.now() });
  }
  p.state = state;
  p.updatedAt = Date.now();
  if (patch.note) p.note = String(patch.note).slice(0, 400);
  writeProposals(wsRoot, data);
  return { ok: true, item: p };
}

/** job_status 里的那一行。 */
export function proposalsLine(wsRoot, { now = Date.now() } = {}) {
  const { items = [] } = readProposals(wsRoot);
  const proposed = items.filter((p) => p.state === "proposed");
  if (!proposed.length) return "";
  const top = proposed.slice(0, 2).map((p) => p.title).join("；");
  return `【长能力】${proposed.length} 条能力提案待评估（${top}）——accept 或 drop，别挂着`;
}
