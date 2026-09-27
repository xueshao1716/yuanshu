import { pickWorkshopModel } from "./workshop-model.mjs";

export function messagesToDirectChat(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let systemHint = "";
  const history = [];
  let lastUser = "";
  for (const m of list) {
    const role = m?.role;
    const content = typeof m?.content === "string" ? m.content : "";
    if (role === "system") systemHint = systemHint ? `${systemHint}\n${content}` : content;
    else if (role === "user") {
      if (lastUser) history.push({ role: "user", content: lastUser });
      lastUser = content;
    } else if (role === "assistant") {
      if (lastUser) {
        history.push({ role: "user", content: lastUser });
        lastUser = "";
      }
      history.push({ role: "assistant", content });
    }
  }
  return { message: lastUser, history, systemHint };
}

export function modelKeyFromRequest(req, body) {
  const cookie = String(req?.headers?.cookie || "");
  const m = /(?:^|;\s*)yuanshu-ui-model=([^;]+)/.exec(cookie);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return String(body?.model || "");
}

export async function handleWorkshopUiChat(ctx, res, body) {
  const { json, defaultModel, getModelList, directChat } = ctx;
  const picked = pickWorkshopModel({ defaultModel, getModelList }, { model: modelKeyFromRequest(ctx.req, body) }) || defaultModel;
  if (!picked) return json(res, 400, { error: "没有可用模型" });
  const { message, history, systemHint } = messagesToDirectChat(body?.messages);
  if (!message) return json(res, 400, { error: "缺少 messages" });
  const result = await directChat(picked, message, history, systemHint ? { systemHint } : {});
  if (!result?.text) return json(res, 502, { error: "模型没有返回内容" });
  return json(res, 200, {
    choices: [{ message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
  });
}
