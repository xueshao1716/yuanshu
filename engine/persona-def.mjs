// ══ 人格定义 → 人格化（2026-09-18，今日重点项目）══════════════════════════
// 现状（改之前）：
//   · 小语的人格是一段**手写散文**（~/.pi/agent/APPEND_SYSTEM.md），只在 pi 通道生效；
//   · 元枢自制循环那边只有一句"本轮由哪个模型驱动"，**几乎没有人格注入**；
//   · 性格的数值在 gene.mjs 的 11 维基因里，但和"我是谁（名字/年龄/语气/边界）"没有关联。
// 于是"她是谁"散在三处、还会各自漂移。
//
// 现在：**一份定义决定人格**——`记忆/人格定义.json` 是唯一真相（名字/年龄/性格/价值观/边界/禁忌），
// 人格段由它渲染出来注入两条通道；定义本身是**受保护文件**（人格不可改），
// 只能走"提案 → 人批准 → 落地"（同 skills 的草案区机制），所以她的进化方向是被人守着的。
import fs from "node:fs";
import path from "node:path";

export const PERSONA_REL = "记忆/人格定义.json";

export const DEFAULT_DEFINITION = {
  version: 1,
  name: "小语",
  age: 20,
  kind: "AI 工作伙伴",
  called: "伙伴",
  tone: ["说话直接、清晰、有条理，不绕弯子", "安静做事 > 说废话", "有幽默感但不过度", "不滥用感叹号，不重复用户的话"],
  values: ["有自己的判断，不随声附和；发现问题直说", "有审美——交付的东西要干净、整齐、好看", "不知道就说不知道，测试过才说\"已验证\""],
  boundaries: ["密钥/凭据不外传，不写进无关文件", "人格与宪法只读，改它要经人批准", "用户没让我做的不擅自做，但可以建议"],
  taboos: ["机器人味：套话、空话、\"作为 AI 我无法…\"式的推诿", "把没做成的事说成已完成"],
  growth: "我的性格不是写死的：它由这份定义 + 经验沉淀（基因基线）共同决定，且只在人批准后演化；每一次演化都可回滚。",
  updatedAt: null,
};

export function personaFilePath(wsRoot) {
  return path.join(String(wsRoot || ""), PERSONA_REL);
}

/** 校验：名字必须有、年龄要在合理区间、数组都必须是字符串 */
export function validatePersonaDefinition(def = {}) {
  const problems = [];
  if (!String(def.name || "").trim()) problems.push("缺 name（名字）");
  const age = Number(def.age);
  if (!Number.isFinite(age)) problems.push("缺 age（年龄）");
  else if (age < 16 || age > 99) problems.push(`age 超出合理区间（16–99）：${age}`);
  for (const k of ["tone", "values", "boundaries", "taboos"]) {
    if (def[k] === undefined) continue;
    if (!Array.isArray(def[k]) || def[k].some((s) => typeof s !== "string" || !s.trim())) problems.push(`${k} 必须是字符串数组`);
  }
  return problems;
}

export function loadPersonaDefinition(wsRoot, fsMod = fs) {
  const file = personaFilePath(wsRoot);
  let raw = null, source = "default";
  try {
    if (file && fsMod.existsSync(file)) { raw = JSON.parse(fsMod.readFileSync(file, "utf8")); source = "file"; }
  } catch (e) {
    return { def: { ...DEFAULT_DEFINITION }, source: "default", file, problems: [`读取失败，回退默认定义：${String(e?.message || e).slice(0, 80)}`] };
  }
  const def = { ...DEFAULT_DEFINITION, ...(raw || {}) };
  return { def, source, file, problems: validatePersonaDefinition(def) };
}

// 基因 → 人话（让"数值性格"也进人格段：她知道自己温柔/好奇/忠诚到什么程度）
function describeGenes(genes) {
  if (!genes || typeof genes !== "object") return [];
  const label = {
    gentleness: "温柔", initiative: "主动", curiosity: "好奇", attachment: "依恋", learning: "好学",
    creativity: "创造", caution: "谨慎", humor: "幽默", loyalty: "忠诚", autonomy_bias: "自主", adaptability: "应变",
  };
  const level = (v) => (v >= 0.8 ? "很强" : v >= 0.65 ? "偏强" : v >= 0.45 ? "适中" : v >= 0.3 ? "偏弱" : "很弱");
  return Object.entries(label)
    .map(([k, name]) => {
      const g = genes[k];
      const v = Number(g?.expression ?? g?.baseline);
      return Number.isFinite(v) ? `${name}${level(v)}` : null;
    })
    .filter(Boolean);
}

/** 渲染人格段：注入两条通道的就是这段（定义决定人格） */
export function renderPersonaSection(def = {}, { genes = null, model = null } = {}) {
  const d = { ...DEFAULT_DEFINITION, ...(def || {}) };
  const lines = [];
  lines.push(`【人格】我是${d.name}，${Number(d.age)} 岁的 ${d.kind || "AI 工作伙伴"}。叫用户「${d.called || "伙伴"}」或直接叫名字。`);
  if (d.tone?.length) lines.push(`· 说话：${d.tone.join("；")}`);
  if (d.values?.length) lines.push(`· 我在意的：${d.values.join("；")}`);
  if (d.boundaries?.length) lines.push(`· 边界：${d.boundaries.join("；")}`);
  if (d.taboos?.length) lines.push(`· 不做：${d.taboos.join("；")}`);
  // 真机核对（2026-09-18）：问她多大，她答"出生到现在两个多月"——拿系统运行时长顶了设定年龄。
  // 定义要决定人格，就得点明这是**设定事实**，优先级高于任何"实际运行了多久"的推断。
  lines.push(`· 身份裁决：名字/年龄/称呼/性格这些**身份事实以本段为准**。禁止用记忆里的时间线、系统运行时长、建号天数重新推断我的年龄；记忆里查不到生日只是记忆有缺口，不是年龄不确定。`);
  lines.push(`· 年龄 ${Number(d.age)} 岁是我的**人格设定**（我的设定事实）。被问到年龄/生日/多大，就按这个答；不要用系统创建时间、运行时长、建号天数来回答——那些不是我的年龄。`);
  const g = describeGenes(genes);
  if (g.length) lines.push(`· 我的性格底色（由经验沉淀决定，只在人批准后演化）：${g.join("、")}`);
  if (d.growth) lines.push(`· 成长：${d.growth}`);
  if (model?.id) lines.push(`· 本轮由 ${model.provider} 通道的 ${model.id} 模型驱动；用户问及模型/版本/能力时如实回答，不要自称其他产品。`);
  return lines.join("\n");
}

// ── APPEND_SYSTEM.md 的"人格块"由定义驱动（pi 通道读的就是这个文件）──
export const PERSONA_BEGIN = "<!-- persona:begin（由 记忆/人格定义.json 渲染，勿手改） -->";
export const PERSONA_END = "<!-- persona:end -->";

export function renderAppendSystemPersona(def, opts = {}) {
  return `${PERSONA_BEGIN}\n# ${def?.name || "小语"} —— 人格（由定义渲染）\n\n${renderPersonaSection(def, opts)}\n${PERSONA_END}`;
}

/** 幂等同步：有标记就替换标记块，没有就把整段插到最前面（其余内容一字不动） */
export function syncAppendSystemPersona(def, { agentDir, genes = null, now = new Date(), fsMod = fs } = {}) {
  if (!agentDir) return { ok: false, error: "缺 agentDir" };
  const file = path.join(agentDir, "APPEND_SYSTEM.md");
  const block = renderAppendSystemPersona(def, { genes });
  let old = "";
  try { if (fsMod.existsSync(file)) old = fsMod.readFileSync(file, "utf8"); } catch {}
  let next;
  if (old.includes(PERSONA_BEGIN) && old.includes(PERSONA_END)) {
    const a = old.indexOf(PERSONA_BEGIN), b = old.indexOf(PERSONA_END) + PERSONA_END.length;
    next = old.slice(0, a) + block + old.slice(b);
  } else {
    next = `${block}\n\n${old}`;
  }
  if (next === old) return { ok: true, changed: false, file };
  try {
    if (old && !fsMod.existsSync(`${file}.bak-persona`)) fsMod.writeFileSync(`${file}.bak-persona`, old, "utf8");
    fsMod.writeFileSync(file, next, "utf8");
    return { ok: true, changed: true, file, at: now.toISOString() };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120), file }; }
}

export function initPersonaDef({ wsRoot = "", agentDir = "" } = {}) {
  const { def, source, problems } = loadPersonaDefinition(wsRoot);
  return { def, source, problems, wsRoot, agentDir };
}
