// engine/reflection-exec.mjs —— 复盘 → 执行（2026-09-17）
//
// 用户的观察："任务中的自我反思，是抓了一堆问题，但是没有主动执行能力了"。
// 查下来确实如此，而且是**结构性的**：定时复盘那一轮只拿到只读工具
// （`timeTaskReadTools` 只留 read/web_search/search_files），它能做的唯一一件事就是
// 在结尾写一份行动清单；清单进承诺账之后，"结清"又只等人给结论。闭环断在最后一米：
// 问题抓了一堆，动作一条没做。
//
// 这个模块补上那一米，但**不拆掉人那道闸**：
//   · 复盘的行动自报 `kind`：fix（当场能修的）/ track（要跨天跟踪）/ ask（要人拍板）；
//   · 只有 fix、且不碰红线（密钥/权限/部署/推送/删数据/花钱）的才进自动执行；
//   · 每轮**最多 3 条**，每条一次执行轮，必须交证据（命令 + 输出摘要 + 改动文件）；
//   · 交不出证据就不算完成：状态只有 done / blocked / failed，原话进账本；
//   · 证据齐了才结清（`closePromise(status:"kept", evidence)`）——这是承诺账头部写明的
//     "由人**或证据**结清"，不是"大概做了吧"的自动判定。
import fs from "node:fs";
import { atomicWriteText } from "./atomic-io.mjs";
import { promisePaths, loadPromises, closePromise } from "./promises.mjs";
import { openTrace, addNode, closeTrace } from "./trace.mjs";
import { currentExplorePolicy, DEFAULT_EXPLORE_POLICY } from "./explore-policy.mjs";
import { verifyArtifacts } from "./verifier.mjs";

export const ACTION_KINDS = Object.freeze(["fix", "track", "ask"]);

/** 每轮自动执行上限：再多就不是"顺手做掉"，而是把复盘变成一个大工程。 */
export const MAX_AUTO_FIX = 3;

/**
 * 不许自动碰的东西。命中就降级成 ask（要人拍板），连试都不试——
 * 这些动作要么不可回滚，要么动的是权限与外部世界。
 */
const FORBIDDEN = /密钥|token|密码|api\s?key|凭据|账号|支付|付费|充值|采购|删除|清库|部署|上线|发布|推送|\bpush\b|\bdeploy\b|重启|改端口|防火墙|安装依赖|npm i\b|yarn add|pnpm add|注册|申请|外部/i;

/** 行动清单里的 kind 只认这三档；没写按 track 处理（保守：不猜它想立刻动手）。 */
export function normalizeActionKind(value) {
  const k = String(value || "").trim().toLowerCase();
  return ACTION_KINDS.includes(k) ? k : "track";
}

/**
 * 分类一条行动：能不能自动执行。
 * 返回 `{ kind, executable, reason }`——reason 会写进日志，让"为什么没自动做"是可见的，
 * 而不是悄悄跳过。
 */
export function classifyAction(action) {
  const text = String(action?.text || "").trim();
  const kind = normalizeActionKind(action?.kind);
  if (kind !== "fix") return { kind, executable: false, reason: kind === "ask" ? "要人拍板" : "跨天跟踪" };
  // 红线先判：短到不足以执行的**红线动作**也必须标成 ask（否则「删除旧数据」这种
  // 七个字会被"描述太短"盖过去，挂着 kind=fix 看着像能自动做）。
  const hit = text.match(FORBIDDEN);
  if (hit) return { kind: "ask", executable: false, reason: `碰红线（${hit[0]}），转人工` };
  if (text.length < 8) return { kind, executable: false, reason: "描述太短，不足以执行" };
  return { kind, executable: true, reason: "" };
}

/** 把一批行动分派成"现在执行的"和"留下的"（留下的保留原 kind，账本照旧追踪）。 */
export function planReflectionExecution(actions, { max = MAX_AUTO_FIX } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const executable = [];
  const deferred = [];
  for (const action of list) {
    const c = classifyAction(action);
    if (c.executable && executable.length < max) executable.push({ ...action, kind: "fix" });
    else deferred.push({ ...action, kind: c.kind, reason: c.executable ? `本轮已到 ${max} 条上限` : c.reason });
  }
  return { executable, deferred };
}

/** 执行轮提示词：一次一条、必须有证据、做不了就说做不了、结尾交 JSON。 */
export function buildActionExecutionPrompt(action, { ymd = "" } = {}) {
  const text = String(action?.text || "").trim();
  return `你在执行复盘给出的一条行动（${ymd || "今天"}）。这是**动手轮**，不是再写一份计划。

行动：${text}

硬约束：
- **只做这一条**。顺手发现别的问题，写进结尾的 summary，不要在这一轮里改。
- 允许 read / write / edit / bash（限工作区内）；改完要能自证：跑测试、跑构建、跑检查命令。
- **证据 = 命令 + 输出摘要 + 改动的文件路径**。没有证据就不许说"已完成"。
- 做不了就如实说：缺什么（blocked）、试过什么、报什么错（failed）。宁可 blocked，不要假装做完。
- 不许碰：密钥/凭据/权限、部署与发布、推远端仓库、重启服务、删除数据、装依赖、花钱。
  需要这些就报 blocked，并写明"需要人来做哪一步"。
- 结尾必须再附一个 JSON 代码块（只能是 JSON，前后不要解释）：
\`\`\`json
{"status":"done|blocked|failed","evidence":"命令与输出摘要（≤200字）","files":["改动或检查过的文件"],"summary":"一句话结论"}
\`\`\``;
}

/** 解析执行轮结果：取**最后**一个 json 块；status 不认识就返回 null（不猜成功）。 */
export function parseActionResult(text) {
  const blocks = [...String(text || "").matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const d = JSON.parse(blocks[i][1]);
      const status = ["done", "blocked", "failed"].includes(d?.status) ? d.status : null;
      if (!status) continue;
      return {
        status,
        evidence: String(d.evidence || "").trim().slice(0, 400),
        files: (Array.isArray(d.files) ? d.files : []).map((f) => String(f).slice(0, 200)).slice(0, 20),
        summary: String(d.summary || "").trim().slice(0, 200),
      };
    } catch { /* 试上一块 */ }
  }
  return null;
}

/** 证据够不够结清：done 且给了证据才算。 */
export function isCloseable(result) {
  return result?.status === "done" && String(result?.evidence || "").trim().length >= 8;
}

const keyOf = (text) => String(text || "").replace(/\s+/g, "").slice(0, 40);

/**
 * 把一次执行的结果记回承诺账。
 * · 账上找不到对应承诺（比如复盘那轮没入库）→ not-found，不新建（账本只该记承诺）。
 * · done+证据 → 结清并写下证据；blocked/failed → 留着 pending，把这次尝试记进 `attempts`，
 *   下一轮复盘带着"上次试过什么"继续追问，而不是从头再来。
 */
export function recordActionAttempt(wsRoot, action, result, { now = new Date(), fsMod = fs } = {}) {
  const text = String(action?.text || "").trim();
  const at = (now instanceof Date ? now : new Date()).toISOString();
  const list = loadPromises(wsRoot, fsMod);
  const hit = list.find((p) => keyOf(p.text) === keyOf(text));
  if (!hit) return { ok: false, reason: "承诺账里没有这条行动", id: null };
  const attempt = {
    at,
    status: result?.status || "failed",
    evidence: String(result?.evidence || "").slice(0, 400),
    files: Array.isArray(result?.files) ? result.files.slice(0, 20) : [],
    summary: String(result?.summary || "").slice(0, 200),
  };
  hit.attempts = [...(Array.isArray(hit.attempts) ? hit.attempts : []), attempt].slice(-10);
  // 先写 attempts 再结清：closePromise 会重新读文件，顺序反了会把 attempts 覆盖掉。
  try {
    fsMod.mkdirSync(promisePaths(wsRoot).dir, { recursive: true });
    atomicWriteText(promisePaths(wsRoot).file, JSON.stringify(list, null, 2));
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 80), id: hit.id };
  }
  if (isCloseable(result)) {
    closePromise(wsRoot, hit.id, { status: "kept", evidence: attempt.evidence, now }, fsMod);
    return { ok: true, id: hit.id, closed: true, status: attempt.status };
  }
  return { ok: true, id: hit.id, closed: false, status: attempt.status };
}

/** 一轮执行之后给人看的一句话（写进时间引擎日志与台前）。 */
export function summarizeExecution(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";
  const done = list.filter((r) => r.status === "done").length;
  const blocked = list.filter((r) => r.status === "blocked").length;
  const failed = list.filter((r) => r.status === "failed" || !r.status).length;
  const parts = [`本自动执行 ${list.length} 条：完成 ${done}`];
  if (blocked) parts.push(`受阻 ${blocked}`);
  if (failed) parts.push(`失败 ${failed}`);
  return parts.join("，");
}

// ── 任务中当场修（2026-09-17 第二轮）──────────────────────────────────────
//
// 复盘那条链是"事后"的：定时任务到点才跑。用户在任务里看到的现象是——发现问题写进结论，
// 但不当场动手。这一节把同一套规则搬到**任务过程中**：agent 干活时发现可修的问题，
// 调 fix_problem 当场派一个执行轮，拿到证据再继续（结果直接回到它手里，它能接着汇报）。
//
// 边界与复盘那条完全一致，另外加一条**预算**：同一个会话 10 分钟内最多 3 次，
// 免得"顺手修"变成把用户的一轮对话拖成一串自动执行。

/** 每个会话的"当场修"预算（内存态，进程重启即清零——它约束的是对话节奏，不是账本）。 */
const budgets = new Map();
export const ON_THE_SPOT_MAX = 3;
export const ON_THE_SPOT_WINDOW_MS = 10 * 60 * 1000;

/** 纯函数版预算判定：够就 true 并记账；不够就 false（reason 说明为什么）。 */
export function takeOnTheSpotBudget(key, { max = ON_THE_SPOT_MAX, windowMs = ON_THE_SPOT_WINDOW_MS, now = Date.now(), store = budgets } = {}) {
  const k = String(key || "anon");
  const cur = store.get(k);
  const fresh = cur && now - cur.at < windowMs ? cur : { at: now, n: 0 };
  if (fresh.n >= max) {
    store.set(k, fresh);
    return { ok: false, reason: `同一会话 ${Math.round(windowMs / 60000)} 分钟内最多当场修 ${max} 次（已达上限）` };
  }
  store.set(k, { at: fresh.at, n: fresh.n + 1 });
  return { ok: true, used: fresh.n + 1, max };
}

/**
 * 当场修一条问题。核心逻辑（可单测）：红线 → 拒绝；预算 → 判定；执行轮 → 解析结果。
 * `runTurn(prompt)` 由调用方注入（server 里是 unifiedChat），这样这一层不依赖任何引擎。
 *
 * 2026-09-18：顺手记一条**探索轨迹**（engine/trace.mjs）——"试了什么动作、花了多久、结果如何"
 * 落成可回放的节点。有了它，"试几次就放弃/先试哪条"这类探索策略才有可能离线回放比较；
 * 只写文本日志是回放不了的。wsRoot 没给就跳过记录（纯单测场景）。
 */
export async function runOnTheSpotFix({ problem, runTurn, sessionKey = "anon", now = Date.now(), store = budgets, max = ON_THE_SPOT_MAX, windowMs = ON_THE_SPOT_WINDOW_MS, wsRoot = "" } = {}) {
  const text = String(problem || "").trim();
  const cls = classifyAction({ text, kind: "fix" });
  if (!cls.executable) {
    // 红线与"要人拍板"的，一律不自动动手；把该说的话交回给模型，让它去汇报。
    return {
      ok: false,
      refused: true,
      reason: cls.reason,
      text: `这条不能当场自动修（${cls.reason}）。请把它写进给用户的结论里，并说明需要谁来做哪一步。`,
    };
  }
  const budget = takeOnTheSpotBudget(sessionKey, { max, windowMs, now, store });
  if (!budget.ok) return { ok: false, refused: true, reason: budget.reason, text: `${budget.reason}。请把这条问题写进结论里交给用户决定。` };
  let result = null;
  let traceId = "";
  let attemptId = null;
  if (wsRoot) {
    try {
      const opened = openTrace(wsRoot, { kind: "fix-attempt", goal: text });
      if (opened?.ok) traceId = opened.trace.id;
    } catch { /* 记录失败不影响修 */ }
  }
  // 探索策略（engine/explore-policy.mjs）：失败后**要不要再试、再试几次**是运行时旋钮，
  // 由做梦/授权状改。每次尝试都单独落一个轨迹节点 —— 这样"试几次"这件事才有可回放的数据。
  let retryTimes = DEFAULT_EXPLORE_POLICY.retryOnFailure;
  if (wsRoot) {
    try { retryTimes = Math.max(0, Number(currentExplorePolicy(wsRoot).retryOnFailure) || 0); } catch {}
  }
  const startedAt = Date.now();
  for (let attempt = 0; attempt <= retryTimes; attempt++) {
    let attemptResult = null;
    const t0 = Date.now();
    try {
      const reply = await runTurn(buildActionExecutionPrompt({ text }, { ymd: "" }));
      attemptResult = parseActionResult(reply);
    } catch (e) {
      attemptResult = { status: "failed", evidence: `执行轮异常：${String(e?.message || e).slice(0, 140)}`, files: [], summary: "" };
    }
    if (!attemptResult) attemptResult = { status: "failed", evidence: "执行轮没有按契约给出结果（缺 JSON 块或 status 不合法）", files: [], summary: "" };
    result = attemptResult;
    if (traceId) {
      try {
        const recorded = addNode(wsRoot, traceId, {
          action: attempt === 0 ? "执行轮" : `执行轮·重试${attempt}`,
          input: text,
          cost: Number(((Date.now() - t0) / 1000).toFixed(2)),
          outcome: attemptResult.status,
          score: 0,
        });
        attemptId = recorded?.node?.id || null;
      } catch { /* 记录失败不影响结论 */ }
    }
    if (attemptResult.status === "done") break;      // 成了就不再来
  }
  // 独立验证（2026-09-18）：执行轮说 done **不算数**——再派一个只看产物、看不到执行者推理的验证轮。
  // 不过验证就不许当成功（这正是 RSIAgent 那条"执行者不能自宣成功"）。
  let verification = null;
  if (result.status === "done" && typeof runTurn === "function") {
    const artifacts = Array.isArray(result.files) && result.files.length ? result.files : [];
    try {
      verification = await verifyArtifacts({
        wsRoot, traceId, attemptId,
        claim: text,
        artifacts,
        runTurn,
      });
    } catch (e) {
      verification = { verdict: "UNVERIFIED", evidence: `验证轮异常：${String(e?.message || e).slice(0, 120)}`, checks: [], tampered: false, changed: [] };
    }
    if (verification.verdict !== "PASS") {
      result = {
        ...result,
        status: verification.verdict === "FAIL" ? "failed" : "blocked",
        evidence: `独立验证未通过（${verification.verdict}）：${verification.evidence}`,
        summary: result.summary,
      };
    }
  }
  if (traceId) {
    closeTrace(wsRoot, traceId, { result: result.status, score: result.status === 'done' ? 1 : 0,
      cost: Number(((Date.now() - startedAt) / 1000).toFixed(2)) });
  }
  const label = { done: "已当场修好（独立验证 PASS）", blocked: "没做成（受阻）", failed: "没做成（失败）" }[result.status] || result.status;
  return {
    ok: result.status === "done",
    status: result.status,
    verification,
    evidence: result.evidence,
    files: result.files,
    summary: result.summary,
    text: [
      `${label}：${text}`,
      `证据：${result.evidence || "（无）"}`,
      result.files?.length ? `改动：${result.files.join("、")}` : "",
      result.status === "done" ? "汇报时可以据实说这条已经修掉并给出上面的证据。" : "汇报时如实说这条没做成、卡在哪，不要含糊过去。",
    ].filter(Boolean).join("\n"),
  };
}
