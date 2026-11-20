// 手机控制通道路由（鉴权由全局 checkAuth 负责：主令牌或扫码配对的设备令牌都行）。
export function createPhoneRoutes({ hub, json, readBody }) {
  const body = (fn, maxMB = 0.1) => async (res, req) => {
    try { return json(res, 200, await fn(await readBody(req, maxMB))); }
    catch (e) { return json(res, 400, { error: String(e?.message || e) }); }
  };
  return [
    ["GET", "/api/phone/stream", (res, req, url) => hub.connect(res, req, {
      deviceId: url.searchParams.get("device"), name: url.searchParams.get("name"),
      model: url.searchParams.get("model"), android: url.searchParams.get("android"), caps: url.searchParams.get("caps") || "",
    })],
    ["GET", "/api/phone/status", (res) => json(res, 200, hub.status())],
    ["POST", "/api/phone/hello", body((b) => hub.hello(b || {}))],
    // 截图结果是 base64 PNG，放宽到 12MB
    ["POST", "/api/phone/result", body((b) => hub.result(b || {}), 12)],
  ];
}
