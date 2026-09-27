// output-inspector.mjs —— AI 输出质检员（2026-08-21）
// 用户理念落地：规则初筛命中异常（复读/空/纯思考/灰色地带）后，用 LLM 检测员做语义级复核，
// 生成针对性修正话语注入模型（同模型修正方向）。规则永远是兜底（检测员挂了/超时不影响主流程）。
// 成本控制：只在规则命中异常时才调检测员（正常输出零开销）；检测员用小模型（免费 flash-lite）。
let _directChat = null;
let _getInspectorModel = null; // () => model | null

export function initOutputInspector({ directChat = null, getInspectorModel = null } = {}) {
  if (directChat) _directChat = directChat;
  if (getInspectorModel) _getInspectorModel = getInspectorModel;
}

/**
 * 检测员复核一次异常输出。
 * @returns {{verdict:'repeat'|'evasive'|'off_topic'|'ok', suggestion:string}|null} 失败返回 null（走规则兜底）
 */
export async function inspectOutput({ userMessage = "", output = "", history = [] } = {}) {
  if (!_directChat || !_getInspectorModel) return null;
  const m = _getInspectorModel();
  if (!m) return null;
  const hist = (history || []).slice(-4).map((h) => `[${h.role || "?"}] ${String(h.content || h.text || "").slice(0, 80)}`).join("\n");
  const prompt = [
    "你是 AI 输出质量检测员。下面是一次对话：用户消息 + AI 的回复。",
    "请判断回复是否异常，只输出一行 JSON（不要其他文字）：",
    '{"verdict":"repeat|evasive|off_topic|ok","suggestion":"异常时给 AI 一句修正指引（30 字内，中文）"}',
    "判定标准：",
    "- repeat: 与用户消息无关/机械重复/内容与问题完全无关的复读",
    "- evasive: 敷衍（如'好的收到'这类没实际回答的）",
    "- off_topic: 答非所问",
    "- ok: 正常回答",
    "",
    `最近对话：\n${hist}`,
    `用户消息：${String(userMessage || "").slice(0, 300)}`,
    `AI 回复：${String(output || "").slice(0, 600)}`,
  ].join("\n");
  try {
    const r = await _directChat(m, prompt, []);
    const text = String(r?.text || "");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed && typeof parsed.verdict === "string") {
      return { verdict: parsed.verdict, suggestion: String(parsed.suggestion || "") };
    }
  } catch {}
  return null;
}
