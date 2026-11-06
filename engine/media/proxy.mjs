// engine/image-proxy.mjs —— 外链图片代理（2026-10-12）
// 为什么存在：客户端 WebView 里直接 <img src="外链"> 会撞三类墙——
// ①防盗链（Referer 校验）②https 页面加载 http 图（混合内容）③壳 CSP img-src 白名单。
// 统一转成同源 /api/proxy/image?url=…，服务端拉图回传，三类问题一次消除。
// 鉴权走全局 checkAuth（query token 即可，img 标签带不了 header）。

const MAX_BYTES = 10 * 1024 * 1024; // 10MB 上限：图片代理不是文件下载
const ALLOWED_TYPES = /^image\/(jpeg|png|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)/i;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 校验代理目标：只放行 http(s) 外链，拒绝内网/本机地址（防 SSRF 打内网服务）。 */
export function validateProxyUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return { error: "bad_url" }; }
  if (!/^https?:$/.test(u.protocol)) return { error: "bad_scheme" };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return { error: "local_blocked" };
  // 内网段：10.x / 172.16-31.x / 192.168.x / 169.254.x
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return { error: "local_blocked" };
  }
  return { url: u.href };
}

/** 拉取并校验图片；返回 { body, contentType } 或抛 Error（message 已是用户可读中文）。 */
export async function fetchProxiedImage(raw, { fetch: f = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const checked = validateProxyUrl(raw);
  if (checked.error) throw new Error(`图片代理拒绝该地址（${checked.error}）`);
  const res = await f(checked.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.8" },
    // Node 端 fetch 不发 Referer，天然免防盗链；勿加 referrerPolicy（undici 不认）
  });
  if (!res.ok) throw new Error(`源站返回 ${res.status}`);
  const type = String(res.headers.get("content-type") || "").split(";")[0].trim();
  if (!ALLOWED_TYPES.test(type)) throw new Error(`不是图片（${type || "未知类型"}）`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error("图片超过 10MB 上限");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error("图片超过 10MB 上限");
  return { body: buf, contentType: type };
}
