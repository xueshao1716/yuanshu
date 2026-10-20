// engine/tool-coach.mjs —— 工具失败时的"下一步"教练（2026-10-20，从 yuanshu-protocol 拆出）
//
// 只做一件事：工具报错时补一句"通道还在，你自己判断下一步"，
// 避免模型把"缺字段/密钥被宿主代持"误读成"这个能力没了"。

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
