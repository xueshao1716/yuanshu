// The visual companion is rendered by the frontend, but its semantic description
// is a runtime fact that can be safely shared with the companion model.
export const COMPANION_APPEARANCE = Object.freeze({
  neutral: Object.freeze({ label: '静候', asset: 'yuanshu-listening-v1.webp', description: '真人女性形象，面向前方，安静地陪伴与等待。' }),
  working: Object.freeze({ label: '工作中', asset: 'yuanshu-working-v1.webp', description: '真人女性形象，坐在桌前专注看屏幕，处于工作姿态。' }),
  reading: Object.freeze({ label: '阅读中', asset: 'yuanshu-reading-v1.webp', description: '真人女性形象，手持书本并低头阅读，处于阅读姿态。' }),
  resting: Object.freeze({ label: '休息中', asset: 'yuanshu-resting-v1.webp', description: '真人女性形象，姿态放松，像是在短暂休息。' }),
  daydreaming: Object.freeze({ label: '放空中', asset: 'yuanshu-daydreaming-v1.webp', description: '真人女性形象，视线游离、神情放空，处于发呆姿态。' }),
  listening: Object.freeze({ label: '倾听中', asset: 'yuanshu-listening-v1.webp', description: '真人女性形象，面向用户，安静倾听。' }),
  responding: Object.freeze({ label: '回应中', asset: 'yuanshu-responding-v1.webp', description: '真人女性形象，面向用户，正在回应。' }),
  // 2026-10-19 待机小动作：同角色同场景出图（agnes-image-2.5-flash）
  wave: Object.freeze({ label: '挥手', asset: 'yuanshu-wave-v1.png', description: '真人女性形象，面向镜头抬手打招呼，自然地笑。' }),
  stretch: Object.freeze({ label: '伸懒腰', asset: 'yuanshu-stretch-v1.png', description: '真人女性形象，双臂上举伸懒腰，神情放松。' }),
  lookaround: Object.freeze({ label: '东张西望', asset: 'yuanshu-lookaround-v1.png', description: '真人女性形象，身体侧转、视线看向一侧，像在张望。' }),
});

// Stable identity prompt for the real-person companion. This is descriptive
// context for the model, not an instruction to generate an image on its own.
export const COMPANION_IDENTITY_PROMPT = `成年虚构东亚女性真人形象，二十多岁，身材自然匀称；腰下超长直黑发，厚直刘海，冷静而温和的自然表情，真实皮肤纹理，不是动漫、卡通或CG。身份锚点是同一张脸、同样的发型、年龄感、体态比例与真人摄影质感，不是固定某一套衣服。服装可随场景自然变化，例如简洁日常服、JK风格制服、百褶短裙搭配上衣、休闲家居服或工作服；保持明确的成年人外观与自然日常穿搭，短裙、短袖等正常露肤可以，不做色情化呈现。基准画面可使用极简现代黑色楼梯与白墙、冷白自然窗光和柔和正面补光，纪实编辑时尚摄影，保留环境留白和真实材质。禁止塑料磨皮、夸张性感姿势、私密部位裸露、额外肢体、文字和水印。工作中、阅读中、休息中等状态只改变姿态、视线、场景和服装，不改变这个人的身份与基础外观。`;

export function appearanceFor(action = 'neutral') {
  return COMPANION_APPEARANCE[action] || COMPANION_APPEARANCE.neutral;
}

/**
 * 用「人格定义」里的形象四项拼出图母提示词（2026-11-07）。
 *
 * 为什么要有：原来的 COMPANION_IDENTITY_PROMPT 是硬编码的（腰下超长直黑发、厚直刘海…），
 * 和 记忆/人格定义.json 里的形象描述是两套东西——改了定义，出图还是老样子，这就是"没有闭环"。
 * 现在定义里有哪几项就用哪几项，并保留不可协商的风格/安全约束；四项都没有才退回原常量。
 */
export function buildIdentityPrompt(def = {}) {
  const d = def || {};
  const pick = (k) => String(d[k] || "").trim();
  const appearance = pick("appearance");
  const hairstyle = pick("hairstyle");
  const clothing = pick("clothing");
  const scenario = pick("scenarioOutfits");
  if (!appearance && !hairstyle && !clothing && !scenario) return COMPANION_IDENTITY_PROMPT;
  const facts = [];
  if (appearance) facts.push(`人物外貌：${appearance}`);
  if (hairstyle) facts.push(`发型与发色：${hairstyle}`);
  if (clothing) facts.push(`日常服装：${clothing}`);
  if (scenario) facts.push(`场景穿搭：${scenario}`);
  return [
    "成年虚构东亚女性真人形象，真实皮肤纹理，不是动漫、卡通或CG。",
    facts.join("；"),
    "。身份锚点是同一张脸、同样的发型、年龄感、体态比例与真人摄影质感；服装随场景自然变化，保持成年人外观与自然日常穿搭，不做色情化呈现。",
    "基准画面：冷白自然窗光与柔和正面补光，纪实编辑时尚摄影，保留环境留白与真实材质。",
    "禁止塑料磨皮、夸张性感姿势、私密部位裸露、额外肢体、文字和水印。",
    "工作中、阅读中、休息中等状态只改变姿态、视线、场景和服装，不改变这个人的身份与基础外观。",
  ].join("");
}

export function appearanceCatalog() {
  return Object.fromEntries(Object.entries(COMPANION_APPEARANCE).map(([action, value]) => [action, { ...value }]));
}

// ── 常驻形象事实（2026-11-08：前台每条消息都要知道"她现在长什么样"）────────────
// 以前只有消息命中「公仔|立绘|形象|长什么样|外观|姿态」才注入形象；
// 普通轮次里模型没有任何外貌事实，于是 人格定义.json 里改了外貌，对话里始终听不到新形象。
// 这里从形象四项压出一句 ≤60 字的常驻事实（每轮都发），关键词命中时再叠完整块。
export const APPEARANCE_FACT_PREFIX = "【形象】";
export const APPEARANCE_FACT_LIMIT = 60; // 含前缀的总字数上限：常驻的东西必须够短，不然每轮都在烧上下文
export const APPEARANCE_KEYWORDS = /(公仔|立绘|形象|长什么样|外观|姿态)/;

// 精简版不要括号里的补充说明（"不是暖棕""低饱和的蓝"这类），也不要"日常主穿搭："这种标签
function cleanFactText(value) {
  return String(value || "")
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/(日常主穿搭|日常服装|主穿搭|日常)\s*[：:]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 只取第一句：定义里每一项都是"一句主描述 + 若干补充"，补充留给完整块
function firstSentence(value) {
  return cleanFactText(value).split(/[。\n]/)[0].trim();
}

// 按短句边界取，绝不切半句：第一句就超预算就整项略过（宁可少一项，也不要"雾蓝灰连"这种断词）
function takeClauses(text, budget) {
  const segs = String(text || "").split(/(?<=[，,、；;])/).filter(Boolean);
  let out = "";
  for (const seg of segs) {
    if (!out && seg.length > budget) return "";
    if ((out + seg).length > budget) break;
    out += seg;
  }
  return out.replace(/[，,、；;]\s*$/, "").trim();
}

// 场景穿搭在精简版里只保留"按场景换装"这套事实与场景名，具体单品留给完整块
// （"工作：同一件卫衣…"这种整句塞进常驻事实只会变成噪音）
function scenarioScenes(value) {
  const labels = String(value || "")
    .split(/[\n。]/)
    .map((line) => (line.match(/^([^：:]{1,6})[：:]/) || [])[1])
    .filter(Boolean);
  return labels.length ? `按场景换装（${labels.join("/")}）` : "";
}

/**
 * 形象四项 → 一句精简事实（≤60 字）。取不到就返回空串（调用方不注入，不写"未知"）。
 * 例：`【形象】20 岁上下的中国女生；齐耳短发，深棕近黑；宽松的雾蓝灰连帽卫衣；按场景换装（工作/阅读/休息/外出）。`
 */
export function buildAppearanceFact(def = {}) {
  const d = def || {};
  const parts = [
    takeClauses(firstSentence(d.appearance), 12),
    takeClauses(firstSentence(d.hairstyle), 12),
    takeClauses(firstSentence(d.clothing), 12),
    scenarioScenes(d.scenarioOutfits),
  ].filter(Boolean);
  if (!parts.length) return "";
  const room = APPEARANCE_FACT_LIMIT - APPEARANCE_FACT_PREFIX.length - 1; // 留一个句号的位置
  let body = parts.join("；");
  if (body.length > room) body = body.slice(0, room).replace(/[，,、；;]$/, "");
  return `${APPEARANCE_FACT_PREFIX}${body}。`;
}

/**
 * 本轮要注入的形象上下文（纯函数，聊天链路与测试共用同一份判断）。
 * @returns {{fact: string, full: string}} fact=常驻精简事实（任何消息都有）；full=命中关键词时的完整块
 */
export function planAppearanceInjection(message, def = {}, { catalog = COMPANION_APPEARANCE, identityPrompt = "" } = {}) {
  const fact = buildAppearanceFact(def);
  const hit = APPEARANCE_KEYWORDS.test(String(message || ""));
  let full = "";
  if (hit) {
    const lines = Object.entries(catalog).map(([action, item]) => `${item.label}（${action}）：${item.description}`).join("；");
    const prompt = identityPrompt || buildIdentityPrompt(def);
    full = `【公仔形象事实】你不能直接看见图片，不要声称看到了图片。当前前端使用真人立绘，并按实时动作在这些外观之间切换：${lines}。这套真人形象的母提示词是：${prompt}。如果用户问“你自己的公仔长什么样”或“提示词是什么”，可以用自然语言概括这份母提示词；不要编造衣着、发型、背景等未提供细节。无法确定此刻动作时，明确说当前动作由界面实时状态决定。`;
  }
  return { fact, full };
}
