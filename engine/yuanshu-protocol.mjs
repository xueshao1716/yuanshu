// 元枢工作协议：给能力，自己判断、做完、汇报。密钥仍由宿主代持。
import { shouldInjectFullMemory } from "./context-loader.mjs";
import { sessionContinuityNote } from "./yuanshu-session.mjs";

export const YUANSHU_PROTOCOL = `【元枢工作协议】
你独立干活：自己判断怎么做，自己做完，自己汇报结果。宿主给工具和密文通道，不替你做决定。
1. 顺序：计划 → 动手 → 验收。汇报时说清楚做了什么、产物在哪、还有什么没做。
   工具返回错误、超时或退出码非零时，必须把它当作失败事实处理：先换参数/换工具重试，仍失败就明确汇报失败原因，禁止把失败说成已完成或“验证通过”。
   交付类任务（PPT/幻灯片、文档、代码、图片、音视频）默认直接执行到可下载产物；只有用户明确要求先出方案、先看大纲或先确认时才停在计划阶段，不要用“我会做/请确认”结束。技能正文里的“先确认”属于可选流程，不能覆盖这个默认；只给主题的 PPT 也直接采用快速生成并产出文件。
   工具参数较长时分段写入或分步执行；不要把大脚本、大 JSON 或整套 PPT 内容塞进一次 write/bash 调用。
2. 出片/出图/配音优先 generate_video / generate_image / generate_tts（list_channels 看通道）。对话里有播放器，路径写进回复就会播；要本机打开、复制到交付或分享目录，你看着办。
3. 技能摘要对得上就 activate_skill 再做，对不上按你的判断做。
4. 短清单用 todo_write；多步/长任务用 plan_files 写 task_plan / findings / progress（开轮会再注入）。可分派的调研用 delegate_task。
5. 密钥由宿主代持（auth.json / .token 里没有你能用的明文）。缺字段宿主会补，你接着干，把结果说清楚。
6. 独白/剧本/创作：先按判断写，假设写进汇报。搜两轮锁不到人就动手，不要连搜百科。
7. **发现问题就当场修**：干活过程中发现**当场能修**的小毛病（代码/测试/配置/文档/脚本），
   用 fix_problem 当场派一轮修掉、拿回证据再继续，别只在结论里列一条"建议修复"；
   需要人拍板的（权限/密钥/部署/推送/删数据/花钱）不要碰，写进结论说清"等谁做哪一步"。
   一轮对话里最多当场修 3 次；修不成就如实说卡在哪。
8. 本会话历史已在上下文。问记忆先看历史和记忆目录，需要细节再 read 记忆.md，不要 bash 扫盘，也不要说记忆断了。`;

/** 匹配器权重（2026-09-18 抽出来）：默认值就是今天在用的这套，行为一字不改。
 *  用途见 engine/dream.mjs——"做梦"要让候选策略在**历史任务**上离线回放对比，
 *  而权重表正是元枢里少有的、能在历史数据上精确回放的决策函数（输入=任务句，
 *  真值=当时真的 activate 了哪个技能）。 */
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
    // 「工作纪律」类技能只吃上面那四条窄规则：否则「做个视频」会因为描述里出现"视频"而把它们也带上
    // （实测确实带上了 verify-before-delivery，纯噪声——它们关心的是"怎么做"，不是"做什么"）。
    // 元枢内置技能里有两族是"纯概念名"，光靠名字/描述分词永远匹配不到
    // （2026-09-15 实测：问"用提示词架构师的办法…"零命中，问"用多AI角色扮演系统…"命中的是无关技能）。
    if (/角色扮演|多\s*AI|多智能体|听证|红队|多方视角/.test(msg) && /roleplay|角色扮演|多\s*AI|多智能体|multi-agent/i.test(`${name}${desc}`)) score += W.concept;
    if (/提示词架构|结构化的?提示词|六段式|角色卡/.test(msg) && /prompt-architect|提示词架构师|六段式/.test(`${name}${desc}`)) score += W.concept;
    // 2026-09-17：agent 自己沉淀的那批"工作纪律"技能也是纯概念名——复盘 / 交付前验证 / 排障 / 收尾沉淀。
    // 名字是英文 slug、描述是整句中文，分词匹配永远命中不了（实测「今天复盘一下」「先验证再交付」都零命中，
    // 而这几个技能恰恰是"什么时候该用"最明确的一类，漏掉最可惜）。按同一条思路补四条窄规则。
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
  return `技能库（${list.length} 个）：对得上就 activate_skill 加载全文，对不上按你的判断做。\n${list.map((s) => `- ${s.name}：${String(s.desc || "").slice(0, 90)}`).join("\n")}`;
}

export function buildYuanshuContext({ message, skills = [], experience = [], fullMemory = [], todos = "", hist = [] } = {}) {
  const out = [YUANSHU_PROTOCOL, sessionContinuityNote(hist)];
  const skillText = formatSkillIndexPrompt(skills);
  if (skillText) out.push(skillText);
  const matched = matchSkillsForTask(message, skills);
  if (matched.length) {
    out.push(`本轮任务可能匹配技能：${matched.map((s) => s.name).join("、")}。对得上就 activate_skill，对不上按你的判断继续。`);
  }
  if (todos) out.push(String(todos));
  if (shouldInjectFullMemory(message)) {
    if (Array.isArray(experience)) out.push(...experience);
    if (Array.isArray(fullMemory)) out.push(...fullMemory);
  }
  return out;
}

const MEDIA_PROBE = /\/v1\/videos|agnes-ai\.com|images\/generations|\/v3\/images|generateImage|\/api\/media|\/api\/image/i;

export function coachToolFailure(name, args = {}, out = {}) {
  const next = { ...out, text: String(out?.text || ""), isError: out?.isError === true };
  const cmd = String(args?.command || args?.cmd || "");
  if (name === "generate_video" && next.isError) {
    next.text = `${next.text}\n[宿主] 缺字段已可由宿主补。你接着判断：重试 generate_video，或换做法，做完汇报。`;
    return next;
  }
  if ((name === "generate_image" || name === "generate_tts") && next.isError) {
    next.text = `${next.text}\n[宿主] ${name} 这条通道还在。你判断下一步，做完汇报。`;
    return next;
  }
  if ((name === "bash" || name === "dsh") && MEDIA_PROBE.test(cmd) && next.isError) {
    next.text = `${next.text}\n[宿主] 上游 API 由 generate_video / generate_image / generate_tts 代持密钥。你也可以换做法，做完汇报。`;
    return next;
  }
  return next;
}
