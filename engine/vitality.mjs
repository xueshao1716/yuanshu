// ===== engine/vitality.mjs —— 机制产出新鲜度看板（2026-11-09）=====
//
// 为什么要有它（教训来自 xinyu-hermes 的 48 天假活）：
//   它那边 cron 全部 "exit 0 全绿"，但 4 条 LLM 任务被静默挡下、30 分钟 ingest 一直在 error、
//   守卫写好了从没被调用、verification_events 表 0 行。原话："exit 0 ≠ 干活，
//   判据要盯产出 mtime 不盯进程。"
//
// 元枢这几天新增了一批机制（情绪事件、关系、基因漂移、成长、主动触达、看门狗 incident、
// 遗忘清理、自证准入、verify_check）。它们"在跑"跟"在产出"是两件事：
// 代码 import 进来了、函数被调了，都不代表盘上有东西落下来。
// 这个模块只做一件事：把"每个机制该产出什么、产出落在哪、多久没产出算异常"写成一张
// **可执行的清单**，读盘判 fresh / stale / never / unknown，并给一行能指名道姓的中文摘要。
//
// ---- 四种状态（定义是这份模块的核心，别混）----
//   fresh   证据源在，最后一次产出在阈值内          → 机制确实在产出
//   stale   证据源在，最后产出已超阈值              → 以前能产出，现在停了
//   never   证据源在，但**从来没有过一条匹配的产出** → 载体建起来了，一次账都没落过
//   unknown 证据源本身不存在 / 读不到 / 解析不了     → 没有证据可判，**永远不许当 fresh**
//
// ---- never 和 unknown 到底差在哪（这条得说清，否则看板会骗人）----
//   · never   = 文件是机制的产出物，它存在，但里面没有该机制留下的东西。
//               含义偏"机制没落账"：可能是写入分支没走到、条件写死、或写进了别的 key。
//   · unknown = 连载体都没有。可能是这机制还没被调用过、路径写错、工作区不对、权限读不到。
//               含义偏"不可判"——看板只能说"没证据"，不能替它开脱，也不能给它定罪。
//   两者都**不是** fresh。把它们当 green 就等于重演"exit 0 全绿"。
//   反过来说：按路径写死的清单如果路径本身错了（历史上有过），结果会一片 unknown；
//   这恰恰是有用信号——它提示"清单位置 or 机制落盘位置，二者必有一错"。
//
// ---- 有意不做的事 ----
//   · 不读进程表、不读心跳、不读日志里的"成功"字样：那些都能在没产出时保持漂亮。
//   · 不断言"机制坏了"。看板只陈述证据状态，归因（没接线 / 没到时机 / 写盘失败）留给人。
//   · 不写入任何东西。整个模块只 stat / read，不动工作区。

import fs from "node:fs";
import path from "node:path";

const DAY = 86400000;

// 时间落在未来的容忍度。超过它说明时钟或数据脏了，不当 fresh（宁可 unknown）。
const FUTURE_GRACE_MS = 5 * 60000;

/**
 * 机制清单（常量）。
 *
 * 每项字段：
 *   id           稳定标识（CLI / 测试 / --stale-days id=天 都用它）
 *   name         中文名（摘要里点名用）
 *   kind         "jsonl" | "json" | "glob"
 *   paths        证据来源（相对工作区根；多路时全查、合并计数、取最大时间）
 *   match        jsonl 行过滤：{ field, equals? | prefix? | contains?, notPhase? }
 *   timeField    jsonl 行内时间字段（缺失则退回文件 mtime）
 *   timePath     json 里取时间的字段路径（点分；ISO 字符串或毫秒数）
 *   countPath    json 里取计数的字段路径（数字或数组长度）；不给则"文档在 = 1 份"
 *   pattern      glob 用（只支持一个 *）
 *   staleAfterMs 阈值：最后产出超过这么久算 stale
 *   criterion    判据（表格里的"判据"列，一句话给人看）
 *   note         说明：为什么是这个阈值 / 什么情况下 0 是正常的
 *   code         应该写它的源码文件。用来区分"机制没生效"和"根本没接线"
 *   cadence      驱动方式："turn" 对话轮末才写 / "background" 后台定时 / "manual" 人要主动跑
 *                —— 判红之后第一个该问的是"它有没有机会产出"，cadence 就是这个问题的答案：
 *                对话轮驱动的机制在"今天一轮都没聊"时是 never/unknown 完全正常；
 *                后台驱动的机制在同样情况下，就是策略层把它全挡住了。两者处置完全不同。
 *   lastRowFlag  （可选）jsonl 最后一条的额外判词：返回字符串则附进 detail
 *
 * 阈值取值理由写在各 note 里。总的原则：按**这机制本来的节奏**定，
 * 不按"我希望它多勤快"定——阈值定得太紧，看板天天红，人就不看了。
 */
export const MECHANISMS = Object.freeze([
  {
    id: "emotion-event",
    cadence: "turn",
    name: "情绪事件",
    kind: "jsonl",
    // 注意：任务书写的是 记忆/运行时/情绪潮汐.jsonl，实际 engine/emotion.mjs 的 tideFile()
    // 落在 记忆/情绪潮汐.jsonl。两路都查，谁在就用谁（合并计数），免得路径记忆错就整项 unknown。
    paths: ["记忆/情绪潮汐.jsonl", "记忆/运行时/情绪潮汐.jsonl"],
    match: { field: "source", prefix: "event:" },
    timeField: "ts",
    staleAfterMs: 3 * DAY,
    criterion: "最后一条 source:'event:*' 行 ≤3 天",
    note: "每轮对话里真发生情绪事件才写。3 天没一条 = 情绪事件通道没落地（不是'最近话少'：普通轮次另写无 source 的基线点，两者不是一回事）。",
    code: "engine/emotion.mjs",
  },
  {
    id: "relationship",
    cadence: "turn",
    name: "关系",
    kind: "json",
    paths: ["记忆/运行时/关系.json"],
    timePath: "lastAt",
    countPath: "interactions",
    staleAfterMs: 3 * DAY,
    criterion: "lastAt ≤3 天 且 interactions > 0",
    note: "每轮对话轮末记一次互动（unified-chat 收轮处）。文件由第一次互动创建，所以'文件都没有'就是一次互动都没记成。",
    code: "engine/relationship.mjs",
  },
  {
    id: "gene-drift",
    cadence: "turn",
    name: "基因漂移",
    kind: "json",
    paths: ["记忆/运行时/基因.json"],
    timePath: "updatedAt",
    staleAfterMs: 3 * DAY,
    criterion: "updatedAt ≤3 天",
    note: "advanceTurn 每轮结束写 updatedAt。字段为空 = 文件建了壳但一次都没 advance。",
    code: "engine/genome.mjs",
  },
  {
    id: "growth",
    cadence: "turn",
    name: "成长",
    kind: "json",
    paths: ["记忆/运行时/成长.json"],
    timePath: "updatedAt",
    countPath: "evidence.turns",
    staleAfterMs: 3 * DAY,
    criterion: "updatedAt ≤3 天（计数看 evidence.turns）",
    note: "5 维成长逐轮推进。**数值低是正常的**：陪伴维 = 关系 interactions/200，第一代本来就要 200 轮才满；这里只判'有没有在写'，不判分高分低。",
    code: "engine/genome-growth.mjs",
  },
  {
    id: "outreach",
    cadence: "background",
    name: "主动触达",
    kind: "jsonl",
    paths: ["记忆/运行时/主动推送.jsonl"],
    timeField: "at",
    staleAfterMs: 2 * DAY,
    criterion: "最后一条推送 ≤2 天",
    note: "三档主动触达（提醒/请示/值守）发出去才记账。2 天没有一条：可能真没话可说（深夜静默、无未闭环事项），也可能策略层一直挡着——看板判不了，只能标出来。",
    code: "engine/proactive-journal.mjs",
  },
  {
    id: "watchdog-incident",
    cadence: "background",
    name: "看门狗 incident",
    kind: "json",
    paths: ["记忆/运行时/看门狗事件.json"],
    timePath: "updatedAt",
    countPath: "items",
    staleAfterMs: 7 * DAY,
    criterion: "updatedAt ≤7 天（补记：事件驱动，没有 incident 本身是好事）",
    note: "事件驱动：只有漂移/连续失败才写。所以'很久没更新'在语义上是**好事**，这一项的 stale 要人来判而不是自动判坏——阈值给 7 天只是防它彻底断线。",
    code: "engine/watchdog-incidents.mjs",
  },
  {
    id: "forget-report",
    cadence: "manual",
    name: "遗忘清理",
    kind: "glob",
    paths: ["记忆/运行时"],
    pattern: "遗忘报告-*.md",
    staleAfterMs: 30 * DAY,
    criterion: "最近一份 遗忘报告-*.md ≤30 天",
    note: "手动 CLI（scripts/forget-scan.mjs --apply）才写报告，没接任何自动流程。按设计可能从来没有过——真没有就是 unknown；有但超 30 天，说明这习惯没立起来。",
    code: "engine/memory-forget.mjs",
  },
  {
    id: "self-proof",
    cadence: "manual",
    name: "自证（verify）",
    kind: "jsonl",
    paths: ["记忆/运行时/自证记录.jsonl"],
    timeField: "at",
    staleAfterMs: 14 * DAY,
    criterion: "最后一条自证 ≤14 天",
    note: "改自己代码前跑 verify 才落一条。它只能证明'有人试着自证过'，不能证明'改动入库了'——那看下一项。",
    code: "engine/self-change-admit.mjs",
    lastRowFlag: (row) => (row && row.ok === false
      ? `最后一条自证是失败的（${String(row.reason || "见记录").slice(0, 60)}）`
      : null),
  },
  {
    id: "admission",
    cadence: "manual",
    name: "准入（admit）",
    kind: "jsonl",
    paths: ["记忆/运行时/准入记录.jsonl"],
    timeField: "at",
    staleAfterMs: 14 * DAY,
    criterion: "最后一条准入 ≤14 天",
    note: "和自证分开：自证跑过 ≠ 准入通过。合在一起会把'自证跑了一次失败'读成'准入在工作'。这条 0 行 = 一次改动都没真进库。",
    code: "engine/self-change-admit.mjs",
  },
  {
    id: "verify-check",
    cadence: "turn",
    name: "verify_check 使用",
    kind: "jsonl",
    paths: ["记忆/运行时/动作审计.jsonl"],
    // 只数 before 侧（一次调用两条：before/after），否则次数翻倍。
    match: { field: "tool", equals: "verify_check", notPhase: "after" },
    timeField: "at",
    staleAfterMs: 14 * DAY,
    criterion: "审计里 verify_check 调用 ≤14 天",
    note: "交付前落断言的工具。0 次 = 嘴上说'完成'但没落过一条 EXISTS/FAIL 断言——这是 Hermes 那 0 行验证表的原样翻版。",
    code: "engine/tools/verify-check.mjs",
  },
]);

// ---- 小工具 ----

const isFiniteNum = (v) => Number.isFinite(+v) && v !== null && v !== "";

/** 时间归一成毫秒：毫秒数 / 秒数 / ISO 字符串 / Date 都吃；认不出返回 null（**不猜**）。 */
export function toMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    // 10 位是秒，13 位是毫秒；阈值取 1e11（1973 年的毫秒 / 5138 年的秒，两边都不歧义）
    return n < 1e11 ? Math.round(n * 1000) : n;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** 点分取值：`"evidence.turns"` → obj.evidence.turns；任一层缺失返回 undefined。 */
export function pick(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const k of String(dotted).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 计数值归一：数字原样（负数归 0），数组取长度，对象取 key 数，别的算 0。 */
function countOf(v) {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (typeof v === "string" && v.trim() && Number.isFinite(+v)) return Math.max(0, Math.floor(+v));
  if (v && typeof v === "object") return Object.keys(v).length;
  return 0;
}

function fileStat(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** 一行 JSONL 是否命中 item.match。match 为空 = 全都要（例如主动推送台账每行都算）。 */
export function rowMatches(row, match) {
  if (!match) return true;
  if (!row || typeof row !== "object") return false;
  if (match.notPhase != null && String(row.phase || "") === String(match.notPhase)) return false;
  const v = match.field ? row[match.field] : undefined;
  const s = v == null ? "" : String(v);
  if (match.equals !== undefined) return s === String(match.equals);
  if (match.prefix !== undefined) return s.startsWith(String(match.prefix));
  if (match.contains !== undefined) return s.includes(String(match.contains));
  // 只给了 notPhase：按"字段存在"算命中
  return match.field ? v !== undefined : true;
}

/** 只支持一个 `*` 的极简 glob（够用就行，不为一个文件名去引依赖）。 */
export function globMatchName(name, pattern) {
  const i = pattern.indexOf("*");
  if (i < 0) return name === pattern;
  const head = pattern.slice(0, i);
  const tail = pattern.slice(i + 1);
  return name.length >= head.length + tail.length && name.startsWith(head) && name.endsWith(tail);
}

// ---- 三种探针：只读盘，不判断 ----

function probeJsonl(file, item) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  let total = 0;      // 非空行数（用来区分"文件空着"和"行不少但一条都不匹配"）
  let rows = 0;      // 命中 match 的行数
  let bad = 0;       // 坏行（解析不了）——不影响判定，只进 detail
  let timestamps = 0; // 命中行里带得出时间的条数
  let lastAt = null;
  let lastRow = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    total += 1;
    let row;
    try { row = JSON.parse(line); } catch { bad += 1; continue; }
    if (!rowMatches(row, item.match)) continue;
    rows += 1;
    lastRow = row; // 文件是追加写的，最后命中行就是最新一条（别按 ts 排：坏时钟会把顺序搞乱）
    if (item.timeField) {
      const t = toMs(row[item.timeField]);
      if (t != null) {
        timestamps += 1;
        if (lastAt == null || t > lastAt) lastAt = t;
      }
    }
  }
  return { total, rows, bad, timestamps, lastAt, lastRow, mtimeMs: fileStat(file)?.mtimeMs ?? null };
}

function probeJson(file, item) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const doc = raw && typeof raw === "object" ? raw : {};
  const count = item.countPath ? countOf(pick(doc, item.countPath)) : 1;
  const lastAt = item.timePath ? toMs(pick(doc, item.timePath)) : null;
  const hasTimeField = item.timePath ? pick(doc, item.timePath) != null : false;
  return { count, lastAt, hasTimeField, mtimeMs: fileStat(file)?.mtimeMs ?? null };
}

function probeGlob(dir, pattern) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { count: 0, lastAt: null, matchedNames: [], dirMissing: true }; }
  const matchedNames = names.filter((n) => globMatchName(n, pattern));
  let lastAt = null;
  for (const n of matchedNames) {
    const st = fileStat(path.join(dir, n));
    if (st && (lastAt == null || st.mtimeMs > lastAt)) lastAt = st.mtimeMs;
  }
  return { count: matchedNames.length, lastAt, matchedNames, dirMissing: false };
}

// ---- 单机制审计 ----

/**
 * 审一项。**不抛异常**：任何失败都收敛成 unknown（带原因），
 * 看板的意义是"永远给出一张表"，而不是"证据坏掉就崩给你看"。
 */
export function auditOne(item, { wsRoot = "", now = Date.now(), thresholds = {} } = {}) {
  const root = String(wsRoot || "");
  const threshold = resolveThreshold(item, thresholds);
  const base = {
    id: item.id,
    name: item.name,
    code: item.code || "",
    cadence: item.cadence || "",
    evidence: Array.isArray(item.paths) ? item.paths.join(" / ") : "",
    criterion: item.criterion || "",
    note: item.note || "",
    thresholdMs: threshold,
    thresholdDays: round2(threshold / DAY),
    defaultDays: round2((Number(item.staleAfterMs) || 0) / DAY),
    state: "unknown",
    lastAt: null,
    lastAtIso: null,
    ageMs: null,
    count: 0,
    detail: "",
    // flags：证据"在绿着但有事"的提词（例如自证跑过但最后一条失败）。
    // 单独一栏而不是塞进 state：四种状态是"有没有产出"的判定，不该被内容好坏污染；
    // 但如果内容坏了却一个字都不说，那又是另一种 exit 0 全绿。所以提词要在摘要里露头。
    flags: [],
  };

  // ① glob 型：目录下按文件名模式找
  if (item.kind === "glob") {
    const dir = path.join(root, String((item.paths && item.paths[0]) || "."));
    const g = probeGlob(dir, item.pattern || "*");
    if (g.dirMissing) {
      return { ...base, state: "unknown", detail: `证据目录不存在：${relOf(dir, root) || "."}` };
    }
    if (!g.count) {
      return { ...base, state: "never", detail: `${relOf(dir, root)} 下没有任何 ${item.pattern}（目录在，一份都没写出来）` };
    }
    return finish(base, { count: g.count, lastAt: g.lastAt, now, threshold, extra: `命中 ${g.count} 份` });
  }

  const paths = (item.paths || []).map((p) => path.join(root, p));
  const existing = paths.filter((p) => fileStat(p));

  // ② 证据源一个都不存在 → unknown（**不是** never：连载体都没有，判不了）
  if (!existing.length) {
    return {
      ...base,
      state: "unknown",
      detail: `证据源缺失：${paths.map((p) => relOf(p, root)).join(" / ")}（文件不存在，无法判断机制有没有产出）`,
    };
  }

  let count = 0;
  let lastAt = null;
  let timeFieldEmpty = false; // json 型：文档在，但声明的时间字段一条都没写
  const notes = [];
  try {
    for (const file of existing) {
      if (item.kind === "jsonl") {
        const r = probeJsonl(file, item);
        count += r.rows;
        if (r.lastAt != null && (lastAt == null || r.lastAt > lastAt)) lastAt = r.lastAt;
        // 0 命中时把"全文多少行"报出来：区分"文件是空的"和"行不少但它一条都没写"
        const bits = [`${relOf(file, root)} 命中 ${r.rows} 行${r.rows === 0 ? `（全文 ${r.total} 行）` : ""}`];
        if (r.bad) bits.push(`坏行 ${r.bad}`);
        if (item.timeField && r.rows > 0 && r.timestamps === 0) bits.push(`命中行都没有可读的 ${item.timeField}`);
        if (r.timestamps > 0 && r.lastAt == null) bits.push("时间读不出来");
        if (item.lastRowFlag && r.lastRow) {
          try {
            const flag = item.lastRowFlag(r.lastRow);
            if (flag) { bits.push(flag); base.flags.push(flag); }
          } catch { /* 判词函数坏了不该影响状态 */ }
        }
        notes.push(bits.join("，"));
      } else {
        const r = probeJson(file, item);
        count += r.count;
        if (r.lastAt != null && (lastAt == null || r.lastAt > lastAt)) lastAt = r.lastAt;
        if (item.timePath && !r.hasTimeField) timeFieldEmpty = true;
        const bits = [`${relOf(file, root)} 可读`];
        if (item.countPath) bits.push(`${item.countPath}=${r.count}`);
        if (item.timePath && !r.hasTimeField) bits.push(`${item.timePath} 为空`);
        notes.push(bits.join("，"));
      }
    }
  } catch (e) {
    return { ...base, state: "unknown", count, detail: `证据源读不了：${shortErr(e)}` };
  }

  // ③ 载体在、却一条匹配产出都没有 → never
  if (count === 0) {
    return { ...base, state: "never", count: 0, detail: notes.join("；") };
  }

  // ③b 单文档 json 的时间字段为空 → 机制建了壳但一次都没推进过 → never
  //    （这条和下面那条的区别：这里有产出载体，只是"从没写过时间"，属于从没落账，不是判不了）
  if (lastAt == null && item.kind === "json" && item.timePath && timeFieldEmpty) {
    return { ...base, state: "never", count, detail: notes.join("；") };
  }

  // ④ 有产出但读不出时间 → unknown（绝不当 fresh）
  if (lastAt == null) {
    return { ...base, state: "unknown", count, detail: `${notes.join("；")}；有时间字段却一条时间都读不出来` };
  }

  return finish(base, { count, lastAt, now, threshold, extra: notes.join("；") });
}

/** 有产出且有时间的统一收尾：判 fresh / stale。 */
function finish(base, { count, lastAt, now, threshold, extra }) {
  const age = now - lastAt;
  const iso = new Date(lastAt).toISOString();
  const aged = `最后产出 ${iso}（${humanAge(age)}前）`;
  if (age < -FUTURE_GRACE_MS) {
    // 未来时间：时钟坏了或数据脏，宁可 unknown 也不给绿
    return { ...base, state: "unknown", count, lastAt, lastAtIso: iso, ageMs: age, detail: `${aged}——时间在未来，数据可疑${extra ? `；${extra}` : ""}` };
  }
  const state = age <= threshold ? "fresh" : "stale";
  const tail = state === "stale"
    ? `，超过阈值 ${round2(threshold / DAY)} 天`
    : `，阈值 ${round2(threshold / DAY)} 天内`;
  return {
    ...base, state, count, lastAt, lastAtIso: iso, ageMs: Math.max(0, age),
    detail: `${aged}${tail}${extra ? `；${extra}` : ""}`,
  };
}

/**
 * 阈值覆盖：`{ [id]: 毫秒 }` 或 `{ [id]: { staleAfterMs } }`；也认全局 `default`。
 * 可用天数（数字 ≤ 3650 且没带 ms 语义时按天算会歧义，所以只接受毫秒或 {days}）。
 * 为了 CLI 方便，额外认 `{ [id]: { days } }`。
 */
export function resolveThreshold(item, thresholds = {}) {
  const raw = thresholds && typeof thresholds === "object"
    ? (thresholds[item.id] ?? thresholds.default)
    : undefined;
  if (raw && typeof raw === "object") {
    if (Number.isFinite(+raw.staleAfterMs) && +raw.staleAfterMs >= 0) return +raw.staleAfterMs;
    if (Number.isFinite(+raw.days) && +raw.days >= 0) return +raw.days * DAY;
    return item.staleAfterMs;
  }
  if (Number.isFinite(+raw) && +raw >= 0) return +raw;
  return item.staleAfterMs;
}

/**
 * 体检：逐机制审一遍。
 *
 * @param {object} o
 * @param {string} o.wsRoot     工作区根（**必给**；空串会一路 unknown，不会瞎猜默认目录）
 * @param {number} [o.now]      当前时间（测试注入用）
 * @param {object} [o.thresholds] 阈值覆盖，见 resolveThreshold
 * @param {Array}  [o.mechanisms] 换成别的清单（测试/子集用）
 * @returns {{wsRoot:string, now:number, items:Array, counts:object, ok:boolean}}
 */
export function auditVitality({ wsRoot = "", now = Date.now(), thresholds = {}, mechanisms = MECHANISMS } = {}) {
  const at = Number.isFinite(+now) ? +now : Date.now();
  const list = Array.isArray(mechanisms) ? mechanisms : MECHANISMS;
  const items = list.map((item) => {
    try {
      return auditOne(item, { wsRoot, now: at, thresholds });
    } catch (e) {
      // 兜底：清单写错了也不该让看板崩
      return {
        id: String(item?.id || "?"), name: String(item?.name || "?"), code: String(item?.code || ""),
        evidence: "", criterion: String(item?.criterion || ""), note: String(item?.note || ""),
        thresholdMs: Number(item?.staleAfterMs) || 0, thresholdDays: 0, defaultDays: 0,
        state: "unknown", lastAt: null, lastAtIso: null, ageMs: null, count: 0,
        detail: `审计时抛错：${shortErr(e)}`,
      };
    }
  });
  const counts = countStates(items);
  return { wsRoot, now: at, items, counts, ok: counts.stale === 0 && counts.never === 0 && counts.unknown === 0 };
}

export function countStates(items = []) {
  const counts = { fresh: 0, stale: 0, never: 0, unknown: 0, total: 0 };
  for (const it of items) {
    counts.total += 1;
    if (it && counts[it.state] !== undefined) counts[it.state] += 1;
  }
  return counts;
}

const STATE_LABELS = Object.freeze({ fresh: "新鲜", stale: "停更", never: "从未产出", unknown: "无证据" });

export function stateLabel(state) {
  return STATE_LABELS[state] || String(state || "未知");
}

/**
 * 判红之后第一件该问的事：这机制**有没有机会**产出。
 * 对话轮驱动 vs 后台定时 vs 手动，处置完全不一样——把这句话贴在处置建议后面，
 * 免得人一看见红灯就去翻代码，其实只是今天一轮都没聊。
 */
export function cadenceHint(cadence) {
  if (cadence === "turn") return "。对话轮驱动：先确认最近有没有真正跑过对话轮（看 记忆/运行时/动作审计.jsonl 的最后时间），一轮没聊时它不产出是正常的";
  if (cadence === "background") return "。后台定时驱动：进程活着却不产出，是策略层/守卫把它全挡了，不是没到时候";
  if (cadence === "manual") return "。手动驱动：要人显式跑一次才有产出，从来没产出 = 从没跑过";
  return "";
}

/**
 * 一行中文摘要 + 需要处理的项。
 *
 * 措辞规矩（故意的）：红项必须**点名具体机制**，不许只说"有 N 项异常"——
 * "有 3 项异常"这种句子读三遍也不知道该去修什么，跟"exit 0 全绿"是一体两面。
 */
export function summarize(audit = {}) {
  const items = Array.isArray(audit.items) ? audit.items : [];
  const counts = audit.counts || countStates(items);
  const red = items.filter((i) => i.state === "stale" || i.state === "never");
  const grey = items.filter((i) => i.state === "unknown");
  // 状态绿但内容有事（例如"自证跑过一次、那次是失败的"）：不能让它在表格里绿着没人提
  const flagged = items.filter((i) => Array.isArray(i.flags) && i.flags.length);

  const head = `${counts.total} 项机制：${counts.fresh ?? 0} 新鲜／${counts.stale ?? 0} 停更／`
    + `${counts.never ?? 0} 从未产出／${counts.unknown ?? 0} 无证据`;

  const nameOf = (i) => `${i.name}(${stateLabel(i.state)})`;
  let line;
  if (red.length) {
    const names = red.slice(0, 6).map(nameOf).join("、");
    line = `${head}；要处理：${names}${red.length > 6 ? ` 等 ${red.length} 项` : ""}`;
  } else {
    line = `${head}；没有停更或从未产出的机制`;
  }
  if (grey.length) {
    const names = grey.slice(0, 6).map((i) => i.name).join("、");
    line += `；另有 ${grey.length} 项无证据（${names}${grey.length > 6 ? " 等" : ""}），需确认机制是否真的接上了盘`;
  } else if (!red.length) {
    line += "，且每一项都有证据";
  }
  if (flagged.length) {
    line += `；提词：${flagged.map((i) => `${i.name}—${i.flags[0]}`).join("；")}`;
  }

  const issues = red.map((i) => ({
    id: i.id,
    name: i.name,
    state: i.state,
    label: stateLabel(i.state),
    lastAt: i.lastAt,
    lastAtIso: i.lastAtIso,
    count: i.count,
    why: i.detail,
    code: i.code,
    cadence: i.cadence,
    // 给接手的人一句"下一步看哪"：机制归因留人，但路标可以给
    look: i.state === "never"
      ? `${i.code || "对应模块"} 里该写 ${i.evidence} 的分支有没有被走到${cadenceHint(i.cadence)}`
      : `${i.code || "对应模块"} 是不是停止调用了${cadenceHint(i.cadence)}；若确实该停，就把阈值调宽并写清理由`,
  }));

  const unknown = grey.map((i) => ({
    id: i.id, name: i.name, state: i.state, label: stateLabel(i.state),
    why: i.detail, code: i.code, cadence: i.cadence,
    look: `确认 ${i.evidence} 这个路径对不对；路径对就是机制一次都没被调用${cadenceHint(i.cadence)}`,
  }));

  return {
    line,
    counts,
    issues,     // stale + never：真红项
    unknown,    // 不可判项，单独列，不跟红项混
    flags: flagged.map((i) => ({ id: i.id, name: i.name, state: i.state, label: stateLabel(i.state), note: i.flags[0], code: i.code })),
    needsAttention: red.length,
    ok: red.length === 0,
  };
}

// ---- 展示用的小工具（CLI 和测试都用，不引依赖） ----

/** 2026-11-09 00:16:40（本地时区，看板给人看就别用 UTC） */
export function formatTime(ms) {
  if (!Number.isFinite(+ms)) return "—";
  const d = new Date(+ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "12 分钟前" / "3.4 天前" / "刚刚" */
export function humanAge(ms) {
  if (!Number.isFinite(+ms)) return "—";
  const s = Math.max(0, Math.round(+ms / 1000));
  if (s < 90) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} 分钟`;
  const h = m / 60;
  if (h < 36) return `${round2(h)} 小时`;
  const d = h / 24;
  if (d < 240) return `${round2(d)} 天`;
  return `${round2(d / 365)} 年`;
}

const round2 = (n) => (Number.isFinite(+n) ? Math.round(+n * 100) / 100 : 0);

function relOf(abs, root) {
  const r = String(root || "");
  if (!r) return abs;
  const rel = path.relative(r, abs);
  return rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : abs;
}

function shortErr(e) {
  return String((e && (e.code || e.message)) || e).slice(0, 120);
}
