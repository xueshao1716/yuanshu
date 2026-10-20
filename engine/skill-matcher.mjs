// engine/skill-matcher.mjs —— 技能匹配与技能索引格式（2026-10-20）
//
// 从 yuanshu-protocol.mjs 拆出来：那个文件原来同时装着「提示词文本 + 匹配算法 +
// 索引格式 + 上下文构建 + 工具失败教练」五件事，改一句提示词得动整个模块。
// 这里只放匹配算法与索引格式，提示词文本留在 harness 组件里。

/** 匹配器权重（2026-09-18 抽出）：默认值就是今天在用的这套，行为一字不改。 */
export const MATCH_WEIGHTS = Object.freeze({
  nameHit: 5, nameToken: 2, descToken: 2,
  video: 4, image: 3, ppt: 4, novel: 3, concept: 6,
  discipline: { retro: 6, verify: 5, diag: 5, settle: 5 },
});

export function matchSkillsForTask(message, skills = [], limit = 3, weights = MATCH_WEIGHTS) {
  const W = { ...MATCH_WEIGHTS, ...(weights || {}), discipline: { ...MATCH_WEIGHTS.discipline, ...(weights?.discipline || {}) } };
  const msg = String(message || "");
  if (!msg.trim() || msg.length < 2 || /^(嗯|好|哦|哈|啊|继续|谢谢)$/.test(msg.trim())) return [];
  const scored = [];
  for (const s of skills || []) {
    const name = String(s.name || "");
    const desc = String(s.desc || "");
    let score = 0;
    if (msg.includes(name)) score += W.nameHit;
    for (const tok of name.split(/[-_]/)) {
      if (tok.length >= 4 && msg.toLowerCase().includes(tok.toLowerCase())) score += W.nameToken;
    }
    for (const tok of desc.split(/[\s,，、/]/)) {
      if (tok.length >= 2 && msg.includes(tok)) score += W.descToken;
    }
    const isDiscipline = /retrospective|closeout|verify-before-delivery|misleading-error/.test(name);
    if (!isDiscipline && /视频|分镜|出片|短片/.test(msg) && /video|视频|seedance|aigc|分镜/.test(`${name}${desc}`)) score += W.video;
    if (!isDiscipline && /图|海报|写真|配图/.test(msg) && /image|图|写真|海报|wanxiang/.test(`${name}${desc}`)) score += W.image;
    if (!isDiscipline && /ppt|幻灯片|演示|汇报/i.test(msg) && /ppt|幻灯片|演示|presentation/i.test(`${name}${desc}`)) score += W.ppt;
    if (!isDiscipline && /小说|连载|故事/.test(msg) && /novel|小说|forge/.test(`${name}${desc}`)) score += W.novel;
    // 「工作纪律」类技能只吃上面那四条窄规则：否则「做个视频」会因为描述里出现"视频"而把它们也带上。
    if (/角色扮演|多\s*AI|多智能体|听证|红队|多方视角/.test(msg) && /roleplay|角色扮演|多\s*AI|多智能体|multi-agent/i.test(`${name}${desc}`)) score += W.concept;
    if (/提示词架构|结构化的?提示词|六段式|角色卡/.test(msg) && /prompt-architect|提示词架构师|六段式/.test(`${name}${desc}`)) score += W.concept;
    if (/复盘|回顾今天|总结今天|今日总结/.test(msg) && /retrospective|复盘/.test(`${name}${desc}`)) score += W.discipline.retro;
    if (/验证|实测|证据|先跑一遍|真的能用|别忽悠|别吹/.test(msg) && /verify-before-delivery|验证|证据/.test(`${name}${desc}`)) score += W.discipline.verify;
    if (/排障|排查|报错|起不来|错误信息|误导/.test(msg) && /misleading-error|排障|错误信息/.test(`${name}${desc}`)) score += W.discipline.diag;
    if (/沉淀|收尾|漏了什么|登记产物|经验没留/.test(msg) && /closeout|沉淀|收尾/.test(`${name}${desc}`)) score += W.discipline.settle;
    if (score) scored.push({ name, desc, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function formatSkillIndexPrompt(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const header = `技能库（${list.length} 个）：对得上就 activate_skill 加载全文，对不上按你的判断做。\n`;
  const rows = list.map(s => {
    const desc = String(s.desc || "");
    const trigger = desc.search(/当用户|当需要|\buse (?:when|this|for)\b/i);
    return { prefix: `- ${s.name}：`, desc: trigger > 0 ? `${desc.slice(trigger)}；${desc.slice(0, trigger)}` : desc };
  });
  // Preserve every activatable name as local skills grow; shorten summaries, not the catalog.
  const available = Math.max(0, 3999 - header.length - rows.reduce((n, s) => n + s.prefix.length, 0) - (rows.length - 1));
  let limit = 90;
  while (limit > 0 && rows.reduce((n, s) => n + Math.min(s.desc.length, limit), 0) > available) limit--;
  return header + rows.map(s => s.prefix + s.desc.slice(0, limit)).join("\n");
}
