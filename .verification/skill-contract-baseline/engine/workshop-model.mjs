export function pickWorkshopModel(ctx, body) {
  const raw = String(body?.model || "").trim();
  const list = typeof ctx.getModelList === "function" ? (ctx.getModelList() || []) : [];
  if (raw.includes("/")) {
    const i = raw.indexOf("/");
    const hit = list.find(m => m.provider === raw.slice(0, i) && m.id === raw.slice(i + 1));
    if (hit) return hit;
  }
  return ctx.defaultModel;
}

function capKeys(m) {
  const cap = m?.capabilities;
  return Array.isArray(cap) ? cap : Object.entries(cap || {}).filter(([, v]) => v).map(([k]) => k);
}

function isTextModel(m) {
  const keys = capKeys(m);
  return !keys.includes("image") && !keys.includes("video");
}

export function pickFlashTextModel(list) {
  const text = (Array.isArray(list) ? list : []).filter(isTextModel);
  const prefer = [/2\.5-flash/i, /flash-lite/i, /glm-5\.3-flash/i, /flash/i];
  for (const re of prefer) {
    const hit = text.find(m => re.test(m.id));
    if (hit) return hit;
  }
  return text[0] || null;
}

export function pickExpandModel(ctx, body) {
  const list = typeof ctx.getModelList === "function" ? (ctx.getModelList() || []) : [];
  const raw = String(body?.model || "").trim();
  if (raw.includes("/")) {
    const i = raw.indexOf("/");
    const hit = list.find(m => m.provider === raw.slice(0, i) && m.id === raw.slice(i + 1));
    if (hit) return hit;
  }
  return pickFlashTextModel(list) || ctx.defaultModel || (typeof ctx.getDefaultModel === "function" ? ctx.getDefaultModel() : null);
}
