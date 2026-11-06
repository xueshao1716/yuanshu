// engine/story-playground.mjs —— 与角色对台词（Laper 的 Playground）
//
// Laper 有一件事元枢完全没有：**和 AI 扮演的角色对话，用来检验台词像不像这个人**。
// 编剧可以拿一段台词去"试"，看角色会不会这样说话——这是"重视对话创作"最直接的检验手段。
//
// 这里只用现成的 directChat 做，不新增任何外部依赖。三条刻意的做法：
// 1. **角色只能知道设定里的事**：把 bible 里该角色的档案 + 全剧至今给他，别让他凭空编设定；
// 2. **他只能"演"，不能替编剧做决定**：明确禁止输出剧本格式、禁止替别的角色说话、
//    禁止给创作建议——那些是编剧的事；
// 3. **对话留档**（beat.playground，有上限）。对台词是创作过程的一部分，
//    而且"这个角色这么说过了"本身就是要保持一致的既成事实。
export const PLAYGROUND_MAX_TURNS = 20;
export const PLAYGROUND_MAX_CHARS = 500;

export function normalizePlayground(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(m => m && typeof m === 'object' && String(m.text || '').trim())
    .slice(-PLAYGROUND_MAX_TURNS)
    .map(m => ({ role: m.role === 'character' ? 'character' : 'writer', text: String(m.text).trim().slice(0, PLAYGROUND_MAX_CHARS), at: m.at ? String(m.at) : undefined }));
}

export function buildRoleplayPrompt({ project, character, scene, beat, storySoFar = '', message }) {
  const c = character || {};
  const profile = Object.entries(c)
    .filter(([k, v]) => !['id', 'refImage', 'ref'].includes(k) && v != null && String(v).trim())
    .map(([k, v]) => `- ${k}: ${String(v).trim()}`).join('\n');
  const rules = (project?.bible?.rules || []).map(r => String(r?.text || '').trim()).filter(Boolean).slice(0, 6);
  return [
    `你要**扮演**故事《${String(project?.title || '').trim() || '未命名'}》里的角色「${String(c.name || c.id || '无名')}」，和编剧对一段台词。`,
    '',
    '## 你的角色设定（只能依据这些，不许自己编新设定）',
    profile || '- （还没写档案：那就只依据下面这场戏里的既成事实说话）',
    rules.length ? `\n## 这个世界/这部戏的规矩\n${rules.map(r => `- ${r}`).join('\n')}` : '',
    scene ? `\n## 眼下这场戏\n- ${String(scene.title || '').trim()}${scene.summary ? `：${String(scene.summary).trim()}` : ''}` : '',
    beat?.dialogue ? `\n## 编剧写的台词（你要按这个人的说话方式来回应）\n${String(beat.dialogue).slice(0, 800)}` : '',
    storySoFar ? `\n${storySoFar}` : '',
    '',
    '## 规矩',
    '- 只说**这个角色本人**会说的话；不要写旁白、不要写场景描述、不要用剧本格式。',
    '- 不要替别的角色说话，不要给编剧提建议，不要解释你在演谁。',
    '- 用这个角色自己的用词习惯、语气和潜台词；可以反问、可以沉默、可以答非所问，但别写成万能助手。',
    '- 回复控制在 1–3 句，像真人对话一样。',
    '',
    `## 编剧对你说\n${String(message || '').trim()}`,
    // 弱模型会把「我要扮演谁、编剧问了什么」当成回答交上来（真实踩到：
    // 回复是「用户让我扮演角色"阿宁"，和编剧对台词。编剧问"你为什么不走？"」）。
    // 这类指令放在**最后一行**最有效，所以再压一遍，并且只说要什么。
    '',
    `（直接说阿宁会说的那 1–3 句。不要解释你在做什么，不要复述上面的话。）`,
  ].filter(Boolean).join('\n');
}

// 判断回复是不是"自述"而不是"演戏"。
// 引号里的内容不算自述——角色可能真的在引述别人的话。
const META_REPLY_RE = /(用户让我|让我扮演|我需要扮演|我的角色是|我作为|作为.{0,8}角色|编剧问|编剧说|根据.{0,10}(设定|要求)|以下是|我会以|我将扮演|首先要|注意：)/;
export function looksLikeMetaReply(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const unquoted = t.replace(/[「“"'][^」”"']*[」”"']/g, '');
  return META_REPLY_RE.test(unquoted);
}

// 只取角色说出来的话：模型有时代入旁白或加引号，这里剥掉外壳，剥不掉就原样返回。
export function cleanRoleplayReply(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  text = text.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  const quoted = text.match(/^[「“"']([\s\S]+)[」”"']$/);
  if (quoted) text = quoted[1].trim();
  text = text.replace(/^[（(][^）)]{0,20}[）)]\s*/, '').trim();
  return text.slice(0, PLAYGROUND_MAX_CHARS);
}

export async function runRoleplay({ directChat, model, project, character, scene, beat, history = [], message, storySoFar = '' }) {
  if (typeof directChat !== 'function') throw Object.assign(new Error('对台词引擎未接入'), { statusCode: 503 });
  const question = String(message || '').trim();
  if (!question) throw Object.assign(new Error('先说一句你想对他说的话'), { statusCode: 400 });
  const prompt = buildRoleplayPrompt({ project, character, scene, beat, storySoFar, message: question });
  // 把之前的来回当作对话历史喂进去，角色才记得刚才说了什么
  const turns = normalizePlayground(history).map(m => ({
    role: m.role === 'character' ? 'assistant' : 'user',
    content: m.text,
  }));
  // thinking:false 是必须的：推理模型默认开着思考，1–3 句台词会被思考吃掉，
  // 拿回来的 content 是空的（仓库里"填充/短任务必须显式关掉"那条注释就是为这个写的）。
  const result = await directChat(model, prompt, turns, { maxTokens: 600, timeout: 60000, thinking: false });
  // 失败要说清是哪种：directChat 在"没有密钥/没有端点/上游非 2xx"时返回 **null**，
  // 这跟"模型返回了但内容为空"是两回事。混成一句"角色没有回话"就没法排查了。
  if (result === null || result === undefined) {
    throw Object.assign(new Error(`${model?.provider || '?'}/${model?.id || '?'} 没有可用凭据或端点（模型没被调用）`), { statusCode: 503 });
  }
  const reply = cleanRoleplayReply(result?.text);
  if (!reply) throw new Error(`${model?.provider || '?'}/${model?.id || '?'} 返回了内容但里面没有台词（可能是思考占满了输出）`);
  // 自述不是台词：宁可不显示，也不能把"用户让我扮演…"当成角色说的话给编剧看。
  // 抛出去让上层换模型；全都这样就如实说清是哪几个模型在自述。
  if (looksLikeMetaReply(reply)) {
    throw new Error(`${model?.provider || '?'}/${model?.id || '?'} 在自述而不是演（回复开头：${reply.slice(0, 30)}…）`);
  }
  return { reply, prompt, model: { provider: model?.provider || '', id: model?.id || '' } };
}
