// ===== crash-triage.mjs —— 收到报告后：能不能对上号？对不上要说清为什么（2026-10-26）=====
//
// 用户要求：「加个自动化处理，如果对方报过来的，对应不上，就告诉她为啥没有发现他说的 bug」
//
// 这里的"对应不上"有四种，必须**分开说**，因为它们要对方做的事完全不同：
//   1. no_build    —— 报告里没有构建号（commit），栈又被截断 → 我没法把这行对到某版代码
//   2. stale       —— 版本低于支持窗口 → 先升级，旧栈对新代码是假定位
//   3. foreign     —— 栈里是别人机器的路径/构建（不是本仓库发出去的）→ 需要对方补齐环境
//   4. no_repro    —— 字段够但信息不足（平台不同、无日志）→ 能缩小范围但复现不了
//
// 输出两部分：`matchable`（能不能开工）+ `reply`（一段能直接发给对方的话）。
// 回复里必须**承认看不到**，而不是含糊其辞——这比装作在查更诚实，也更有用。
import { diagnosability, versionSupported, MIN_SUPPORTED_VERSION, frameCount } from "./crash-report-spec.mjs";

const FRAME_RE = /^\s+at\s+(.+?)\s*\((.+?)\)\s*$/;

/** 从栈里取最外层的项目帧（跳过 node: 内部帧）。 */
export function projectFrames(stack) {
  const out = [];
  for (const line of String(stack || "").split("\n")) {
    const m = line.match(FRAME_RE);
    if (!m) continue;
    const loc = m[2];
    if (/node:internal|node:[\w/]+:/.test(loc)) continue;
    out.push({ fn: m[1], loc });
  }
  return out;
}

/** 这一帧是不是本仓库发出去的（路径里带仓库名或工作区名；大小写不敏感——Windows 路径常被写成 Yuanshu）。 */
export function looksLikeOurBuild(frame, { repoHints = ["/yuanshu/", "\\yuanshu\\", "pi-workspace"] } = {}) {
  const loc = String(frame?.loc || "").toLowerCase();
  return repoHints.some((h) => loc.includes(h.toLowerCase()));
}

/**
 * @param {{item:object, self?:{commit?:string, version?:string, platform?:string}}} input
 * @returns {{matchable:boolean, kind:string, reasons:string[], reply:string, triage:string}}
 */
export function triageReport({ item = {}, self = {} } = {}) {
  const title = String(item.title || "");
  const detail = String(item.detail || "");
  const env = (item.env && typeof item.env === "object") ? item.env : {};
  const stack = String(item.stack || env.stack || detail);
  const version = String(env.version || item.version || "");
  const commit = String(env.commit || item.commit || "");
  const platform = String(env.platform || item.platform || "");
  const frames = projectFrames(stack);
  const diag = diagnosability({ ...env, stack, version, commit, platform, kind: item.kind || "crash", signature: env.signature });

  const reasons = [];
  let kind = "ok";

  const hasBuild = /^[0-9a-f]{7,12}$/i.test(commit);
  const stale = version ? !versionSupported(version) : false;
  const ourFrame = frames.some((f) => looksLikeOurBuild(f));
  const foreignPath = frames.length > 0 && !ourFrame;

  if (!hasBuild && frameCount(stack) < 3) { kind = "no_build"; reasons.push("报告里没有构建号（commit），栈也只有一行"); }
  else if (stale) { kind = "stale"; reasons.push(`版本 v${version} 低于支持窗口 ${MIN_SUPPORTED_VERSION}`); }
  else if (foreignPath) { kind = "foreign"; reasons.push(`栈里的路径不属于本仓库构建（${frames[0]?.loc?.slice(0, 60) || "?"}）`); }

  if (kind === "ok" && diag.level !== "addressable") { kind = "no_repro"; reasons.push(diag.reason); }
  if (platform && self.platform && platform !== self.platform) reasons.push(`报告来自 ${platform}，本机是 ${self.platform}`);

  const matchable = kind === "ok" && diag.level === "addressable";
  // 展示用 kind 永远是报告本身的类型（crash/restart），不是我们的失败分类
  // （早先写成 `head({kind})` 会打出 "crash: no_build 版本未知" 这种怪话）
  const displayKind = String(item.kind || "crash");
  const reply = matchable
    ? replyMatched({ version, commit, kind: displayKind, frames })
    : replyUnmatched({ kind, version, commit, frames, reasons, displayKind });
  return { matchable, kind, reasons, reply, triage: diag.level };
}

function head({ version, commit, kind }) {
  const v = version ? `v${version}` : "版本未知";
  const c = commit ? `@${commit}` : "@构建未知";
  return `${kind || "crash"} ${v}${c}`;
}

function replyMatched({ version, commit, kind, frames }) {
  return [
    `收到你报的 ${head({ version, commit, kind })}，构建号对上了，栈也够长（${frames.length} 帧），能定位。`,
    `我会按这条 commit 回到那个构建查这一处；修好后在下一版说明里告诉你改了什么。谢谢你报回来。`,
  ].join("\n");
}

function replyUnmatched({ kind, version, commit, frames, reasons, displayKind = "crash" }) {
  const why = reasons.length ? reasons.join("；") : "报告信息不足以对上号";
  const ask = {
    no_build: [
      "麻烦做两件事：",
      "1) 升级到最新版再复现一次（新版上报会自动带构建号和完整栈）；",
      "2) 如果还崩，把安装目录下 `crash.log` 的最后 40 行贴回来。",
    ],
    stale: [
      `你现在跑的是 ${version || "旧版本"}，我这边只支持 ${MIN_SUPPORTED_VERSION} 以上——`,
      "旧版的代码结构和行号对不上，拿它的栈去查当前代码只会查到错的地方（假定位）。",
      "麻烦升级到最新版再试；升级后还崩溃的话，新报告会自带构建号，我就能直接找到那一行。",
    ],
    foreign: [
      "你这份报告里的路径不属于我发出去的正式构建（看着像从源码直接跑的目录）。",
      "这种情况栈里的行号跟发布版对不上，我照它查会查错。",
      "麻烦换成安装包/正式发布的版本再复现一次，或者把你那份的 git commit 一起告诉我。",
    ],
    no_repro: [
      "报告里字段基本齐了，但我还差一点才能复现：",
      "麻烦补三样——安装目录下 `crash.log` 尾部 40 行、当时正在做什么操作、以及是否只在特定文件/特定系统上出现。",
    ],
  }[kind] || ["麻烦补一下环境信息（版本、系统、crash.log 尾部），我再查。"];

  return [
    `我把你报的 ${head({ version, commit, kind: displayKind })} 拿去对了一遍，**没对上号**，先跟你说实话，而不是含糊过去。`,
    `原因：${why}。`,
    "",
    ...ask,
    "",
    "抱歉让你多跑一趟。这类「报回来了但定位不了」是我们上报机制的问题，已经在改（新版本会带构建号和完整栈）。",
  ].join("\n");
}

/**
 * 第二封回信：**真的修好了**再回一次（用户要求：「最后修好了再回一次最好」）。
 * 必须有具体的东西：在哪个版本修的、改了什么、请对方升级后怎么验证。
 * 如果拿不出这三样，就不要发——"修好了"是最容易说空话的一句话。
 */
export function resolutionReply({ item = {}, fix = {} } = {}) {
  const version = String(fix.version || "");
  const change = String(fix.change || "").trim();
  const verify = String(fix.verify || "").trim();
  const commit = String(fix.commit || "").slice(0, 12);
  if (!version || !change) {
    return { ok: false, error: "拿不出「哪个版本 + 改了什么」就别发第二封回信" };
  }
  const head = version ? `v${version}${commit ? `（${commit}）` : ""}` : "下一版";
  const lines = [
    `你之前报的那个问题（${String(item.title || "崩溃").replace("[自动上报] ", "").slice(0, 60)}），已经修好了。`,
    `修复版本：${head}`,
    `改了什么：${change}`,
  ];
  if (verify) lines.push(`请你这样验证：${verify}`);
  lines.push("", "还复现的话直接回这条就行，我会接着查。谢谢你报回来——没有这条报告，这个坑我们不会这么快发现。");
  return { ok: true, text: lines.join("\n") };
}
