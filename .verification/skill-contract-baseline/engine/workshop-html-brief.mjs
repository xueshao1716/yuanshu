// 工坊 HTML 设计稿 brief：范围/结构/材质/动词/技术栈/验收。整套只准一个动词。
const VERB_RULES = [
  [/揭|剥|层|底下|岩/, "揭示"],
  [/绽|花瓣|盛开/, "绽放"],
  [/透镜|观察|窥|隐藏/, "观察"],
  [/穿越|穿过|飞过/, "穿越"],
  [/对照|对比|复盘|前后/, "对照"],
  [/递进|路径|路线|步骤/, "递进"],
];

const MATERIAL = {
  navy: "深蓝纸面、克制几何，accent 少而硬",
  magazine: "暖纸、衬线对比、杂志留白",
  dark: "暗底、少量亮色、科技几何",
  riso: "单色油墨肌理、大色块",
};

export function inferVerb(idea) {
  const s = String(idea || "");
  for (const [re, verb] of VERB_RULES) if (re.test(s)) return verb;
  return "对照";
}

function clipVerb(raw, idea) {
  const v = String(raw || "").trim().replace(/\s+/g, "");
  if (/^[\u4e00-\u9fffA-Za-z]{2,8}$/.test(v)) return v;
  return inferVerb(idea);
}

export function fillHtmlBrief({ theme = "", audience = "", pages = 8, themeKey = "navy", verb = "", fields = {} } = {}) {
  const idea = String(theme || fields.theme || "").trim() || "主题汇报";
  const n = Math.min(Math.max(parseInt(pages, 10) || 8, 3), 20);
  const key = MATERIAL[themeKey] ? themeKey : "navy";
  const v = clipVerb(verb || fields.verb, idea);
  const who = String(audience || fields.audience || "").trim();
  return {
    scope: String(fields.scope || "").trim() || `一套 ${n} 页左右的 1280×720 HTML 设计稿，不是整站、不是聊天壳`,
    structure: String(fields.structure || "").trim()
      || `封面先把「${v}」做出来；内页按标题 / 要点 / 行动口排，视线被这个动词带走${who ? `；给「${who}」看` : ""}`,
    material: String(fields.material || "").trim() || MATERIAL[key],
    verb: v,
    stack: String(fields.stack || "").trim()
      || "自包含 HTML，零 CDN、零外链字体与图片。禁止 React / Tailwind / Inter 外链。字体用 system-ui、PingFang SC、Microsoft YaHei",
    accept: String(fields.accept || "").trim()
      || `封面 3 秒内能看出「${v}」；内页动作服务同一动词；硬质检零外链；每页一个焦点`,
  };
}

export function formatHtmlBriefBlock(brief) {
  const b = brief && brief.verb ? brief : fillHtmlBrief(brief || {});
  return [
    "六项 brief（必须执行，整套只准一个动词）：",
    `- 范围：${b.scope}`,
    `- 结构：${b.structure}`,
    `- 材质：${b.material}`,
    `- 动词：${b.verb}`,
    `- 技术栈：${b.stack}`,
    `- 验收：${b.accept}`,
  ].join("\n");
}

export function lintDeckBrief(deck) {
  const verb = String(deck?.verb || "").trim();
  if (!/^[\u4e00-\u9fffA-Za-z]{2,8}$/.test(verb)) {
    return [{ rule: "verb", severity: "warn", msg: "deck.json 缺少 2–8 字动词（整套一个动作）" }];
  }
  return [];
}
