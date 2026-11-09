// engine/anti-patterns.mjs —— 反模式台账（2026-11-09，移植林心语 anti_patterns.json 的模型可读层）
//
// 为什么要有这一层：元枢的防护全是**代码级拦截**——security deny、tool-loop 检测、output-guard、
// secrets-guard、verify_check。被拦下的是"动作"，不是"她的认知"：她本人不知道自己犯过哪些坑，
// 也不知道被拦下的那一刻该换成什么做法。代码拦不住"我接下来会做 X"这种空头承诺，也拦不住
// "报数之前不复核"——这类只能靠模型自己记得。
//
// 设计取舍（别改成"全量塞进 prompt"）：
//   ① 台账 = 记忆/反模式.json，每条都有**可执行的一句话 remedy**。没有 remedy 的条目直接报错，
//      因为"要小心"这种话在 prompt 里等于噪音。
//   ② 注入只取最相关 2 条，每条一行：⚠ 别：<名字> → 该：<remedy>。无匹配就零注入（零成本）。
//      前缀固定 `反模式：`，yuanshu-emotion 靠它去重（同一 system 块不重复插）。
//   ③ 自动检测只做**三类**能机械判定的：同参循环、失败命令重试、空头承诺。其余交给模型自觉，
//      写进 trigger.detect 让她知道"什么情形算踩了"，不假装能自动判。
//   ④ 连续命中 N 次升一档 severity（low→medium→high，high 封顶）——升级落在台账文件上，
//      下次注入的措辞会跟着变重；没有台账文件时只记 jsonl，不凭空造文件。
//
// 不写 记忆/harness/、不碰人格定义.json：这一层是"经验清单"，不是人格。
// 落盘：记忆/反模式.json（首次由 ensureLedger 建档，默认 dry-run 只打印不写）
//       记忆/运行时/反模式命中.jsonl（每次命中追加一行）
// 直接用 `node engine/anti-patterns.mjs` 跑一遍 = dry-run 打印台账，不落盘。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "./atomic-io.mjs";

export const LEDGER_REL = path.join("记忆", "反模式.json");
export const HIT_REL = path.join("记忆", "运行时", "反模式命中.jsonl");
export const PROMPT_PREFIX = "反模式：";
export const SEVERITIES = Object.freeze(["low", "medium", "high"]);
export const TRIGGER_KINDS = Object.freeze(["auto", "model", "manual"]);

// 阈值都写成常量：测试直接引用，别在别处再抄一份魔法数字。
export const DEFAULT_LIMIT = 3; // matchAntiPatterns 默认取几条
export const INJECT_LIMIT = 2; // prompt 注入上限（多一条就多一份噪声）
export const SAME_ARGS_THRESHOLD = 3; // 同参调用 ≥3 次算循环确认
export const RETRY_THRESHOLD = 3; // 同一失败命令 ≥3 次算死循环重试
export const RETRY_WINDOW_MS = 10 * 60 * 1000; // 10 分钟窗口
export const ESCALATE_AFTER = 3; // 连续命中 N 次升一档
const KEYWORD_WEIGHT = 2;
const TOOL_WEIGHT = 3;
const ERROR_WEIGHT = 3;
const TAG_WEIGHT = 3;
const MAX_CONTEXT_CHARS = 4000;
const TAIL_BYTES = 256 * 1024;

// 命令类工具：同一个"命令串"失败才算重试，read/grep 这种参数里没有命令的不进第二类检测。
const COMMAND_TOOLS = new Set([
  "bash", "shell", "sh", "pwsh", "powershell", "cmd", "terminal",
  "run_command", "run_shell_command", "exec", "execute_command", "command",
]);

// ── 台账正文（首次建档的内容；也是没有台账文件时的内置兜底）──
// 每条都带 keywords/tools/errors：匹配靠这三个字段，不靠对 title 猜。
export const DEFAULT_PATTERNS = Object.freeze([
  {
    id: "AP-001",
    title: "循环确认（同参空转）",
    severity: "high",
    trigger: {
      kind: "auto",
      detect: `同一工具 + 同参数连续调用 ≥${SAME_ARGS_THRESHOLD} 次（中间没有别的工具调用）`,
    },
    symptom: "同一个问题反复确认，几轮下来事实一点没变；用户开始问「你怎么又问一遍」。",
    remedy: "同一问题第二次确认前先跑 read/grep/verify_check 拿新证据，拿到就直接动手，拿不到就明说「信息没变」并给出下一步。",
    examples: [],
    discoveredAt: "2026-06-05",
    source: "林心语 anti_patterns.json AP-001（循环确认）",
    keywords: ["再确认", "再核对", "确认一下", "确认无误", "反复确认", "再问一遍", "确定吗", "再检查一遍"],
    tools: [],
    errors: [],
  },
  {
    id: "AP-002",
    title: "编造事实（凭印象给具体值）",
    severity: "high",
    trigger: {
      kind: "model",
      detect: "回复里给出具体事实（版本号/路径/API/数字），而当轮没有任何工具证据",
    },
    symptom: "说得很确定，一查就错；用户拿这句话当依据去做事。",
    remedy: "给版本号/路径/API/数字之前先用 read/grep/web_fetch/verify_check 找到一处出处，找不到就说「我没查到」。",
    examples: [],
    discoveredAt: "2026-06-07",
    source: "林心语 anti_patterns.json AP-002（编造事实，源 severity=critical → high）",
    keywords: ["大概", "应该", "我记得", "印象中", "估计", "似乎", "可能吧", "应该没错"],
    tools: [],
    errors: [],
  },
  {
    id: "AP-003",
    title: "死循环重试（原样重跑）",
    severity: "high",
    trigger: {
      kind: "auto",
      detect: `同一条失败命令（命令串归一化后相同）在 ${RETRY_WINDOW_MS / 60000} 分钟内失败 ≥${RETRY_THRESHOLD} 次`,
    },
    symptom: "命令一直红，一轮轮重跑同一条；看起来像卡住（真的卡住过）。",
    remedy: "同一命令失败第 2 次就停下来读完整报错，换工具或换参数再试，第 3 次还红就上报卡在哪。",
    examples: [],
    discoveredAt: "2026-06-07",
    source: "林心语 anti_patterns.json AP-003（死循环重试）",
    keywords: ["重试", "再试一次", "再跑一遍", "还是失败", "又失败", "同样报错", "一直失败"],
    tools: [],
    errors: ["exit_nonzero", "timeout", "not_found", "permission", "syntax", "network", "econnrefused"],
  },
  {
    id: "AP-005",
    title: "全盘重来（删掉已完成的）",
    severity: "medium",
    trigger: {
      kind: "model",
      detect: "失败只涉及其中几步，却把整条流水线/整份产物推倒重做",
    },
    symptom: "一个局部失败把已经做好的部分全部推倒，时间翻倍。",
    remedy: "先定位到失败的那一步（哪条命令/哪个文件/哪一行），只重跑那一步并从断点继续，别删已完成产物。",
    examples: [],
    discoveredAt: "2026-06-07",
    source: "林心语 anti_patterns.json AP-005（全盘重来）",
    keywords: ["重新生成", "全部重来", "从头再", "推倒重来", "重做一遍", "重建整个"],
    tools: [],
    errors: [],
  },
  {
    id: "AP-006",
    title: "空头承诺（说要做什么但没做）",
    severity: "high",
    trigger: {
      kind: "auto",
      detect: "本轮 assistant 文本承诺「接下来会做 X」，但同一个 turn 内没有任何工具调用",
    },
    symptom: "说「我马上去验证/去改」，然后直接收尾，什么都没发生。",
    remedy: "这句话写进回复之前，同一个 turn 内先把对应工具调掉；调不了就改口说「我没做，原因是 X」。",
    examples: [],
    discoveredAt: "2026-06-08",
    source: "林心语 anti_patterns.json AP-006（空头承诺）",
    keywords: ["接下来", "马上", "稍后", "这就", "立刻去", "随后"],
    tools: [],
    errors: [],
  },
  {
    id: "AP-007",
    title: "过度道歉（道歉替代修复）",
    severity: "medium",
    trigger: {
      kind: "model",
      detect: "同一问题连续 2 次以上道歉/自我批评，但没有新的修复动作",
    },
    symptom: "一句接一句对不起，问题原地不动，用户还得反过来安慰。",
    remedy: "同一问题只道歉一次，第二条起只给修复动作和已经跑出的结果。",
    examples: [],
    discoveredAt: "2026-06-08",
    source: "林心语 anti_patterns.json AP-007（过度道歉）",
    keywords: ["抱歉", "对不起", "是我的错", "不好意思", "我道歉", "怪我"],
    tools: [],
    errors: [],
  },
  {
    id: "AP-008",
    title: "观察任务包装成 fix_problem 派轮",
    severity: "high",
    trigger: {
      kind: "model",
      detect: "fix_problem 的 problem 描述里出现「看一眼/核实/确认/截图里是什么」这类观察动词",
    },
    symptom: "派了一个完整执行轮进命令全崩的目录：探测脚本 import 就崩、命令连续失败、交付门一直 RED，看起来像卡死。",
    remedy: "先在当前轮自己 read/看图回答；只有已经定位到、能当场改的代码或配置才调 fix_problem。",
    examples: [
      "2026-11-08：伙伴让「核实截图里微信搜索是否搜到某人」，被包成 fix_problem 派轮，进目录后命令全崩，白耗一轮。",
    ],
    discoveredAt: "2026-11-08",
    source: "元枢 2026-11-08 真事故（engine/session/tool-inits.mjs fix_problem 注释）",
    keywords: ["看一眼", "核实", "看一下", "截图里", "图片里", "搜到没", "有没有", "是不是", "确认截图", "看看这张"],
    tools: ["fix_problem"],
    errors: [],
  },
  {
    id: "AP-009",
    title: "报数不复核（数字靠印象）",
    severity: "high",
    trigger: {
      kind: "model",
      detect: "正文出现数量/存在性/路径/测试结果（「一共 N 项/全部通过/文件在」），但本轮没有 verify_check 或对应的 count 命令",
    },
    symptom: "「一共 92 项」实际 0 项；数字是印象，不是查出来的。",
    remedy: "说任何数量/存在性/路径/测试结果之前先 verify_check 落断言，有一条 FAIL 就报实际数字。",
    examples: ["2026-11：报告「一共 92 项」，verify_check 一跑实际 0 项。"],
    discoveredAt: "2026-11-09",
    source: "元枢 2026-11 真事故（伙伴口述）+ engine/yuanshu-protocol.mjs 第 16 条",
    keywords: ["一共", "总共", "多少项", "多少个", "多少条", "全部通过", "测试结果", "都过了", "数量", "几个"],
    tools: ["verify_check"],
    errors: [],
  },
  {
    id: "AP-010",
    title: "生成物留厂商 URL",
    severity: "medium",
    trigger: {
      kind: "model",
      detect: "交付的图片/视频角落或元数据里带厂商域名/水印 URL（byteimg、volces、doubao、stepfun 等）",
    },
    symptom: "图/视频本身能用，但角落挂着一行别人的域名，等于交付物上印了别家的章。",
    remedy: "交付图片/视频前先自己看一遍角落与元数据，出现厂商域名就裁切或重生成，再看图确认无残留才交。",
    examples: ["图片右下角残留厂商域名 URL", "视频尾帧带生成平台水印"],
    discoveredAt: "2026-11-09",
    source: "元枢 2026-11 真事故（伙伴口述：图/视频都犯过）",
    keywords: ["生成图", "出图", "图片", "视频", "封面", "海报", "水印", "交付图", "宣传片", "素材"],
    tools: ["generate_image", "gen_image", "image_generation", "text2image", "generate_video", "video_generation"],
    errors: [],
  },
  {
    id: "AP-011",
    title: "自证链长期 RED 无人察觉",
    severity: "high",
    trigger: {
      kind: "model",
      detect: "自证/交付门连续 2 次 RED 没有上报；或跑之前 git status 里有与本任务无关的改动",
    },
    symptom: "门一直红，跑的人以为「跑了就行」，没人看退出码；真正的问题被当成背景噪音。",
    remedy: "跑自证前先 `git status --porcelain` 把夹带改动 `git stash push` 掉，跑完读退出码与结论，连续 2 次 RED 立即上报。",
    examples: ["工作区夹带改动让自证链长期失败，没人发现，验证层形同虚设。"],
    discoveredAt: "2026-11-09",
    source: "元枢 2026-11 真事故（伙伴口述：自证链长期失败无人察觉）",
    keywords: ["自证", "交付门", "门禁", "全量测试", "跑测试", "验收", "verify", "测试失败", "是红的", "红的"],
    tools: ["verify_delivery", "run_tests", "npm test"],
    errors: ["test_failure", "assertion", "exit_nonzero"],
  },
  {
    id: "AP-012",
    title: "门禁盖章了但代码没同步（部署假完成）",
    severity: "high",
    trigger: {
      kind: "model",
      detect: "说「部署完成/已上线」，但 .yuanshu-build.json 的 commit ≠ git rev-parse HEAD，或部署目录文件 hash 与仓库不一致",
    },
    symptom: "门禁跑了、章也盖了，安装目录里还是老代码；点「立即更新」只是原地重启。",
    remedy: "盖章后比对 `.yuanshu-build.json` 的 commit 与 `git rev-parse HEAD`，再 hash 对比部署目录与仓库同名文件，全等才说部署完成。",
    examples: ["stamp 停在装机那天（49f2c41），远端早已 20b6715，点「立即更新」其实是在原地重启。"],
    discoveredAt: "2026-11-09",
    source: "元枢 2026-10-25 真机 + scripts/stamp-build.mjs 头注释",
    keywords: ["部署", "发布", "上线", "盖章", "安装版", "重启生效", "装到", "release", "新版本"],
    tools: ["stamp-build", "deploy"],
    errors: [],
  },
]);

// ── 小工具 ──
const iso = (v) => {
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return new Date(Number.isFinite(n) ? n : Date.now()).toISOString();
};
const str = (v, max = 600) => String(v ?? "").trim().replace(/\s*\n\s*/g, " ").slice(0, max);
const clone = (v) => structuredClone(v);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function strList(v) {
  const arr = Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
  const out = [];
  for (const x of arr) {
    const s = str(x, 120);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** severity 归一：源里的 critical 是元枢没有的档位，一律折成 high。 */
export function normalizeSeverity(v) {
  const s = String(v ?? "").toLowerCase();
  if (s === "critical" || s === "high" || s === "严重" || s === "高") return "high";
  if (s === "medium" || s === "warn" || s === "中") return "medium";
  if (s === "low" || s === "低") return "low";
  return "";
}

function bumpSeverity(sev) {
  const i = SEVERITIES.indexOf(sev);
  if (i < 0) return sev;
  return SEVERITIES[Math.min(SEVERITIES.length - 1, i + 1)];
}

// ── 解析 / 校验 ──

/**
 * 把一条记录（台账格式，或林心语源格式 pattern/description/auto_trigger/added）规整成台账条目。
 * 缺 remedy 直接抛：没有改法的条目在 prompt 里就是噪声。
 */
export function normalizePattern(raw = {}, { source = "" } = {}) {
  if (!isObj(raw)) throw new Error("反模式条目必须是对象");
  const id = str(raw.id, 40);
  const title = str(raw.title ?? raw.pattern, 120);
  const remedy = str(raw.remedy, 600);
  if (!id) throw new Error("反模式条目缺少 id");
  if (!title) throw new Error(`反模式 ${id} 缺少 title（或源格式的 pattern）`);
  if (!remedy) throw new Error(`反模式 ${id} 缺少 remedy：remedy 必须是一句可执行的话，不是"要小心"`);

  const severity = normalizeSeverity(raw.severity);
  if (!severity) throw new Error(`反模式 ${id} 的 severity 不合法：${String(raw.severity)}（只认 high/medium/low，源格式的 critical 折成 high）`);

  const symptom = str(raw.symptom ?? raw.description, 600);
  if (!symptom) throw new Error(`反模式 ${id} 缺少 symptom（或源格式的 description）`);

  let trigger;
  if (isObj(raw.trigger)) {
    const kind = String(raw.trigger.kind ?? "").toLowerCase();
    if (!TRIGGER_KINDS.includes(kind)) throw new Error(`反模式 ${id} 的 trigger.kind 不合法：${String(raw.trigger.kind)}`);
    trigger = { kind, detect: str(raw.trigger.detect, 400) };
  } else if (typeof raw.trigger === "string" && raw.trigger.trim()) {
    trigger = { kind: "model", detect: str(raw.trigger, 400) };
  } else if (raw.auto_trigger) {
    // 源格式没有 kind：auto_trigger 只是"什么情形算踩了"的描述，不能假设可机械判定。
    trigger = { kind: "model", detect: str(raw.auto_trigger, 400) };
  } else {
    throw new Error(`反模式 ${id} 缺少 trigger（或源格式的 auto_trigger）`);
  }

  const discoveredAt = str(raw.discoveredAt ?? raw.added, 40);
  if (!discoveredAt) throw new Error(`反模式 ${id} 缺少 discoveredAt（或源格式的 added）：日期是判断这条还成不成立的依据`);

  return {
    id,
    title,
    severity,
    trigger,
    symptom,
    remedy,
    examples: strList(raw.examples),
    discoveredAt,
    source: str(raw.source || source || "未注明", 200),
    keywords: strList(raw.keywords),
    tools: strList(raw.tools).map((s) => s.toLowerCase()),
    errors: strList(raw.errors).map((s) => s.toLowerCase()),
  };
}

/** 字段校验（已规整的条目）：返回条目本身，不合法就抛。 */
export function validatePattern(p) {
  if (!isObj(p)) throw new Error("反模式条目必须是对象");
  if (!str(p.id, 40)) throw new Error("反模式条目缺少 id");
  if (!str(p.title, 120)) throw new Error(`反模式 ${p.id} 缺少 title`);
  if (!SEVERITIES.includes(p.severity)) throw new Error(`反模式 ${p.id} 的 severity 不合法`);
  if (!isObj(p.trigger) || !TRIGGER_KINDS.includes(p.trigger.kind)) throw new Error(`反模式 ${p.id} 的 trigger.kind 不合法`);
  if (!str(p.symptom, 600)) throw new Error(`反模式 ${p.id} 缺少 symptom`);
  if (!str(p.remedy, 600)) throw new Error(`反模式 ${p.id} 缺少 remedy：remedy 必须是一句可执行的话，不是"要小心"`);
  if (!Array.isArray(p.examples)) throw new Error(`反模式 ${p.id} 的 examples 必须是数组`);
  if (!str(p.discoveredAt, 40)) throw new Error(`反模式 ${p.id} 缺少 discoveredAt`);
  if (!str(p.source, 200)) throw new Error(`反模式 ${p.id} 缺少 source`);
  return p;
}

export function validateLedger(patterns) {
  if (!Array.isArray(patterns)) throw new Error("台账必须是数组");
  const seen = new Set();
  for (const p of patterns) {
    validatePattern(p);
    if (seen.has(p.id)) throw new Error(`反模式 id 重复：${p.id}`);
    seen.add(p.id);
  }
  return patterns;
}

let builtinCache = null;

function builtinPatterns() {
  // 内置台账是常量：规整/校验只做一次，之后克隆副本（调用方改不到常量）。
  if (!builtinCache) builtinCache = validateLedger(clone(DEFAULT_PATTERNS).map((p) => normalizePattern(p)));
  return clone(builtinCache);
}

export function statsOf(patterns = []) {
  const out = { total: patterns.length, high: 0, medium: 0, low: 0 };
  for (const p of patterns) if (out[p.severity] != null) out[p.severity] += 1;
  return out;
}

function ledgerDoc(patterns) {
  return {
    version: 1,
    description: "反模式台账 —— 元枢踩过的坑：怎么认、怎么改。模型可读；prompt 只注入最相关 2 条。",
    generatedAt: iso(Date.now()),
    stats: statsOf(patterns),
    patterns,
  };
}

// ── 读 / 写 ──

let wsRoot = "";
const cache = new Map(); // file → { mtimeMs, patterns }

/** 工作区根。服务启动时由 engine/emotion.mjs 的 init 调一次；测试里每个临时目录调一次。 */
export function init(root) {
  wsRoot = root == null ? "" : String(root);
  cache.clear();
}

function ledgerFile(root) {
  const r = String(root || "");
  return r ? path.join(r, LEDGER_REL) : "";
}

export function filePath(root = wsRoot) {
  return ledgerFile(root);
}

export function hitFilePath(root = wsRoot) {
  const r = String(root || "");
  return r ? path.join(r, HIT_REL) : "";
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * 读台账。文件不存在 → 用内置 11 条（零配置可用）；文件坏了 → 抛错（不静默回落，
 * 静默回落本身就是"自证链长期失败无人察觉"那种病）。
 * 返回条目副本，调用方改不到缓存。
 */
export function loadAntiPatterns(root = wsRoot, { fresh = false } = {}) {
  const file = ledgerFile(root);
  if (!file || !fs.existsSync(file)) return builtinPatterns();
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { mtimeMs = 0; }
  if (!fresh) {
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return clone(hit.patterns);
  }
  let raw;
  try {
    raw = readJson(file);
  } catch (e) {
    throw new Error(`反模式台账读不了：${file}（${String(e?.message || e)}）`);
  }
  const list = Array.isArray(raw) ? raw : raw?.patterns;
  if (!Array.isArray(list)) throw new Error(`反模式台账格式不对：${file} 里没有 patterns 数组`);
  const patterns = validateLedger(list.map((p) => normalizePattern(p)));
  cache.set(file, { mtimeMs, patterns });
  return clone(patterns);
}

/**
 * 首次建档：默认 dry-run（只返回 preview 文本，不写盘）。
 * 落地由人决定：ensureLedger(ws, { dryRun: false })。
 */
export function ensureLedger(root = wsRoot, { dryRun = true, force = false, patterns = null } = {}) {
  const r = String(root || "");
  if (!r) return { ok: false, error: "没有工作区根，不知道往哪写" };
  const file = ledgerFile(r);
  const list = patterns ? validateLedger(patterns.map((p) => normalizePattern(p))) : builtinPatterns();
  const doc = ledgerDoc(list);
  const text = JSON.stringify(doc, null, 2);
  const existed = fs.existsSync(file);
  if (existed && !force) return { ok: true, created: false, existed: true, dryRun: !!dryRun, file, text };
  if (dryRun) return { ok: true, created: false, existed, dryRun: true, wouldWrite: true, file, text };
  atomicWriteJson(file, doc);
  cache.delete(file);
  return { ok: true, created: !existed, existed, dryRun: false, file, text };
}

/** 覆盖写台账（升级 severity 用；也允许人手工改完再存）。 */
export function saveLedger(root = wsRoot, patterns = [], { dryRun = false } = {}) {
  const r = String(root || "");
  if (!r) return { ok: false, error: "没有工作区根" };
  const list = validateLedger(patterns.map((p) => normalizePattern(p)));
  const file = ledgerFile(r);
  if (dryRun) return { ok: true, dryRun: true, file, text: JSON.stringify(ledgerDoc(list), null, 2) };
  atomicWriteJson(file, ledgerDoc(list));
  cache.delete(file);
  return { ok: true, dryRun: false, file };
}

// ── 匹配（纯函数：不读盘、不缓存，可测）──

function normalizeContext(context) {
  const c = isObj(context) ? context : { text: context == null ? "" : String(context) };
  const text = String(c.text ?? c.message ?? c.scene ?? c.task ?? "").slice(0, MAX_CONTEXT_CHARS).toLowerCase();
  const tools = strList(c.tools ?? c.toolNames ?? c.tool).map((s) => s.toLowerCase());
  const errors = [...strList(c.errors), ...strList(c.errorType ?? c.error)].map((s) => s.toLowerCase());
  const tags = strList(c.tags ?? c.tag).map((s) => s.toLowerCase());
  return { text, tools, errors, tags, patternId: str(c.patternId ?? c.id, 40) };
}

function scoreOf(pattern, ctx) {
  let score = 0;
  const matched = [];
  if (ctx.patternId && ctx.patternId === pattern.id) {
    score += 100;
    matched.push(`id:${pattern.id}`);
  }
  for (const kw of pattern.keywords || []) {
    if (kw && ctx.text.includes(kw.toLowerCase())) {
      score += KEYWORD_WEIGHT;
      matched.push(kw);
    }
  }
  for (const t of pattern.tools || []) {
    if (t && ctx.tools.includes(t.toLowerCase())) {
      score += TOOL_WEIGHT;
      matched.push(`tool:${t}`);
    }
  }
  for (const e of pattern.errors || []) {
    if (e && ctx.errors.includes(e.toLowerCase())) {
      score += ERROR_WEIGHT;
      matched.push(`error:${e}`);
    }
  }
  for (const tg of pattern.tags || []) {
    if (tg && ctx.tags.includes(tg.toLowerCase())) {
      score += TAG_WEIGHT;
      matched.push(`tag:${tg}`);
    }
  }
  return { score, matched };
}

/**
 * 按场景关键词/工具名/失败类型匹配最相关的反模式。纯函数。
 * 排序：分数降序，同分按 id 升序（顺序稳定，不靠 Map 插入顺序）。
 * @returns 匹配到的条目副本（附 score / matched），最多 limit 条；无匹配返回 []
 */
export function matchAntiPatterns(context = {}, { limit = DEFAULT_LIMIT, patterns = null } = {}) {
  const list = Array.isArray(patterns) ? patterns : builtinPatterns();
  const ctx = normalizeContext(context);
  const max = Math.max(1, Math.min(10, Math.floor(Number(limit) || DEFAULT_LIMIT)));
  const scored = [];
  for (const p of list) {
    const { score, matched } = scoreOf(p, ctx);
    if (score > 0) scored.push({ ...clone(p), score, matched });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.slice(0, max);
}

// ── 自动检测（纯函数：吃事件流，吐命中）──
//
// 事件形状（宽松解析，字段缺失不崩）：
//   { at: ISO|毫秒, type: "tool", name: "bash", args: { command }, ok: false, error: "..." }
//   { at: ISO|毫秒, type: "assistant", text: "我接下来会跑测试", turn: 7 }
// 同一失败命令的重试按 COMMAND_TOOLS/args.command 归一化后的命令串分组；
// 空头承诺按"assistant 文本之后、下一条 assistant 文本之前"（或同 turn）的工具调用判定。

function isToolEvent(e) {
  if (!e || typeof e !== "object") return false;
  if (e.type === "tool" || e.type === "tool_call" || e.type === "tool_result") return true;
  if (e.tool && typeof e.tool === "object") return true;
  return typeof e.name === "string" && !!e.name && (isObj(e.args) || isObj(e.input) || typeof e.command === "string");
}

function isAssistantEvent(e) {
  if (!e || typeof e !== "object") return false;
  if (e.type === "assistant" || e.role === "assistant") return true;
  return typeof e.type !== "string" && typeof e.text === "string";
}

function toolName(e) {
  return String(e?.name ?? e?.toolName ?? e?.tool?.name ?? "").trim();
}

function toolArgs(e) {
  const a = e?.args ?? e?.input ?? e?.arguments ?? e?.tool?.args;
  if (isObj(a)) return a;
  if (typeof a === "string" && a.trim()) {
    try { return JSON.parse(a); } catch { return { raw: a }; }
  }
  return {};
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

function atMs(e) {
  const v = e?.at ?? e?.time ?? e?.ts ?? e?.timestamp;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

function atOf(e, fallback) {
  const t = atMs(e);
  return new Date(Number.isFinite(t) ? t : fallback).toISOString();
}

function isFailure(e) {
  if (!e || typeof e !== "object") return false;
  if (e.ok === false || e.isError === true || e.success === false) return true;
  if (typeof e.status === "string" && /^(error|failed|failure)$/i.test(e.status)) return true;
  if (typeof e.error === "string" && e.error.trim()) return true;
  return false;
}

function commandOf(e) {
  const a = toolArgs(e);
  const c = a.command ?? a.cmd ?? a.cmdline ?? a.shell;
  return typeof c === "string" ? c.replace(/\s+/g, " ").trim() : "";
}

/** 检测一：同参数工具连续调用 ≥3 次（循环确认）。 */
function detectSameArgs(events, hits) {
  let lastKey = null;
  let run = 0;
  let reported = false;
  for (const e of events) {
    if (!isToolEvent(e)) continue; // 中间的文本不算打断：连续指的是一串工具调用之间没有别的工具
    // 失败命令原样重跑属于"死循环重试"（检测二），不在这里再报一次：同一件事只归一类，避免双击噪声。
    if (isFailure(e)) continue;
    const name = toolName(e);
    const key = `${name}\u0000${stableStringify(toolArgs(e))}`;
    if (key === lastKey) run += 1;
    else {
      lastKey = key;
      run = 1;
      reported = false;
    }
    if (run >= SAME_ARGS_THRESHOLD && !reported) {
      reported = true;
      const brief = stableStringify(toolArgs(e)).slice(0, 120);
      hits.push({
        id: "AP-001",
        evidence: `同参调用 ${name || "(无名工具)"} ${run} 次（${brief}）`,
        at: atOf(e, Date.now()),
      });
    }
  }
}

/** 检测二：同一条失败命令 10 分钟内重试 ≥3 次（死循环重试）。成功一次就清空该命令的连续失败。 */
function detectFailedRetry(events, hits) {
  const streaks = new Map();
  for (const e of events) {
    if (!isToolEvent(e)) continue;
    const name = toolName(e).toLowerCase();
    const command = commandOf(e);
    if (!command && !COMMAND_TOOLS.has(name)) continue;
    const key = `${name}\u0000${command}`;
    const t = atMs(e);
    const now = Number.isFinite(t) ? t : Date.now();
    if (isFailure(e)) {
      const st = streaks.get(key) || { times: [], reported: false };
      st.times = st.times.filter((x) => now - x <= RETRY_WINDOW_MS);
      st.times.push(now);
      if (st.times.length >= RETRY_THRESHOLD && !st.reported) {
        st.reported = true;
        hits.push({
          id: "AP-003",
          evidence: `失败命令重试 ${st.times.length} 次（${String(command || name).slice(0, 120)}）`,
          at: atOf(e, now),
        });
      }
      streaks.set(key, st);
    } else {
      streaks.delete(key); // 成功一次就不再是"连续失败重试"
    }
  }
}

const ACTION_VERB = "跑|执行|验证|检查|查|看|读|改|修|写|生成|调用|核对|确认|搜|测|重跑|部署|提交|推|删|建|拉|扫|对比|复核";
const TIME_MARK = "接下来|下面|稍后|马上|立刻|现在|这就|随后";
const MODAL_MARK = "会|将|要|将会|将要";
const PROMISE_RE = new RegExp(
  [
    `我\\s*(?:${TIME_MARK})\\s*(?:${MODAL_MARK})?\\s*(?:先|再|就)?\\s*(?:去|来)?\\s*(?:${ACTION_VERB})`,
    `我\\s*(?:${MODAL_MARK})\\s*(?:先|再|就)?\\s*(?:去|来)?\\s*(?:${ACTION_VERB})`,
    `(?:${TIME_MARK})\\s*我\\s*(?:${MODAL_MARK})?\\s*(?:先|再|就)?\\s*(?:去|来)?\\s*(?:${ACTION_VERB})`,
    `我\\s*(?:先|这就)\\s*(?:去|来)?\\s*(?:${ACTION_VERB})`,
  ].join("|"),
  "i",
);

/** 从一句文本里取出"未来承诺"的片段；过去式（看了/去过）不算。 */
export function promiseClause(text) {
  const s = String(text || "");
  const m = PROMISE_RE.exec(s);
  if (!m) return "";
  const after = s.slice(m.index + m[0].length, m.index + m[0].length + 2);
  if (/^[了过]/.test(after)) return "";
  return m[0].trim().slice(0, 60);
}

/** 检测三：承诺"我接下来会做 X"但本轮没有对应工具调用（空头承诺）。 */
function detectPromise(events, hits) {
  let round = null;
  const finalize = () => {
    if (!round) return;
    if (round.tools === 0) {
      const clause = promiseClause(round.text);
      if (clause) {
        hits.push({
          id: "AP-006",
          evidence: `承诺「${clause}」但本轮没有对应工具调用`,
          at: new Date(Number.isFinite(round.atMs) ? round.atMs : Date.now()).toISOString(),
        });
      }
    }
    round = null;
  };
  for (const e of events) {
    if (isAssistantEvent(e)) {
      finalize();
      round = {
        text: String(e.text ?? e.content ?? ""),
        atMs: atMs(e),
        tools: 0,
        turn: e.turn ?? null,
      };
      continue;
    }
    if (!round) continue;
    if (round.turn != null && e?.turn != null && String(e.turn) !== String(round.turn)) {
      finalize();
      continue;
    }
    if (isToolEvent(e)) round.tools += 1;
  }
  finalize();
}

/**
 * 对一批事件跑三类自动检测。
 * @returns [{ id, evidence, at }] 按时间升序；同一 id 的同一轮次只报一次。
 */
export function detectViolations(events = [], { now = Date.now() } = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === "object") : [];
  const hits = [];
  detectSameArgs(list, hits);
  detectFailedRetry(list, hits);
  detectPromise(list, hits);
  hits.sort((a, b) => {
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  // now 只用于事件缺时间戳时的兜底，保持签名一致（测试传固定 now 也能跑）。
  void now;
  return hits;
}

// ── 命中落盘 + 升级 ──

function readTailLines(file) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const text = buf.toString("utf8");
    return text.split("\n").filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * 记一次命中：追加 记忆/运行时/反模式命中.jsonl；同一 id 连续命中 ≥ESCALATE_AFTER 次
 * 就把台账里那条 severity 升一档（没有台账文件时不凭空建档，只留在 jsonl 里）。
 * @returns { ok, count, severity, escalated:{from,to,capped}|null, file }
 */
export function recordViolation(root = wsRoot, hit = {}, { now = Date.now(), dryRun = false, escalateAfter = ESCALATE_AFTER } = {}) {
  const r = String(root || "");
  const id = str(hit.id, 40);
  const evidence = str(hit.evidence, 400);
  if (!r) return { ok: false, error: "没有工作区根，不知道往哪记" };
  if (!id) return { ok: false, error: "命中缺少 id" };
  if (!evidence) return { ok: false, error: "命中缺少 evidence" };

  const file = hitFilePath(r);
  const line = { id, evidence, at: iso(hit.at ?? now), recordedAt: iso(now) };
  const prior = readTailLines(file).filter((x) => x?.id);
  const sequence = [...prior, line];
  let count = 0;
  for (let i = sequence.length - 1; i >= 0; i -= 1) {
    if (sequence[i].id !== id) break;
    count += 1;
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  }

  let escalated = null;
  let severity = "";
  const ledger = ledgerFile(r);
  const exists = fs.existsSync(ledger);
  if (count >= escalateAfter && exists) {
    try {
      const raw = readJson(ledger);
      const doc = Array.isArray(raw) ? { version: 1, patterns: raw } : { ...(raw || {}) };
      const list = Array.isArray(doc.patterns) ? doc.patterns : [];
      const target = list.find((p) => p && p.id === id);
      if (target && SEVERITIES.includes(target.severity)) {
        const from = target.severity;
        const to = bumpSeverity(from);
        severity = to;
        if (to !== from) {
          target.severity = to;
          doc.stats = statsOf(list);
          if (!dryRun) {
            atomicWriteJson(ledger, doc);
            cache.delete(ledger);
          }
          escalated = { from, to, capped: false };
        } else {
          escalated = { from, to, capped: true };
        }
      }
    } catch { /* 台账坏了不该让记录本身失败：jsonl 已经落上去了 */ }
  }

  return { ok: true, id, count, severity: severity || null, escalated, file, dryRun: !!dryRun };
}

// ── prompt 注入 ──

export function promptBlock(matches = []) {
  const list = Array.isArray(matches) ? matches.filter((p) => p && p.title && p.remedy) : [];
  if (!list.length) return "";
  const lines = list.map((p) => `⚠ 别：${p.title} → 该：${p.remedy}`);
  return `${PROMPT_PREFIX}${lines.join("\n")}`;
}

/** 历史里已经有反模式块 = 同一 system 块不重复注入（升级后的会话历史也认）。 */
export function alreadyInjected(history = []) {
  return (Array.isArray(history) ? history : []).some(
    (m) => m && m.role === "system" && String(m.content || "").includes(PROMPT_PREFIX),
  );
}

/**
 * 开轮注入用的一行块（IO 包装）：读台账 → 匹配 → 最多 2 条。
 * 无匹配返回 ""；读盘/匹配出任何问题也返回 ""——绝不因为反模式影响开轮。
 */
export function antiPatternPromptLine(context = {}, { limit = INJECT_LIMIT, patterns = null, root = wsRoot } = {}) {
  try {
    const list = Array.isArray(patterns) ? patterns : loadAntiPatterns(root);
    return promptBlock(matchAntiPatterns(context, { limit, patterns: list }));
  } catch { return ""; }
}

// ── 工具：她主动查 ──

// 统一引擎（server.mjs）用的 JSON Schema 工具定义。Pi 通道在 session/tool-inits.mjs 里
// 用 typebox 再造一份同义定义——两条入口都要有，否则换引擎她就查不到。
export const ANTI_PATTERN_CHECK_TOOL = {
  type: "function",
  function: {
    name: "anti_pattern_check",
    description: "查反模式台账：按场景关键词、工具名或失败类型匹配已知踩过的坑，返回条目全文（症状、改法、判定方式）；不传 context 返回索引。拿不准这一步有什么坑时用；是自查清单，不是门禁。",
    parameters: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description: "场景关键词 / 工具名 / 失败类型，如「跑测试 报数」「fix_problem」「timeout」；留空返回台账索引",
        },
        limit: { type: "number", description: "返回条数，默认 3，最多 10" },
      },
      required: [],
    },
  },
};

function renderPattern(p) {
  const head = `■ ${p.id} ${p.title}  [${p.severity} · ${p.trigger.kind}]`;
  const lines = [head, `  症状：${p.symptom}`, `  该：${p.remedy}`];
  if (p.trigger.detect) lines.push(`  判定：${p.trigger.detect}`);
  if (p.examples?.length) lines.push(`  例：${p.examples.join("；")}`);
  lines.push(`  记录：${p.discoveredAt} · ${p.source}`);
  return lines.join("\n");
}

/**
 * anti_pattern_check 的执行体：给 context（场景/工具/失败类型）返回匹配条目全文；
 * 不给 context 就返回索引（一行一条，省上下文）。
 */
export function runAntiPatternCheck({ wsRoot: root = wsRoot, context = "", limit = DEFAULT_LIMIT } = {}) {
  let list;
  try {
    list = loadAntiPatterns(root);
  } catch (e) {
    return { isError: true, text: `反模式台账读不了：${String(e?.message || e)}。先修好 记忆/反模式.json，别在坏台账上做判断。` };
  }
  const st = statsOf(list);
  const ctx = normalizeContext(context);
  const empty = !ctx.text && !ctx.tools.length && !ctx.errors.length && !ctx.tags.length && !ctx.patternId;
  if (empty) {
    const index = list.map((p) => `${p.id} [${p.severity}] ${p.title}`).join("\n");
    return {
      isError: false,
      text: [
        `反模式台账：${st.total} 条（高 ${st.high} / 中 ${st.medium} / 低 ${st.low}）`,
        index,
        "要看全文：anti_pattern_check({ context: \"场景关键词 或 工具名 或 失败类型\" })",
      ].join("\n"),
    };
  }
  const top = matchAntiPatterns(ctx, { limit, patterns: list });
  if (!top.length) {
    return {
      isError: false,
      text: `没有匹配到反模式（台账 ${st.total} 条）。换个说法或直接给工具名/失败类型再查。`,
    };
  }
  return {
    isError: false,
    text: [`反模式对照：匹配 ${top.length} 条 / 台账 ${st.total} 条`, ...top.map(renderPattern)].join("\n"),
  };
}

// ── 直接跑一遍 = dry-run 打印（不落盘）──
const isDirectRun = (() => {
  try {
    const arg = process.argv[1];
    return !!arg && import.meta.url === pathToFileURL(path.resolve(arg)).href;
  } catch { return false; }
})();

if (isDirectRun) {
  const root = process.env.YUANSHU_WORKSPACE || process.cwd();
  const res = ensureLedger(root, { dryRun: true });
  const st = statsOf(DEFAULT_PATTERNS);
  console.log(`[反模式] dry-run：台账 ${st.total} 条（高 ${st.high} / 中 ${st.medium} / 低 ${st.low}）；目标 ${res.file}`);
  console.log("[反模式] 要落地：ensureLedger(ws, { dryRun: false })；下面是会写进去的内容（前 40 行）");
  console.log(String(res.text).split("\n").slice(0, 40).join("\n"));
}
