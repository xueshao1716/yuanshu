// ===== crash-report-spec.mjs —— 崩溃报告的"验收标准"（2026-10-26）=====
//
// 起因：分发的 Linux 用户把 bug 报回来了，但报告是 `detail: "…server.mjs:2314:28 <- at listOnTimeout"`
// 这种 160 字截断行，`env` 与 `diagnostics` 全是 null。**报回来了，我们却不认识。**
//
// 所以这里把"一份能用的崩溃报告长什么样"写成代码：
//   · REQUIRED_FIELDS —— 缺一个就算"不可定位"，本地先标出来，别等我们人工看；
//   · buildCrashReport() —— 生成端（客户端）统一按这个结构填；
//   · validateCrashReport() —— 接收端（收件箱/人工）一眼判断能不能查；
//   · diagnosability() —— 三档：addressable / partial / unusable。
//
// 原则：**宁可本地拦下来说"这份报告没用"，也不要发到对面去当垃圾。**

/** 能不能定位问题所必须的字段（按重要性排序）。 */
export const REQUIRED_FIELDS = [
  "version",       // 哪个版本（能对回代码）
  "commit",        // 哪个构建（行号漂移后唯一可靠的锚）
  "platform",      // win32 / linux / darwin
  "arch",
  "node",          // node 版本（原生依赖/兼容问题常常就在这）
  "uptimeSec",     // 崩溃前跑了多久（3s 和 3h 是两类问题）
  "kind",          // crash / restart / model-fail …
  "signature",     // 归并同根因用（抹掉地址/pid/时间）
  "stack",         // 完整栈（至少 3 帧）
  "exitCode",      // 退出码（null = 被强杀/未捕获异常）
];

/** 旧版本仍可接收，但会标注"已不在支持窗口内"。 */
export const MIN_SUPPORTED_VERSION = "2.128.0";

function cmpVersion(a, b) {
  const pa = String(a || "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 生成端：把一次崩溃整理成标准报告。缺什么就空着，别编。 */
export function buildCrashReport({
  version = "", commit = "", platform = process.platform, arch = process.arch,
  node = process.version, uptimeSec = 0, kind = "crash", signature = "",
  stack = "", exitCode = null, extra = {},
} = {}) {
  return {
    version: String(version || ""),
    commit: String(commit || "").slice(0, 12),
    platform: String(platform || ""),
    arch: String(arch || ""),
    node: String(node || ""),
    uptimeSec: Math.max(0, Math.round(Number(uptimeSec) || 0)),
    kind: String(kind || ""),
    signature: String(signature || ""),
    stack: String(stack || "").slice(0, 4000),
    exitCode: exitCode === null || exitCode === undefined ? null : Number(exitCode),
    at: Date.now(),
    ...extra,
  };
}

/** 缺了哪些必填（空字符串/null/undefined 都算缺；exitCode 允许 null）。 */
export function missingFields(report = {}) {
  return REQUIRED_FIELDS.filter((k) => {
    if (k === "exitCode") return false;      // null 合法（被强杀）
    const v = report[k];
    return v === undefined || v === null || String(v).trim() === "";
  });
}

/** 栈帧数（判断 stack 是不是只有一行）。 */
export function frameCount(stack) {
  return String(stack || "").split("\n").filter((l) => /^\s+at\s/.test(l)).length;
}

/**
 * 三档可定位性：
 *   addressable = 能直接开工（有 commit/version + 平台 + 至少 3 帧栈）
 *   partial     = 能缩小到某个定时器/模块，但还得问用户要日志
 *   unusable    = 只够说"某处炸了"
 */
export function diagnosability(report = {}) {
  const missing = missingFields(report);
  const frames = frameCount(report.stack);
  if (missing.length === 0 && frames >= 3) return { level: "addressable", missing, frames, reason: "字段齐全且栈够长" };
  const hasAnchor = !!(report.commit || report.version) && frames >= 1;
  if (hasAnchor && missing.length <= 3) return { level: "partial", missing, frames, reason: `缺 ${missing.join("/")}；只有 ${frames} 帧` };
  return { level: "unusable", missing, frames, reason: missing.length ? `缺 ${missing.slice(0, 4).join("/")}` : `栈只有 ${frames} 帧` };
}

/** 版本是否还在支持窗口内（太老的构建行号对不上，先请对方升级）。 */
export function versionSupported(version) {
  return cmpVersion(version, MIN_SUPPORTED_VERSION) >= 0;
}

/** 接收端一句话结论（收件箱/日志直接用）。 */
export function triageLine(report = {}) {
  const d = diagnosability(report);
  const v = report.version ? `v${report.version}` : "版本未知";
  const build = report.commit ? `@${report.commit}` : "@构建未知";
  const support = versionSupported(report.version) ? "" : "（低于支持窗口，先请对方升级）";
  return `[${d.level}] ${report.kind || "crash"} · ${v}${build} · ${report.platform || "?"}/${report.arch || "?"} · node ${report.node || "?"} · 栈 ${d.frames} 帧 — ${d.reason}${support}`;
}
