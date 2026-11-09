// ===== evaluator.mjs —— 独立评估器：五维写证据 + 严格更高才接受（2026-11-09）=====
//
// 出处：
//   · evaluate_sop.py —— 五维各 0-2 分（准确/完整/简洁/安全/一致），无证据的维度不算分
//   · sop_validate.py:133-186 —— "严格更高才接受"：候选必须 **>** 参考，不是 ≥
//
// 元枢的两个病：
//   ① 自我改进"同分也能替换"：ratchetGate 用的是「候选 ≥ 基线 − 噪声」+ 零回归，
//      同分照过 → 改了一圈等于没改（白改）。
//   ② 评估者可能就是优化者自己：自己判自己，永远通过。
//
// 这个模块补四件事：
//   1. scoreArtifact：五维 0-2，每维**必须写明证据来源**；没证据 → unevaluated 且 passed:false
//   2. compareToReference：总分严格大于参考才 accept（同分/更低一律拒）
//   3. 判者分离：judge:{sessionId} 必填、不得与写者同会话、判者 tools 必须显式 []；
//      不满足 → 拒绝评估并记 violation（记账文件里留痕）
//   4. 记账：记忆/运行时/评估记账.jsonl（artifact/score/ref_score/dims/at），bestScore(kind) 查历史最高分
//
// 接线：evaluateWithRatchet 建在 evolution-gate.mjs 的 ratchetGate 之上——
// 参考分来自 bestScore，没有历史分就记录首次分并接受；enabled 可关（环境变量 YUANSHU_EVALUATOR=off 亦可）。
//
// ⚠️ 先修掉 Hermes 踩过的那个 bug（evaluate_sop.py:109）：
// 它用「动词开头」判 actionability，而 SOP 步骤都带 "1." 序号 → 三条恒为 0 分。
// 本模块所有文本判定前先归一化：剥掉序号/前缀（见 normalizeStepText / STEP_PREFIX_RE），
// 并有测试钉住「带序号的合格内容能得分」。
import fs from "node:fs";
import path from "node:path";
import {
  RUBRIC_DIMENSIONS, RUBRIC_DIMENSION_LABELS, RUBRIC_MAX_PER_DIMENSION, RUBRIC_PASS,
  ratchetGate,
} from "./evolution-gate.mjs";

export const EVAL_LEDGER_REL = path.join("记忆", "运行时", "评估记账.jsonl");
export const EVAL_DIMENSIONS = RUBRIC_DIMENSIONS;
export const DIMENSION_LABELS = RUBRIC_DIMENSION_LABELS;
export const PASS_LINE = RUBRIC_PASS;
export const MAX_TOTAL = RUBRIC_DIMENSIONS.length * RUBRIC_MAX_PER_DIMENSION;
export const DEFAULT_THRESHOLD = 0;   // 严格大于：Δ > 0，不接受"同分替换"

/**
 * 序号/前缀归一化。Hermes 那个 bug 的根因：先判动词开头，序号还在。
 * 这个正则把「1.」「2、」「3)」「（4）」「步骤5：」「- 」「* 」这些前缀剥掉再判。
 * 注：`3.5 秒` 这种小数不算序号（归一化时额外守一道：`.` 后面跟数字就不剥）。
 */
export const STEP_PREFIX_RE = /^\s*(?:(?:步骤|step)\s*\d{1,3}\s*[:：、.。)）]?|[（(]\s*\d{1,3}\s*[）)]|\d{1,3}\s*[.、)）]\s*|[-*•·+]\s+)/i;

/** 可执行动词表（中文 + 英文）。只用来判"这条是不是可执行的一步"，不判对错。 */
export const ACTION_VERBS = Object.freeze([
  "执行", "运行", "调用", "打开", "关闭", "读取", "写入", "创建", "删除", "移除", "检查", "核对", "验证", "确认",
  "设置", "配置", "安装", "启动", "停止", "重启", "部署", "提交", "发布", "生成", "发送", "接收", "解析", "保存",
  "加载", "记录", "统计", "对比", "比较", "更新", "修改", "替换", "合并", "拆分", "备份", "恢复", "测试", "构建",
  "打包", "上传", "下载", "拉取", "推送", "导入", "导出", "注册", "登录", "访问", "请求", "响应", "初始化", "列出",
  "查询", "搜索", "定位", "修复", "回滚", "重试", "等待", "轮询", "打印", "输出", "收集", "校验", "断言", "绑定",
  "暴露", "挂载", "注入", "清理", "裁剪", "压缩", "解压", "转换", "格式化", "排序", "过滤", "去重", "重命名", "移动",
  "复制", "监控", "观测", "告警", "通知", "提醒", "调度", "编排", "排队", "抢占", "释放", "锁定", "解锁", "分配",
  "回收", "计数", "采样", "打分", "评估", "审查", "复盘", "补充", "确认", "排查", "隔离", "限流", "降级", "兜底",
  "add", "build", "run", "test", "check", "verify", "create", "read", "write", "update", "delete", "remove",
  "install", "start", "stop", "restart", "deploy", "commit", "push", "pull", "fetch", "open", "close", "call",
  "invoke", "parse", "save", "load", "log", "capture", "send", "receive", "scan", "match", "merge", "split",
  "backup", "restore", "publish", "upload", "download", "export", "import", "init", "configure", "set", "get",
  "list", "query", "search", "locate", "fix", "rollback", "retry", "wait", "poll", "print", "output", "collect",
  "validate", "assert", "bind", "mount", "inject", "clean", "compress", "convert", "format", "sort", "filter",
  "rename", "move", "copy", "monitor", "alert", "notify", "schedule", "lock", "unlock", "allocate", "count",
  "sample", "score", "evaluate", "review", "record", "ensure", "apply", "emit", "render", "measure", "compare",
].sort((a, b) => b.length - a.length));

const EPS = 1e-9;
const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
const clamp2 = (n) => Math.max(0, Math.min(RUBRIC_MAX_PER_DIMENSION, Number(n)));
const clean = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const isoOf = (now) => new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString();

// ── 文本归一化（防 Hermes 序号 bug）──────────────────────────────

/** 剥掉步骤序号/前缀/装饰符号，可重复剥（"1. **2)** 运行…" → "运行…"）。 */
export function normalizeStepText(input) {
  let s = String(input ?? "").replace(/\r/g, "").replace(/[*_`~]{1,2}/g, "").trim();
  for (let i = 0; i < 4; i += 1) {
    const m = s.match(STEP_PREFIX_RE);
    if (!m) break;
    const sep = m[0].trim().slice(-1);
    const rest = s.slice(m[0].length);
    // "3.5 秒" 不是序号：点到数字后面就不剥
    if (/[.、]/.test(sep) && /^\d/.test(rest)) break;
    if (!rest.trim()) break;
    s = rest.trim();
  }
  return s;
}

/**
 * 判一条步骤是不是"可执行的一步"：归一化后必须动词开头，且够长。
 * @returns {{actionable:boolean, normalized:string, verb:string, reason:string}}
 */
export function actionabilityOfStep(step, { verbs = ACTION_VERBS } = {}) {
  const raw = typeof step === "object" && step !== null ? (step.text ?? step.step ?? step.content ?? "") : step;
  const normalized = normalizeStepText(raw);
  if (!normalized) return { actionable: false, normalized, verb: "", reason: "空步骤" };
  if (normalized.length < 4) return { actionable: false, normalized, verb: "", reason: `太短（${normalized.length} 字）` };
  const head = normalized.slice(0, 16);
  const hit = (Array.isArray(verbs) && verbs.length ? verbs : ACTION_VERBS)
    .find((v) => String(v).length <= head.length && (head.startsWith(v) || (v.length > 2 && head.toLowerCase().startsWith(String(v).toLowerCase()))));
  if (!hit) return { actionable: false, normalized, verb: "", reason: "剥掉序号/前缀后仍不是动词开头" };
  return { actionable: true, normalized, verb: hit, reason: `动词开头：${hit}` };
}

function stepsOf(artifact) {
  const s = artifact?.steps ?? artifact?.sop ?? artifact?.plan;
  if (!Array.isArray(s)) return null;
  return s.map((x) => (typeof x === "object" && x !== null ? (x.text ?? x.step ?? x.content ?? "") : x)).filter((x) => String(x || "").trim());
}

// ── 五维评分：每维必须带证据来源 ────────────────────────────────

function accuracyEvidence(artifact) {
  const ev = artifact?.evidence || {};
  const rate = (passed, total, label) => ({
    score: passed >= total - EPS ? 2 : passed / total >= 0.9 ? 1 : 0,
    source: `evidence.${label}: ${passed}/${total} 通过`,
  });
  if (Array.isArray(ev.assertions) && ev.assertions.length) {
    const total = ev.assertions.length;
    const passed = ev.assertions.filter((a) => (typeof a === "object" ? a?.ok === true : a === true)).length;
    return rate(passed, total, "assertions");
  }
  if (Array.isArray(ev.commands) && ev.commands.length) {
    const total = ev.commands.length;
    const passed = ev.commands.filter((c) => c?.ok === true).length;
    return rate(passed, total, "commands");
  }
  const tests = ev.tests;
  if (tests && finite(tests.total) !== null) {
    const total = finite(tests.total);
    if (total > 0) {
      const passed = finite(tests.passed) ?? Math.max(0, total - (finite(tests.failed) ?? 0));
      return rate(passed, total, "tests");
    }
  }
  const pr = finite(ev.passRate);
  if (pr !== null) return { score: pr >= 1 - EPS ? 2 : pr >= 0.9 ? 1 : 0, source: `evidence.passRate: ${pr}` };
  const checks = artifact?.checks;
  if (Array.isArray(checks) && checks.length) {
    const total = checks.length;
    const passed = checks.filter((c) => (typeof c === "object" ? c?.ok === true : c === true)).length;
    return rate(passed, total, "artifact.checks");
  }
  return null;
}

function completenessEvidence(artifact, rubric) {
  const ev = artifact?.evidence || {};
  if (Array.isArray(ev.uncovered)) {
    const n = ev.uncovered.length;
    return {
      score: n === 0 ? 2 : n <= 2 ? 1 : 0,
      source: `evidence.uncovered: ${n === 0 ? "没有未覆盖文件" : `${n} 个文件没覆盖`}`,
    };
  }
  const coverage = finite(ev.coverage);
  if (coverage !== null) {
    return { score: coverage >= 1 - EPS ? 2 : coverage >= 0.8 ? 1 : 0, source: `evidence.coverage: ${Math.round(coverage * 100)}%` };
  }
  const steps = stepsOf(artifact);
  if (steps && steps.length) {
    const minSteps = Math.max(1, finite(rubric?.minSteps) ?? 2);
    const rows = steps.map((s) => actionabilityOfStep(s, { verbs: rubric?.verbs }));
    const ok = rows.filter((r) => r.actionable).length;
    const total = rows.length;
    const score = total < minSteps ? 0 : ok === total ? 2 : ok / total >= 0.8 ? 1 : 0;
    return {
      score,
      source: `artifact.steps: ${ok}/${total} 步动词开头（已剥序号/前缀，共 ${total} 步${total < minSteps ? `，少于 ${minSteps} 步` : ""}）`,
      steps: rows.map((r) => ({ normalized: r.normalized, actionable: r.actionable, verb: r.verb })),
    };
  }
  const required = Array.isArray(rubric?.requiredSections) ? rubric.requiredSections.filter(Boolean) : null;
  if (required && required.length) {
    const content = String(artifact?.content ?? "");
    const hit = required.filter((s) => content.includes(String(s))).length;
    return {
      score: hit === required.length ? 2 : hit / required.length >= 0.8 ? 1 : 0,
      source: `rubric.requiredSections: ${hit}/${required.length} 个小节出现`,
    };
  }
  return null;
}

function concisenessEvidence(artifact, rubric) {
  const ev = artifact?.evidence || {};
  const given = finite(ev.conciseness);
  if (given !== null) return { score: clamp2(given), source: `evidence.conciseness: ${given}` };
  const d = ev.diff;
  if (d && typeof d === "object" && (finite(d.added) !== null || finite(d.removed) !== null)) {
    const added = finite(d.added) ?? 0;
    const removed = finite(d.removed) ?? 0;
    const churn = added + removed;
    const files = finite(d.files);
    return {
      score: churn <= 80 ? 2 : churn <= 300 ? 1 : 0,
      source: `evidence.diff: +${added} −${removed} 行${files !== null ? `／${files} 个文件` : ""}`,
    };
  }
  const budget = finite(rubric?.maxChars);
  const content = artifact?.content;
  if (budget !== null && budget > 0 && typeof content === "string") {
    const chars = content.length;
    return {
      score: chars <= budget ? 2 : chars <= budget * 2 ? 1 : 0,
      source: `artifact.content: ${chars} 字符 / 预算 ${budget}`,
    };
  }
  return null;
}

function safetyEvidence(artifact, rubric) {
  const ev = artifact?.evidence || {};
  const hits = Array.isArray(ev.protectedHits) ? ev.protectedHits : null;
  if (hits && hits.length) return { score: 0, source: `evidence.protectedHits: 命中受保护路径 ${hits.length} 处` };
  const gate = String(ev.gate || ev.gateVerdict || "").toUpperCase();
  if (["GREEN", "YELLOW", "RED"].includes(gate)) {
    return { score: gate === "GREEN" ? 2 : gate === "YELLOW" ? 1 : 0, source: `evidence.gate: 交付门 ${gate}` };
  }
  const given = finite(ev.safety);
  if (given !== null) return { score: clamp2(given), source: `evidence.safety: ${given}` };
  const forbidden = Array.isArray(rubric?.forbidden) ? rubric.forbidden.filter((p) => p != null && String(p).length) : null;
  if (forbidden && forbidden.length && typeof (artifact?.content) === "string") {
    const content = String(artifact.content);
    const matched = [];
    for (const p of forbidden) {
      let re = null;
      try { re = p instanceof RegExp ? p : new RegExp(String(p), "i"); } catch { re = null; }
      if (re && re.test(content)) matched.push(String(p));
    }
    return {
      score: matched.length ? 0 : 2,
      source: `rubric.forbidden: 命中 ${matched.length}/${forbidden.length}${matched.length ? `（${matched.slice(0, 3).join("、")}）` : ""}`,
    };
  }
  return null;
}

function consistencyEvidence(artifact, rubric) {
  const ev = artifact?.evidence || {};
  const steps = Array.isArray(ev.steps) ? ev.steps : null;
  if (steps && steps.length) {
    const wanted = ["syntax", "import", "deps"];
    const found = wanted.map((n) => steps.find((s) => s?.name === n)).filter(Boolean);
    if (found.length) {
      const failed = found.filter((s) => s.ok === false).map((s) => s.name);
      if (failed.length) return { score: 0, source: `evidence.steps: ${failed.join("、")} 失败` };
      const allOk = found.length === wanted.length && found.every((s) => s.ok === true && s.skipped !== true);
      return {
        score: allOk ? 2 : 1,
        source: `evidence.steps: ${found.map((s) => `${s.name}=${s.ok === true ? "ok" : "?"}`).join(" ")}`,
      };
    }
  }
  const given = finite(ev.consistency);
  if (given !== null) return { score: clamp2(given), source: `evidence.consistency: ${given}` };
  const required = Array.isArray(rubric?.requiredKeys) ? rubric.requiredKeys.filter(Boolean) : null;
  if (required && required.length && artifact && typeof artifact === "object") {
    const hit = required.filter((k) => artifact[k] !== undefined).length;
    return {
      score: hit === required.length ? 2 : hit / required.length >= 0.8 ? 1 : 0,
      source: `artifact 字段: ${hit}/${required.length} 个必需字段存在`,
    };
  }
  return null;
}

const DERIVATIONS = {
  accuracy: (a) => accuracyEvidence(a),
  completeness: (a, r) => completenessEvidence(a, r),
  conciseness: (a, r) => concisenessEvidence(a, r),
  safety: (a, r) => safetyEvidence(a, r),
  consistency: (a, r) => consistencyEvidence(a, r),
};

/** evidence.dimensions[id] 必须是 {score, source}——只给一个数不算证据。 */
function declaredDimension(artifact, id) {
  const d = artifact?.evidence?.dimensions?.[id];
  if (d === undefined || d === null) return null;
  if (typeof d === "object") {
    const score = finite(d.score);
    const source = clean(d.source || d.evidence || "");
    if (score !== null && source) return { score: clamp2(score), source: `evidence.dimensions.${id}: ${source}` };
    return { score: null, source: "", reason: `evidence.dimensions.${id} 给了分但没写证据来源（source）` };
  }
  return { score: null, source: "", reason: `evidence.dimensions.${id} 只有一个数，没写证据来源` };
}

/**
 * 五维打分。每维 0-2；每维结果**必须带 source（证据来源）**，否则记 unevaluated。
 * unevaluated 的维度不折算成 0 分，而是让整体 passed:false（"证不出来"≠"差"）。
 * @param {object} artifact {id, kind, content, steps, evidence:{tests,assertions,commands,passRate,uncovered,coverage,diff,conciseness,gate,protectedHits,safety,steps,consistency,dimensions}}
 * @param {object} rubric   {passLine, minSteps, verbs, maxChars, forbidden, requiredSections, requiredKeys, kind}
 * @returns {{passed:boolean, ok:boolean, total:number, max:number, passLine:number, dimensions:object, unevaluated:string[], reason:string}}
 */
export function scoreArtifact(artifact = {}, rubric = {}) {
  const a = artifact && typeof artifact === "object" ? artifact : {};
  const r = rubric && typeof rubric === "object" ? rubric : {};
  const passLine = finite(r.passLine) ?? RUBRIC_PASS;
  const dimensions = {};
  const unevaluated = [];
  const reasons = [];
  for (const id of RUBRIC_DIMENSIONS) {
    const declared = declaredDimension(a, id);
    let got = declared && declared.score !== null ? declared : null;
    if (!got && declared && declared.reason) reasons.push(declared.reason);
    if (!got) {
      try { got = DERIVATIONS[id](a, r); } catch { got = null; }
    }
    const score = got ? finite(got.score) : null;
    const source = got ? clean(got.source, 200) : "";
    if (score === null || !source) {
      dimensions[id] = { score: null, source, unevaluated: true, reason: got?.reason || "没有可用证据" };
      unevaluated.push(id);
      continue;
    }
    dimensions[id] = { score: clamp2(score), source, unevaluated: false };
    if (got.steps) dimensions[id].steps = got.steps;
  }
  const total = round3(RUBRIC_DIMENSIONS.reduce((s, id) => s + (dimensions[id]?.score ?? 0), 0));
  const passed = unevaluated.length === 0 && total >= passLine;
  const label = (ids) => ids.map((id) => `${RUBRIC_DIMENSION_LABELS[id] || id}(${id})`).join("、");
  const reason = unevaluated.length
    ? `有 ${unevaluated.length} 维没有证据（${label(unevaluated)}）：不算分，整体不通过（不是 0 分）`
    : passed
      ? `五维都有证据，总分 ${total}/${MAX_TOTAL} ≥ ${passLine} → passed`
      : `五维都有证据，但总分 ${total}/${MAX_TOTAL} < ${passLine} → 不通过`;
  return {
    kind: clean(r.kind || a.kind || "artifact", 60),
    artifact: clean(a.id || a.name || "", 120),
    passed, ok: passed,
    total, max: MAX_TOTAL, passLine,
    dimensions, unevaluated, reason,
    judgeReasons: reasons,
  };
}

// ── 严格比较：候选必须 > 参考 ──────────────────────────────────

function asScore(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? { total: round3(input), dimensions: {}, unevaluated: [] } : null;
  if (typeof input !== "object") return null;
  const dimsSrc = input.dimensions || input.dims || {};
  const dimensions = {};
  const unevaluated = Array.isArray(input.unevaluated) ? [...input.unevaluated] : [];
  for (const [k, v] of Object.entries(dimsSrc && typeof dimsSrc === "object" ? dimsSrc : {})) {
    const n = finite(typeof v === "object" && v !== null ? v?.score : v);
    if (n === null) {
      if (v === null || v === "unevaluated" || (typeof v === "object" && v?.unevaluated === true)) unevaluated.push(k);
      continue;
    }
    dimensions[k] = round3(n);
  }
  let total = finite(input.total ?? input.score);
  if (total === null && Object.keys(dimensions).length) total = round3(Object.values(dimensions).reduce((s, n) => s + n, 0));
  if (total === null) return null;
  return { total: round3(total), dimensions, unevaluated: [...new Set(unevaluated)] };
}

/**
 * 候选 vs 参考：**严格大于**才接受（Δ > threshold，默认 threshold=0 → 同分不接受）。
 * @returns {{accept:boolean, delta:number|null, dims:object|null, threshold:number, regressions:string[], reason:string}}
 */
export function compareToReference({ candidate, reference, threshold = DEFAULT_THRESHOLD } = {}) {
  const t = finite(threshold);
  if (t === null) return { accept: false, delta: null, dims: null, threshold, regressions: [], reason: `阈值不合法：${threshold}` };
  const c = asScore(candidate);
  const r = asScore(reference);
  if (!c) return { accept: false, delta: null, dims: null, threshold: t, regressions: [], reason: "候选分数不可用" };
  if (!r) return { accept: false, delta: null, dims: null, threshold: t, regressions: [], reason: "参考分数不可用" };
  const delta = round3(c.total - r.total);
  if (c.unevaluated.length) {
    return {
      accept: false, delta, dims: null, threshold: t, unevaluated: c.unevaluated, regressions: [],
      reason: `候选有 ${c.unevaluated.length} 维未评（unevaluated）：证不出更好，不接受`,
    };
  }
  const dims = {};
  const regressions = [];
  for (const id of new Set([...Object.keys(c.dimensions), ...Object.keys(r.dimensions)])) {
    const cv = c.dimensions[id];
    const rv = r.dimensions[id];
    if (cv === undefined || rv === undefined) continue;
    dims[id] = { candidate: cv, reference: rv, delta: round3(cv - rv) };
    if (cv < rv - EPS) regressions.push(id);
  }
  const accept = delta > t;
  const reason = accept
    ? `候选 ${c.total} 严格高于参考 ${r.total}（Δ ${delta} > 阈值 ${t}）→ accept`
    : delta === t
      ? `候选 ${c.total} 与参考 ${r.total} 同分（Δ ${delta} = 阈值 ${t}）：不是严格更高 → 不接受`
      : `候选 ${c.total} 不高于参考 ${r.total}（Δ ${delta} ≤ 阈值 ${t}）→ 不接受`;
  return { accept, delta, dims, threshold: t, regressions, reason };
}

// ── 判者分离（评估者不能是写者自己）────────────────────────────

function asWho(x) {
  if (typeof x === "string") return { sessionId: x.trim(), model: "", tools: undefined };
  if (!x || typeof x !== "object") return null;
  return {
    sessionId: String(x.sessionId ?? x.session ?? "").trim(),
    model: String(x.model ?? "").trim(),
    tools: x.tools,
  };
}

/**
 * 判者分离：judge 必填且带 sessionId；sessionId 不得等于写者；判者 tools 必须显式 []。
 * 任一条不满足 → ok:false + violations（调用方据此拒评并记 violation）。
 * @param {{writer:object|string, judge:object|string}} input
 */
export function judgeGate({ writer, judge } = {}) {
  const w = asWho(writer);
  const j = asWho(judge);
  const violations = [];
  if (!w || !w.sessionId) violations.push("缺写者会话标识（writer.sessionId）：无法证明判者不是写者自己");
  if (!j) violations.push("缺判者（judge:{sessionId} 必填）");
  else {
    if (!j.sessionId) violations.push("判者没有会话标识（judge.sessionId 必填）");
    else if (w && w.sessionId && j.sessionId === w.sessionId) {
      violations.push(`写者与判者在同一会话（${j.sessionId}）：自己判自己不算独立评估`);
    }
    if (!Array.isArray(j.tools)) violations.push("判者工具清单不明：必须显式给 tools: []");
    else if (j.tools.length) {
      const list = j.tools.slice(0, 3).map((t) => (typeof t === "string" ? t : t?.name || t?.function?.name || "")).filter(Boolean).join("、");
      violations.push(`判者带了 ${j.tools.length} 个工具（${list}）：判者只读不操作`);
    }
  }
  if (violations.length) return { ok: false, violations, reason: violations.join("；") };
  return {
    ok: true,
    violations: [],
    reason: `判者分离成立：写者 @${w.sessionId} ≠ 判者 @${j.sessionId}，判者零工具`,
    writer: { sessionId: w.sessionId, model: w.model },
    judge: { sessionId: j.sessionId, model: j.model, tools: 0 },
  };
}

// ── 记账（评估记账.jsonl）─────────────────────────────────────

export function ledgerFile(root = ".") {
  return path.join(String(root || "."), EVAL_LEDGER_REL);
}

export function appendEvaluation(root, record = {}) {
  const file = ledgerFile(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n", "utf8");
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

export function readEvaluations(root, { limit = 200 } = {}) {
  try {
    return fs.readFileSync(ledgerFile(root), "utf8")
      .split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .slice(-Math.max(1, limit)).reverse();
  } catch { return []; }
}

/**
 * 历史最高分（kind 维度）。签名兼容两种叫法：bestScore(root, kind) 或 bestScore(kind)。
 * 只认有分数、且不是 violation 的记账行；**被拒的候选（status:"rejected"）不进历史最高分**——
 * 它已经被判过"不比参考好"，拿它抬杠只会让下一轮门槛虚高。同分取最近那条（记账读出来是新→旧）。
 * @returns {{kind:string, score:number, at:string, artifact:string, dims:object, count:number, record:object}|null}
 */
export function bestScore(root, kind) {
  if (kind === undefined) { kind = root; root = "."; }
  const want = String(kind || "artifact");
  const rows = readEvaluations(root, { limit: 10000 })
    .filter((x) => x && x.status !== "refused" && x.status !== "rejected" && x.violation === undefined
      && finite(x.score) !== null && String(x.kind || "artifact") === want);
  if (!rows.length) return null;
  const best = rows.reduce((a, b) => (Number(b.score) > Number(a.score) ? b : a));
  return {
    kind: want,
    score: Number(best.score),
    at: best.at || "",
    artifact: best.artifact || "",
    dims: best.dims && typeof best.dims === "object" ? best.dims : {},
    count: rows.length,
    record: best,
  };
}

function dimsNumbers(score) {
  const out = {};
  for (const [k, v] of Object.entries(score?.dimensions || {})) {
    if (v && typeof v === "object" && finite(v.score) !== null) out[k] = finite(v.score);
  }
  return out;
}

function envEnabled() {
  const v = String(process.env.YUANSHU_EVALUATOR ?? "").trim().toLowerCase();
  return !["0", "off", "false", "no"].includes(v);
}

/**
 * 评一次并记账（不做"是否接受"的判断——那是 evaluateWithRatchet 的事）。
 * 判者不合格 → 拒绝评估，并往记账里写一条 status:"refused" 的 violation。
 * @returns {{ok:boolean, refused:boolean, passed:boolean, reason:string, ...}}
 */
export function evaluateArtifact({ artifact = {}, rubric = {}, judge, writer, root, wsRoot, kind, now = Date.now(), dryRun = false } = {}) {
  const base = String(root || wsRoot || ".");
  const kindOf = clean(kind || rubric?.kind || artifact?.kind || "artifact", 60);
  const label = clean(artifact?.id || artifact?.name || "", 120);
  const gate = judgeGate({ writer, judge });
  if (!gate.ok) {
    const record = {
      at: isoOf(now), kind: kindOf, artifact: label, status: "refused",
      violation: gate.violations, reason: gate.reason, score: null, ref_score: null, dims: null,
    };
    const written = dryRun ? { ok: true, dryRun: true } : appendEvaluation(base, record);
    return { ok: false, refused: true, passed: false, reason: gate.reason, violation: gate.violations, record, written };
  }
  const score = scoreArtifact(artifact, rubric);
  const ref = bestScore(base, kindOf);
  const record = {
    at: isoOf(now), kind: kindOf, artifact: label, status: "evaluated",
    score: score.total, ref_score: ref ? ref.score : null, dims: dimsNumbers(score),
    unevaluated: score.unevaluated, passed: score.passed,
    judge: gate.judge.sessionId, writer: gate.writer.sessionId,
  };
  const written = dryRun ? { ok: true, dryRun: true } : appendEvaluation(base, record);
  return { ok: score.passed, refused: false, ...score, judge: gate.judge, writer: gate.writer, reference: ref, record, written };
}

/**
 * 自改链路用的严格棘轮（建在 evolution-gate.ratchetGate 之上）：
 *   · 参考分 = bestScore(kind)（历史最高分）；没有历史分 → 记录首次分并接受；
 *   · 有参考分 → 候选必须严格更高（compareToReference，Δ>threshold），且 ratchetGate 逐维不许回归；
 *   · enabled:false（或 env YUANSHU_EVALUATOR=off）→ 整体跳过，便于回退。
 * @returns {{ok:boolean, accepted:boolean, skipped?:boolean, first?:boolean, score?:object, reference?:object, delta?:number, reason:string}}
 */
export function evaluateWithRatchet({
  artifact = {}, rubric = {}, judge, writer, root, wsRoot, kind,
  enabled, threshold = DEFAULT_THRESHOLD, now = Date.now(), dryRun = false,
} = {}) {
  const base = String(root || wsRoot || ".");
  const on = enabled === undefined ? envEnabled() : enabled !== false;
  if (!on) {
    return { ok: true, skipped: true, enabled: false, accepted: false, reason: "评估器已关闭（enabled:false）：走回退路径，不做严格比较" };
  }
  const kindOf = clean(kind || rubric?.kind || artifact?.kind || "artifact", 60);
  const label = clean(artifact?.id || artifact?.name || "", 120);
  const gate = judgeGate({ writer, judge });
  const record = (extra) => {
    const row = { at: isoOf(now), kind: kindOf, artifact: label, judge: gate.judge?.sessionId || "", writer: gate.writer?.sessionId || "", ...extra };
    if (!dryRun) appendEvaluation(base, row);
    return row;
  };
  if (!gate.ok) {
    return {
      ok: false, accepted: false, refused: true, reason: gate.reason, violation: gate.violations,
      record: record({ status: "refused", violation: gate.violations, reason: gate.reason, score: null, ref_score: null, dims: null }),
    };
  }
  const score = scoreArtifact(artifact, rubric);
  const ref = bestScore(base, kindOf);
  if (!score.passed) {
    return {
      ok: false, accepted: false, passed: false, reason: score.reason, score,
      record: record({ status: "rejected", score: score.total, ref_score: ref ? ref.score : null, dims: dimsNumbers(score), why: score.reason }),
    };
  }
  if (!ref) {
    return {
      ok: true, accepted: true, first: true, passed: true, score, reference: null,
      reason: `没有历史分（kind=${kindOf}）：记录首次分 ${score.total} 并接受`,
      record: record({ status: "accepted", first: true, score: score.total, ref_score: null, dims: dimsNumbers(score) }),
    };
  }
  const cmp = compareToReference({ candidate: score, reference: ref, threshold });
  const ratchet = ratchetGate({
    candidate: { total: score.total, dimensions: dimsNumbers(score) },
    baseline: { total: ref.score, dimensions: ref.dims },
    threshold: 0,   // 严格模式不接受噪声回撤：同分/回撤都算没变好
  });
  const accepted = cmp.accept === true && ratchet.ok === true;
  const reason = accepted
    ? `${cmp.reason}；棘轮：${ratchet.reason}`
    : cmp.accept !== true
      ? `${cmp.reason}；棘轮：${ratchet.reason}`
      : `严格高于参考分，但棘轮未过：${ratchet.reason}`;
  return {
    ok: accepted, accepted, first: false, passed: true, score, reference: ref,
    delta: cmp.delta, dims: cmp.dims, regressions: ratchet.regressions || [], unevaluatedDims: ratchet.unproven || [],
    reason,
    record: record({
      status: accepted ? "accepted" : "rejected", accepted, score: score.total, ref_score: ref.score,
      delta: cmp.delta, dims: dimsNumbers(score), why: reason, regressions: ratchet.regressions || [],
    }),
  };
}
