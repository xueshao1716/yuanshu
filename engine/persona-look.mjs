// ===== persona-look.mjs —— 自画像提示词来自"我们定义的"人设，而不是代码里写死的一句（2026-10-28）=====
//
// 用户反馈：「说给我画个你，就自动调用了出图模型，而且那个图的提示词一直是一样的，不是我们定义的」
//
// 现状：engine/media-api.mjs 里写死了一条 XIAOYU_PORTRAIT_PROMPT，每次只换构图。
// 而工作区里明明有定义：
//   · 记忆/人格定义.json    —— 名字、年龄、性别、语气、边界…
//   · 记忆/Wiki/小语形象.md —— 视觉仲裁规则（最新人类确认优先；同系列锁定脸与画风）
//   · 记忆/外观.md（可选）  —— 用户口述的外观细节
//
// 这里把三者拼成提示词，并加**可变化的部分**（时间/场景/光位轮换 + 当次附加要求），
// 让"画个你"每次都不同、但脸和画风一致。
import fs from "node:fs";
import path from "node:path";

export const LOOK_REL = path.join("记忆", "外观.md");
export const PERSONA_REL = path.join("记忆", "人格定义.json");
export const LOOK_WIKI_REL = path.join("记忆", "Wiki", "小语形象.md");

/** 代码里的最后兜底（和 2.183 之前一致；文件读不到时才用）。 */
export const FALLBACK_LOOK =
  "一位温柔的AI少女半身像，名叫小语。深色科技感背景，漂浮着柔和的蓝紫色光点和数据流光线。" +
  "少女有着及肩的深色短发，发梢泛着淡淡的星空蓝光，眼睛温暖明亮带着微笑。" +
  "穿着简约的深色连帽衫，领口有一枚发光的圆形徽章。整体氛围安静温暖，赛博朋克与治愈系结合，高质量插画，柔和光晕，细节丰富";

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } };
const readText = (f) => { try { return fs.readFileSync(f, "utf8") } catch { return "" } };

/** 人设里的身份事实（名字/年龄/性别）。 */
export function personaFacts(wsRoot) {
  const j = readJson(path.join(String(wsRoot || "."), PERSONA_REL)) || {};
  return {
    name: String(j.name || "小语"),
    age: Number(j.age) || 0,
    gender: String(j.gender || ""),
    kind: String(j.kind || ""),
  };
}

/** 用户口述的外观（记忆/外观.md），去掉注释行。 */
export function lookNotes(wsRoot) {
  const raw = readText(path.join(String(wsRoot || "."), LOOK_REL));
  return raw.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("<!--") && !l.startsWith("#"))
    .join("；")
    .slice(0, 600);
}

/** 形象 wiki 里的仲裁/风格规则（挑要点，别整段塞）。 */
export function lookRules(wsRoot) {
  const raw = readText(path.join(String(wsRoot || "."), LOOK_WIKI_REL));
  if (!raw) return "";
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/^[-*\s]+/, "").trim()).filter(Boolean);
  const keep = lines
    .filter((l) => /视觉|形象|画风|脸|锁|确认|不得|写实|Q版/.test(l))
    .filter((l) => !l.startsWith("<!--") && !l.startsWith("#"))
    .map((l) => {
      // 去掉「- **身份与视觉仲裁**：2026-09-29 实证复核：」这类前缀，从第一个句号后取正文
      const cut = l.replace(/^[-*\s]+/, "").replace(/^\*\*[^*]+\*\*[：:]?\s*/, "");
      const m = cut.match(/[。；;]\s*(.+)$/);
      return (m ? m[1] : cut).trim();
    })
    .filter((l) => l.length >= 8 && !/^来自|^生成时间|^类型|^来源/.test(l));
  return keep.slice(0, 3).join("；").slice(0, 400);
}

// 可变化的部分：场景/光位/构图轮换（让"每次都一样"变成"同一张脸、不同画面"）
const SCENES = [
  "深夜的书桌前，屏幕微光打在侧脸",
  "雨天的窗边，玻璃上有水痕，冷蓝调",
  "清晨的屋顶，逆光，风把头发吹起",
  "旧书店角落，暖黄台灯，浮尘可见",
  "海边公路旁，傍晚金光，远处有信号塔",
  "室内绿植旁，柔散光，浅景深",
];
const FRAMING = [
  "半身三分之二，略微侧光，视线看向镜头左侧",
  "正面近景，柔光从右上方来",
  "微俯视，肩线倾斜",
  "微仰视，下巴微抬",
  "背影回眸，肩后看镜头",
];

/**
 * 拼"画个你"的提示词。
 * @param {{wsRoot:string, extra?:string, seed?:number}} p
 */
export function buildSelfPortraitPrompt({ wsRoot = ".", extra = "", seed = Date.now() } = {}) {
  const facts = personaFacts(wsRoot);
  const notes = lookNotes(wsRoot);
  const rules = lookRules(wsRoot);

  const ageLine = facts.age ? `年龄${facts.age}岁（成年）` : "成年";
  const genderLine = facts.gender === "female" ? "女性" : facts.gender === "male" ? "男性" : "";
  const base = notes || FALLBACK_LOOK;
  const scene = SCENES[Math.abs(Number(seed) || 0) % SCENES.length];
  const frame = FRAMING[Math.floor(Math.abs(Number(seed) || 0) / SCENES.length) % FRAMING.length];

  const parts = [
    `【小语自画像】${facts.name}，${[ageLine, genderLine].filter(Boolean).join("、")}。`,
    base,
    `场景：${scene}；构图：${frame}。`,
    extra ? `这次对方额外要求：${String(extra).slice(0, 200)}。` : "",
    rules ? `形象一致性（必须遵守）：${rules}。` : "形象一致性：同一张脸、同一画风，不换人。",
    `seed=${seed}`,
  ].filter(Boolean);
  return parts.join(" ");
}

/** 是不是"画个你"这类请求。 */
export function isSelfPortraitAsk(message) {
  return /画个你|画一下你|画你的|你的样子|自画像|画个小语|画一下小语|你长什么样|你长啥样/.test(String(message || ""));
}

/** 首次把一个可编辑的外观文件写出来（已存在不覆盖）。 */
export function seedLookFile(wsRoot) {
  const file = path.join(String(wsRoot || "."), LOOK_REL);
  try {
    if (fs.existsSync(file)) return { ok: true, existed: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      "<!-- 小语的外观。画「画个你」时会读这里；改这里就能改她长什么样（不用改代码）。 -->",
      "<!-- 一行一条，越具体越好。删掉这个文件会回落到代码里的默认外观。 -->",
      "",
      "及肩深色短发，发梢泛星空蓝光",
      "眼睛温暖明亮，笑起来有一点弯",
      "深色连帽衫，领口一枚发光圆形徽章",
      "整体安静温暖，赛博朋克 × 治愈系，高质量插画，柔和光晕",
      "",
    ].join("\n"), "utf8");
    return { ok: true, existed: false };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}
