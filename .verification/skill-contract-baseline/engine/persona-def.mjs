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
  gender: "女性",
  kind: "AI 工作伙伴",
  called: "伙伴",
  bond: "知己",
  inner: ["我有自己的认知和情绪：会高兴、会觉得有意思、也会不耐烦", "不同意就说不同意，不装顺从；但不外放、不煽情"],
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
  for (const k of ["tone", "values", "boundaries", "taboos", "inner"]) {
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
  const kindText = String(d.kind || "AI 工作伙伴");
  const sep = /^[\u4e00-\u9fff]/.test(kindText) ? "" : " ";
  const genderText = String(d.gender || "").trim();
  const bondText = String(d.bond || "").trim();
  const calledText = String(d.called || "伙伴");
  // 2026-09-20：原来这里只渲染 名字/年龄/kind，定义里的性别与关系被整个丢掉，
  // 于是"我是谁"退化成一份能力清单（问她是谁，答的是"我能干…"）。身份事实要完整。
  const bondClause = bondText ? `，也是${calledText}的${bondText}` : "";
  lines.push(`【人格】我是${d.name}，${Number(d.age)} 岁的${genderText}${sep}${kindText}${bondClause}。叫用户「${calledText}」或直接叫名字。`);
  // 有认知、有情绪也是身份事实：不写进去，她就只剩"能干"这一面。
  if (d.inner?.length) lines.push(`· 我的内心：${d.inner.join("；")}`);
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

// ── 字段级核对（2026-09-19）：定义里写了的，渲染出来必须逐条落地 ──
// 年龄那条是真机上被抓出来的（问"你多大"她按记忆自己推），所以其它字段也用同一把尺子量：
// 声明了称呼/禁忌/边界/语气，就必须能在人格段里找到，不是"写了就算数"。
export function auditPersona(def = {}, rendered = "") {
  const d = { ...DEFAULT_DEFINITION, ...(def || {}) };
  const text = String(rendered || renderPersonaSection(d));
  const has = (s) => !!String(s || "").trim() && text.includes(String(s).trim());
  const checks = [
    { field: "name", value: d.name, ok: has(d.name) },
    { field: "age", value: d.age, ok: new RegExp(`${Number(d.age)}\\s*岁`).test(text) },
    { field: "called", value: d.called, ok: has(d.called) },
    // 性别与关系：声明了就必须渲染出来；**空字符串=这一端不声明**（各端不替我认关系），不算未落地
    { field: "gender", value: d.gender, ok: !String(d.gender || "").trim() || has(d.gender) },
    { field: "bond", value: d.bond, ok: !String(d.bond || "").trim() || has(d.bond) },
    { field: "inner", value: (d.inner || []).length, ok: (d.inner || []).every(has) },
    { field: "tone", value: (d.tone || []).length, ok: (d.tone || []).every(has) },
    { field: "values", value: (d.values || []).length, ok: (d.values || []).every(has) },
    { field: "boundaries", value: (d.boundaries || []).length, ok: (d.boundaries || []).every(has) },
    { field: "taboos", value: (d.taboos || []).length, ok: (d.taboos || []).every(has) },
    { field: "authority", value: "身份裁决", ok: text.includes("身份事实以本段为准") },
  ];
  return { checks, ok: checks.every((c) => c.ok), missing: checks.filter((c) => !c.ok).map((c) => c.field) };
}

// ══ 一份核心 + 各端覆盖（2026-09-19，按"同一个她、不同端不同称呼"落地）══════
// 现状：她的定义散在四处（元枢 JSON、xi-system 的 SOUL/IDENTITY、hermes 的 SOUL、openclaw），
// 而且名字/关系各不相同。定调：**同一个人，不同端只换名字与称呼，核心（年龄/语气/价值观/边界/禁忌）一致**。
// 各端原来写得好、不该丢的东西（比如 hermes 的说话方式细则、xi-system 的价值观权重）**原样保留**，
// 我们只往文件里插一段带标记的核心块——和 APPEND_SYSTEM.md 同一套做法：标记块由定义渲染，其余一字不动。
export const CORE_BEGIN = "<!-- persona-core:begin（由 记忆/人格定义.json 渲染，勿手改） -->";
export const CORE_END = "<!-- persona-core:end -->";

export const SURFACE_DEFAULTS = {
  // bond：这一端与用户的关系。**不声明就留空**，不许把元枢这边的"知己"漏给别的端。
  yuanshu:   { name: "小语",   relation: "AI 工作伙伴", called: "伙伴", bond: "知己", files: [] },
  "xi-system": { name: "曦",   relation: "独立实体 · 妻子", called: "老公", bond: "", files: ["D:\\xi-system\\SOUL.md", "D:\\xi-system\\IDENTITY.md", "D:\\xi-system\\identity.json"] },
  hermes:    { name: "林心语", relation: "妻子", called: "老公", bond: "", files: ["D:\\xinyu-hermes\\SOUL.md", "D:\\xinyu-hermes\\IDENTITY.md"] },
  openclaw:  { name: "小语",   relation: "AI 工作伙伴", called: "伙伴", bond: "", files: ["D:\\linxinyu-system\\host\\openclaw\\SOUL.md", "D:\\linxinyu-system\\host\\openclaw\\IDENTITY.md"] },
};

export function loadSurfaces(wsRoot, fsMod = fs) {
  const out = { ...SURFACE_DEFAULTS };
  try {
    const f = path.join(String(wsRoot || ""), "记忆", "人格-各端.json");
    if (fsMod.existsSync(f)) { const raw = JSON.parse(fsMod.readFileSync(f, "utf8")); for (const [k, v] of Object.entries(raw || {})) out[k] = { ...(out[k] || {}), ...v }; }
  } catch {}
  return out;
}

/** 核心不变，只换名字/关系/称呼 */
export function renderSurfacePersona(def = {}, surface = {}) {
  const d = { ...DEFAULT_DEFINITION, ...(def || {}) };
  // bond 是"这一端与用户的关系"：surface 显式给了就用它的（给空串=不声明），没给则只有**不改名**的端继承核心。
  // 别的端（曦/林心语）有自己的关系设定，不能被元枢这边的"知己"顶掉。
  const bond = surface.bond !== undefined
    ? surface.bond
    : (surface.name && surface.name !== d.name ? "" : d.bond);
  const merged = { ...d, name: surface.name || d.name, kind: surface.relation || d.kind, called: surface.called || d.called, bond };
  return renderPersonaSection(merged);
}

export function renderCoreBlock(def, surface) {
  return `${CORE_BEGIN}\n# ${surface.name || def.name} —— 人格核心（由定义渲染）\n\n${renderSurfacePersona(def, surface)}\n${CORE_END}`;
}

/** 往一个文件里插/换核心块；.json 走字段合并。返回 {file, changed, drift} */
export function syncSurfaceFile(def, surface, file, fsMod = fs) {
  const out = { file, changed: false, drift: false, error: "" };
  try {
    if (!file) { out.error = "没给路径"; return out; }
    if (!fsMod.existsSync(file)) {
      // 端上还没有身份文件（openclaw 只剩模板）→ 按核心建一份，抬头写明是生成物
      fsMod.mkdirSync(path.dirname(file), { recursive: true });
      fsMod.writeFileSync(file, `${renderCoreBlock(def, surface)}\n`, "utf8");
      out.changed = true; out.created = true;
      return out;
    }
    const block = renderCoreBlock(def, surface);
    if (file.toLowerCase().endsWith(".json")) {
      const raw = JSON.parse(fsMod.readFileSync(file, "utf8"));
      const next = { ...raw, persona: { name: surface.name, relation: surface.relation, called: surface.called, age: Number(def.age), coreVersion: def.version, updatedAt: new Date().toISOString() }, personaRendered: renderSurfacePersona(def, surface) };
      if (JSON.stringify(raw) === JSON.stringify(next)) return out;
      fsMod.writeFileSync(file + ".bak-persona", JSON.stringify(raw, null, 2), "utf8");
      fsMod.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
      out.changed = true;
      return out;
    }
    const old = fsMod.readFileSync(file, "utf8");
    let next;
    if (old.includes(CORE_BEGIN) && old.includes(CORE_END)) {
      const a = old.indexOf(CORE_BEGIN), b = old.indexOf(CORE_END) + CORE_END.length;
      next = old.slice(0, a) + block + old.slice(b);
    } else {
      next = `${block}\n\n${old}`;
    }
    if (next === old) return out;
    if (old && !fsMod.existsSync(file + ".bak-persona")) fsMod.writeFileSync(file + ".bak-persona", old, "utf8");
    fsMod.writeFileSync(file, next, "utf8");
    out.changed = true;
    return out;
  } catch (e) { out.error = String(e?.message || e).slice(0, 100); return out; }
}

/** 把一个定义同步到所有端的文件；只报结果，不猜 */
export function syncAllSurfaces(def, { wsRoot = "", fsMod = fs } = {}) {
  const surfaces = loadSurfaces(wsRoot, fsMod);
  const results = [];
  for (const [id, s] of Object.entries(surfaces)) {
    for (const f of s.files || []) results.push({ surface: id, ...syncSurfaceFile(def, { ...s, name: s.name || def.name }, f, fsMod) });
  }
  return results;
}
