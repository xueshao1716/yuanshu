// engine/appearance-merge.mjs —— 「灵魂为主、外观.md 为辅」的唯一合并器（2026-11-08）
//
// 为什么要有：形象有两份来源，而且长在两套链路上——
//   · 主：记忆/人格定义.json 的 appearance / hairstyle / clothing / scenarioOutfits
//        （灵魂培养编辑，注入面、自我.md、出图母提示词都该认它）
//   · 辅：记忆/外观.md（画「画个你」那条路直接读它）
// 以前画图读辅、说话读主，于是画出来的人和说出来的不是同一个人。
//
// 规则（冲突以主为准，辅只补细节）：
//   1. 主里有这一项 → 这一项用主，辅的同项内容**不整体替换**；
//   2. 主里没有这一项 → 才用辅的对应项（并在 text 里标「补自 记忆/外观.md」）；
//   3. 辅里那些主里没写的**细节**（眼睛/笑的神态、气质）→ 作为「补充」追加，
//      每条补充都带来源，便于排查；
//   4. 冲突判定按**小句**做，按项分开：主写了发型时，辅里"及肩/齐耳/长发/直发/刘海"这类
//      **定形**说法整句丢掉（避免两套头发）；**染色**（发梢星空蓝/挑染）也算冲突（改发色不是细节）。
//      衣服：主有衣服时，辅里的衣服名词（卫衣/连帽衫/裙/裤…）丢掉，领口/徽章/配饰照收。
//      外貌：主有外貌时，辅里的脸型/身材/肤质/年龄说法丢掉，眼睛神态/笑/气质照收。
//   5. 纯函数：mergeAppearance 不读文件、不碰 IO；读文件只在 loadAuxAppearance 里，
//      读不到就当没有辅（主照常生效，不报错）。
//   6. 硬边界（2026-11-08）：**主读取失败时禁用辅**。人格定义读失败会回退 DEFAULT_DEFINITION
//      （四项空），这时如果再让 外观.md 顶上 primary，"及肩连帽衫"就成了她的正式外观——
//      那比没有外貌更糟。判据只看 loadPersonaDefinition 的 source / problems，
//      三处调用（出图母提示词、画个你、自我.md）统一走 mergeAppearanceWithPersona，不许各写一份。
import fs from "node:fs";
import path from "node:path";
import { loadPersonaDefinition } from "./persona-def.mjs";

export const AUX_REL = path.join("记忆", "外观.md");
export const AUX_SOURCE = "记忆/外观.md";

// 中文名与 engine/persona-def.mjs 的 designLabels、engine/self-model.mjs 保持一致。
export const DESIGN_FIELDS = Object.freeze([
  { key: "appearance", label: "人物外貌" },
  { key: "hairstyle", label: "发型与发色" },
  { key: "clothing", label: "日常服装" },
  { key: "scenarioOutfits", label: "场景穿搭" },
]);

const KEYS = DESIGN_FIELDS.map((f) => f.key);
const LABEL = Object.fromEntries(DESIGN_FIELDS.map((f) => [f.key, f.label]));

// ── 读辅（只在这里碰文件系统）──────────────────────────────────────────────
/** 去掉注释与标题行，一行一条；解析失败/文件不存在都返回空数组。 */
export function parseAuxLines(raw = "") {
  const text = String(raw || "").replace(/<!--[\s\S]*?-->/g, "\n");
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.replace(/^[-*+>]\s+/, "").trim();
    if (cleaned) out.push(cleaned);
  }
  return out.filter((line, i, all) => all.indexOf(line) === i);
}

/** 读 记忆/外观.md。没有这个文件是正常状态，不是错误。 */
export function loadAuxAppearance(wsRoot, { fsMod = fs } = {}) {
  const file = path.join(String(wsRoot || "."), AUX_REL);
  let raw = "";
  try { raw = fsMod.readFileSync(file, "utf8"); } catch { /* 辅设定缺失 → 只用主 */ }
  return { file, lines: parseAuxLines(raw), text: raw };
}

// ── 硬边界（2026-11-08）：主读取失败 → 禁用辅 ───────────────────────────────
// 判据只认 loadPersonaDefinition 的返回值（engine/persona-def.mjs）：
//   source === "file" 且 problems 为空            → 主可用，辅可以补细节；
//   source !== "file"（文件缺失 / JSON 读坏回退）  → 主不可用，辅一律不参与；
//   problems 非空（校验不过）                      → 主不可用，辅一律不参与。
// 没有"主读失败但辅顶上 primary"这条兜底：宁可没有外貌，也不要一套假的。
let _lastGateWarnKey = "";

function warnAuxDisabled(gate) {
  const key = `${gate.reason}|${gate.source}|${gate.detail || ""}`;
  if (key === _lastGateWarnKey) return; // 每轮都拼自我描述，同一种故障只提示一次，别刷屏
  _lastGateWarnKey = key;
  try {
    console.warn(
      `[appearance] 主形象设定不可用（source=${gate.source || "?"}，reason=${gate.reason}），已禁用 ${AUX_SOURCE}：${gate.detail || "读不到主设定"}`
    );
  } catch { /* 日志失败不影响主流程 */ }
}

/**
 * 主形象设定能不能用（唯一判据）。失败时区分原因，便于排查：
 *   read-failed / missing / invalid / load-threw
 * @returns {{ok:boolean, disabled:boolean, reason:string, source:string, problems:string[], detail:string}}
 */
export function appearanceMainGate(wsRoot, { loadPersona = loadPersonaDefinition } = {}) {
  let pd;
  try { pd = loadPersona(wsRoot) || {}; }
  catch (e) {
    return { ok: false, disabled: true, reason: "load-threw", source: "", problems: [], detail: String(e?.message || e).slice(0, 120) };
  }
  const source = String(pd.source || "");
  const problems = Array.isArray(pd.problems) ? pd.problems.filter(Boolean).map(String) : [];
  const detail = problems.join("；").slice(0, 160);
  if (source !== "file") {
    // 人格定义缺失与 JSON 读坏都会走到 source=default；问题文案里带"读取失败"的是后者。
    const readFailed = problems.some((p) => p.includes("读取失败"));
    return { ok: false, disabled: true, reason: readFailed ? "read-failed" : "missing", source: source || "default", problems, detail };
  }
  if (problems.length) return { ok: false, disabled: true, reason: "invalid", source, problems, detail };
  return { ok: true, disabled: false, reason: "", source, problems, detail: "" };
}

/**
 * 三处唯一入口：这次能交给 mergeAppearance 的辅内容。
 * - 给了 wsRoot：先判主；主不可用 → aux=[]（宁可没有外貌）。调用方显式传的 aux 也一并作废，
 *   否则"主失败禁用辅"只要传一次 aux 就能绕过去。
 * - 没给 wsRoot：无从判断主，保留旧行为（调用方显式 aux 照用；不读盘），reason=unchecked。
 * @returns {{aux:any, disabled:boolean, reason:string, source:string, problems:string[], detail:string}}
 */
export function appearanceAuxFor(wsRoot, { aux, loadPersona } = {}) {
  if (!wsRoot) {
    return { aux: aux != null ? aux : [], disabled: false, reason: "unchecked", source: "", problems: [], detail: "" };
  }
  const gate = appearanceMainGate(wsRoot, { loadPersona });
  if (gate.disabled) { warnAuxDisabled(gate); return { ...gate, aux: [] }; }
  return { ...gate, aux: aux != null ? aux : loadAuxAppearance(wsRoot).lines };
}

// ── 归类：一句话属于哪一项 / 是不是画风 ─────────────────────────────────────
// 顺序有讲究：先认画风（"柔和光晕"不是头发），再认衣服（"领口发光徽章"不是眼睛），最后才是发型/外貌。
const STYLE_RE = /(整体|氛围|画风|风格|插画|光晕|赛博|治愈|高质量|电影感|胶片|光影|色调|背景)/;
const CLOTHING_RE = /(衣|衫|卫衣|连帽|裤|裙|外套|风衣|制服|鞋|靴|袜|穿搭|徽章|领口|袖|配饰|项链|耳环|背包|腰带|礼服)/;
// 不用裸"发"：会让"发光徽章"误判成头发。
const HAIR_RE = /(头发|发型|发色|发梢|发尾|发丝|刘海|马尾|辫|盘发|卷发|直发|短发|长发|及肩|齐耳|齐肩|披肩|寸头|板寸)/;
const LOOK_RE = /(眼睛|眼尾|眼神|目光|脸|皮肤|肤色|五官|唇|眉|鼻|身材|身高|体型|肩|锁骨|腰|气质|表情|笑|神情|年龄|岁)/;
const SCENE_LABEL_RE = /^(工作|阅读|休息|外出|居家|运动|通勤|学习|约会)\s*[：:]/;

function classifyClause(text) {
  const t = String(text || "");
  if (STYLE_RE.test(t)) return null; // null = 不属于四项，只能当补充/画风
  if (SCENE_LABEL_RE.test(t)) return "scenarioOutfits";
  if (CLOTHING_RE.test(t)) return "clothing";
  if (HAIR_RE.test(t)) return "hairstyle";
  if (LOOK_RE.test(t)) return "appearance";
  return null;
}

// ── 冲突判定：只有"定形"的说法才算冲突；细节一律放行 ─────────────────────────
const CONFLICT_RULES = {
  hairstyle: [
    /(发梢|挑染|挑色|渐变染|染色|星空蓝|荧光|银发|紫发|粉发|蓝发)/,
    /(及肩|齐耳|齐肩|过肩|及胸|及腰|腰下|超长|披肩|寸头|板寸|波波头|短发|中长发|长发)/,
    /(直发|卷发|大波浪|内扣|外翻|微卷)/,
    /(空气刘海|齐刘海|厚刘海|直刘海|斜刘海|无刘海)/,
  ],
  clothing: [
    /(徽章|赛博配饰|机械臂|发光装饰)/,
    /(连帽衫|卫衣|T恤|衬衫|衬衣|针织|毛衣|上衣|短裤|长裤|裤子|半身裙|连衣裙|裙|外套|风衣|大衣|西装|制服|JK|汉服|旗袍|板鞋|运动鞋|高跟鞋|靴|袜|背心|吊带|礼裙)/,
  ],
  appearance: [
    /(鹅蛋脸|圆脸|方脸|瓜子脸|下颌线|眼尾|双眼皮|单眼皮)/,
    /(身材|体型|身高|个子|微胖|丰腴|偏瘦|匀称)/,
    /(皮肤|肤色|冷调|暖调|白净|白皙)/,
    /(年龄|岁|少女|御姐|萝莉)/,
  ],
};

function isConflict(field, clause, mainText) {
  const main = String(mainText || "");
  if (!main) return false; // 主没写这一项，谈不上冲突（辅可以顶上）
  if (field === "scenarioOutfits") {
    // 辅里同一场景换一套穿法 → 算冲突；主里没写的场景 → 可以作为补充
    const m = clause.match(SCENE_LABEL_RE);
    return !!(m && main.includes(m[1]));
  }
  return (CONFLICT_RULES[field] || []).some((re) => re.test(clause));
}

// ── 拆小句 ────────────────────────────────────────────────────────────────
function clausesOf(text, field = null) {
  return String(text || "")
    .split(/[\n。；;]/)
    .flatMap((seg) => seg.split(/[，,、]/))
    .map((seg) => seg.trim())
    .filter((seg) => seg.length >= 2 && /[\u4e00-\u9fffA-Za-z0-9]/.test(seg))
    .map((seg) => ({ text: seg, field }));
}

function auxEntries(aux) {
  if (aux == null) return [];
  if (typeof aux === "string") return parseAuxLines(aux).flatMap((line) => clausesOf(line));
  if (Array.isArray(aux)) {
    return aux.filter((x) => typeof x === "string").flatMap((line) => clausesOf(line));
  }
  if (typeof aux === "object") {
    const out = [];
    for (const key of KEYS) {
      if (typeof aux[key] === "string") out.push(...clausesOf(aux[key], key));
    }
    if (Array.isArray(aux.lines)) out.push(...aux.lines.filter((x) => typeof x === "string").flatMap((line) => clausesOf(line)));
    return out;
  }
  return [];
}

function oneLine(value) {
  return String(value || "").replace(/\s*\n\s*/g, " ").trim();
}

// ── 主函数 ────────────────────────────────────────────────────────────────
/**
 * 合并主设定（人格定义四项）与补充外观（外观.md）。
 * @param {{main?:object, aux?:string|string[]|object}} input
 * @returns {{
 *   primary: {appearance:string,hairstyle:string,clothing:string,scenarioOutfits:string},
 *   supplements: {field:string|null,label:string,text:string,source:string,kind:'detail'|'style'}[],
 *   text: string,
 *   sources: {[key:string]: 'main'|'aux'|''},
 *   dropped: {field:string|null,text:string,reason:'conflict'|'duplicate'|'empty'}[]
 * }}
 */
export function mergeAppearance({ main, aux } = {}) {
  const m = main && typeof main === "object" ? main : {};
  const mainText = Object.fromEntries(
    KEYS.map((key) => [key, typeof m[key] === "string" ? m[key].trim() : ""])
  );

  const entries = auxEntries(aux);
  const primary = Object.fromEntries(KEYS.map((key) => [key, mainText[key]]));
  const sources = Object.fromEntries(KEYS.map((key) => [key, mainText[key] ? "main" : ""]));
  const supplements = [];
  const dropped = [];
  const seenSupplement = new Set();

  // 先把每条小句归到某一项（显式字段优先，否则按关键词猜），保持辅文件里的原顺序
  const resolved = entries.map((entry) => ({ ...entry, field: entry.field || classifyClause(entry.text) }));

  // ① 主缺的项：先用辅的对应项顶上（按字段聚合，字段内保持原顺序）
  const auxByField = Object.fromEntries(KEYS.map((key) => [key, []]));
  for (const entry of resolved) {
    if (entry.field && KEYS.includes(entry.field)) auxByField[entry.field].push(entry.text);
  }
  for (const key of KEYS) {
    if (mainText[key] || !auxByField[key].length) continue;
    primary[key] = auxByField[key].join("，");
    sources[key] = "aux";
  }

  // ② 主有的项：辅里同项的句子逐句判断——定形的丢掉，细节的收作补充；
  //    归不到四项的句子（画风/整体气质）一律只当补充，绝不覆盖四项。
  for (const entry of resolved) {
    const field = entry.field && KEYS.includes(entry.field) ? entry.field : null;
    const clause = entry.text;
    if (seenSupplement.has(clause)) continue;
    if (field && !mainText[field]) continue; // 主缺这一项 → 已被当成 primary，不再重复当补充
    if (field && isConflict(field, clause, mainText[field])) {
      dropped.push({ field, text: clause, reason: "conflict" });
      continue;
    }
    if (KEYS.some((key) => mainText[key] && mainText[key].includes(clause))) {
      dropped.push({ field, text: clause, reason: "duplicate" });
      continue;
    }
    seenSupplement.add(clause);
    supplements.push({
      field,
      label: field ? LABEL[field] : "",
      text: clause,
      source: AUX_SOURCE,
      kind: STYLE_RE.test(clause) ? "style" : "detail",
    });
  }

  // ④ 拼中文描述：主（或补自辅的整项）在前，补充在后，且组内标明来源
  const lines = [];
  for (const { key, label } of DESIGN_FIELDS) {
    if (!primary[key]) continue;
    const from = sources[key] === "aux" ? `（补自 ${AUX_SOURCE}）` : "";
    lines.push(`${label}${from}：${oneLine(primary[key])}`);
  }
  // 画风词（赛博朋克/插画/治愈系/光晕…）**不进母提示词**：主设定的四项已定死"真人纪实摄影"，
  // 再并一句"赛博朋克×治愈系/高质量插画"会把整张图拉去插画风——2026-11-08 用户当场指出。
  // 它们仍留在 supplements 里（kind:'style'）便于排查，但不参与 text 拼接。
  const detailSuppl = supplements.filter((s) => s.kind !== "style");
  if (detailSuppl.length) {
    lines.push(`补充细节（来自 ${AUX_SOURCE}，主设定没写的部分）：${detailSuppl.map((s) => s.text).join("；")}`);
  }

  return { primary, supplements, text: lines.join("；"), sources, dropped };
}

/**
 * 带「主失败禁用辅」硬边界的合并入口——三处调用只用这一个函数。
 * 返回在 mergeAppearance 的结果上多四个字段，便于调用方/界面看出为什么没外貌：
 *   auxDisabled / auxDisabledReason / auxDisabledDetail / personaSource
 * @param {{wsRoot?:string, def?:object, aux?:any, loadPersona?:Function}} input
 */
export function mergeAppearanceWithPersona({ wsRoot, def, aux, loadPersona } = {}) {
  const gate = appearanceAuxFor(wsRoot, { aux, loadPersona });
  const main = Object.fromEntries(
    DESIGN_FIELDS.map(({ key }) => [key, typeof def?.[key] === "string" ? def[key] : ""])
  );
  const merged = mergeAppearance({ main, aux: gate.aux });
  return {
    ...merged,
    auxDisabled: gate.disabled,
    auxDisabledReason: gate.reason,
    auxDisabledDetail: gate.detail || "",
    personaSource: gate.source || "",
  };
}
