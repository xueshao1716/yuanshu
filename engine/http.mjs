// ===== http.mjs —— 统一 HTTP 客户端（原生 fetch，替代早期 python 子进程方案）=====
// 语义与旧版 httpJsonFetch 完全对齐：
//   - 非 2xx（4xx/5xx）也 resolve，返回 {status, ok:false, json(), text()}——调用方依赖此行为走 endpoint fallback 链
//   - 仅网络错误 / 超时 reject；超时错误文案为 "timeout"（调用方按 /timeout/i 识别）
//   - headers 未带 User-Agent 时补浏览器 UA（web_search 抓取等依赖）
//   - 自动走系统代理（旧 python/urllib 的核心行为）：env 代理变量 → Windows 注册表系统代理 → 直连。
//     代理通过 undici ProxyAgent 实现（动态导入；未安装 undici 时退回直连）。

import { execFile } from "node:child_process";
import net from "node:net";

let proxyResolved = false;
let proxyUrl = null; // null = 无代理，直连

function readEnvProxy() {
  return (
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || ""
  ).trim() || null;
}

// Windows 系统代理（Internet Options / Clash / v2rayN 写入的注册表项），urllib 的 getproxies 在 Windows 上优先读这里
function readWindowsRegistryProxy() {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    execFile("reg", ["query", key, "/v", "ProxyServer"], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.match(/ProxyServer\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i);
      if (!m) return resolve(null);
      let val = m[1].trim();
      if (!val) return resolve(null);
      // 两种格式："host:port" 或 "http=host:port;https=host:port;..."
      if (val.includes("=")) {
        const parts = Object.fromEntries(val.split(";").map((s) => s.split("=")));
        val = parts["https"] || parts["http"] || "";
      }
      if (!val) return resolve(null);
      resolve(/^https?:\/\//i.test(val) ? val : `http://${val}`);
    });
  });
}

async function ensureProxyResolved() {
  if (proxyResolved) return;
  proxyUrl = readEnvProxy() || (process.platform === "win32" ? await readWindowsRegistryProxy() : null);
  // ProxyEnable=0 时注册表值是残留的，仅当存在 enabled 标记才信任注册表结果（env 代理不受此限）
  if (proxyUrl && !readEnvProxy() && process.platform === "win32") {
    const enabled = await new Promise((resolve) => {
      execFile("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
        { timeout: 3000, windowsHide: true }, (err, stdout) => {
          resolve(!err && /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout));
        });
    });
    if (!enabled) proxyUrl = null;
  }
  proxyResolved = true;
}

let dispatcherCache = null;

// 代理活性探测：env/注册表里的代理可能已死（Clash 退出/崩溃但 env 残留是常态）——
// 盲信死代理 = 全部外联请求 fetch failed（2026-08-20 真机事故：env 代理指向已关闭的 7890）。
// TCP 探测代理端口，1.2s 不通即判死，60s 内缓存结论；死了自动降级直连（境内 API 本就直连可达）。
let proxyLiveness = { key: "", at: 0, alive: false };
function probeProxyAlive(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return Promise.resolve(false); }
  const host = u.hostname;
  const port = parseInt(u.port, 10) || (u.protocol.startsWith("https") ? 443 : 80);
  const key = `${host}:${port}`;
  if (proxyLiveness.key === key && Date.now() - proxyLiveness.at < 60000) {
    return Promise.resolve(proxyLiveness.alive);
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 1200 });
    sock.once("connect", () => { sock.destroy(); proxyLiveness = { key, at: Date.now(), alive: true }; resolve(true); });
    sock.once("error", () => { sock.destroy(); proxyLiveness = { key, at: Date.now(), alive: false }; resolve(false); });
    sock.once("timeout", () => { sock.destroy(); proxyLiveness = { key, at: Date.now(), alive: false }; resolve(false); });
  });
}
let deadProxyLogged = false;

async function getProxyDispatcher(urlObj) {
  // 显式逃生口：PI_WEB_FORCE_DIRECT=1 强制全部直连
  if (process.env.PI_WEB_FORCE_DIRECT === "1") return null;
  // 回环/内网地址永远直连（no_proxy 基本语义；也保证本地服务调用不被系统代理劫持）
  const host = urlObj?.hostname || "";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return null;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (noProxy.some((p) => host === p || host.endsWith(p.startsWith(".") ? p : "." + p))) return null;
  await ensureProxyResolved();
  if (!proxyUrl) return null;
  const alive = await probeProxyAlive(proxyUrl);
  if (!alive) {
    if (!deadProxyLogged) {
      deadProxyLogged = true;
      console.log(`[http] ⚠️ 代理 ${proxyUrl} 不可达，自动降级直连（60s 内不重试代理）`);
    }
    return null;
  }
  if (dispatcherCache) return dispatcherCache;
  try {
    const undici = await import("undici");
    dispatcherCache = new undici.ProxyAgent(proxyUrl);
  } catch {
    // undici 未安装：退回直连（与无代理环境一致），不阻塞请求
    return null;
  }
  return dispatcherCache;
}

async function rawFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = options.timeout || 60000;
  const timer = setTimeout(() => controller.abort(), timeout);
  // P2 abort 补全：外部 signal（客户端断开）也能取消 fetch
  const extSignal = options.signal;
  const onExtAbort = () => controller.abort();
  if (extSignal && !extSignal.aborted) extSignal.addEventListener("abort", onExtAbort, { once: true });
  if (extSignal?.aborted) controller.abort();
  try {
    const headers = { ...options.headers };
    if (!headers["User-Agent"] && !headers["user-agent"]) {
      headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0";
    }
    const init = {
      method: options.method || "GET",
      headers,
      signal: controller.signal,
    };
    if (options.body) init.body = options.body;
    const dispatcher = await getProxyDispatcher(new URL(url));
    if (dispatcher) init.dispatcher = dispatcher; // undici 扩展字段：代理隧道
    return await fetch(url, init);
  } catch (err) {
    if (err?.name === "AbortError" || controller.signal.aborted) throw new Error("timeout");
    throw err;
  } finally {
    clearTimeout(timer);
    if (extSignal) try { extSignal.removeEventListener("abort", onExtAbort); } catch {}
  }
}

// 把上游的错误体翻成人能读的一句话（2026-09-16）。
// 真机教训：原来只留 150 字符，正好截在 `"extError":{"code"` 处——用户看到半截 JSON，
// 既不知道是什么错、也不知道谁拒的。现在优先摘出 msg / displayMsg.zh / extError.code，
// 再附一段够长的原文（默认 600 字），并在截断时说明原文有多长。
export function describeHttpError(text, { max = 600 } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return "(空响应体)";
  try {
    const j = JSON.parse(raw);
    const msg = j.msg || j.message || j.error?.message || (typeof j.error === "string" ? j.error : "");
    const zh = j.displayMsg?.zh || "";
    const code = j.extError?.code || j.code || "";
    const head = [msg, zh].filter(Boolean).join("｜");
    if (head) return `${code ? `[${code}] ` : ""}${String(head).slice(0, max)}`;
  } catch {}
  return raw.length > max ? `${raw.slice(0, max)}…（原文 ${raw.length} 字，已截断）` : raw;
}

// 会话亲和头（2026-09-16）。
// 真机：opencode-go 的模型定义在 zen/go/v1，而 auth.json 里记的是 zen/v1；自研循环又优先用 auth 那份，
// 于是 401 "Model ... is not supported"；把端点修对之后，缺 x-opencode-session 还会 400 MissingSessionID。
// pi 通道由 SDK 自己发这类头，自研循环原本一个都不发——这是"自研引擎打不动原生强模型"的直接原因之一。
const AFFINITY_HEADER = { "opencode-go": "x-opencode-session", opencode: "x-opencode-session", openrouter: "x-session-id" };
let _affinityFallback = "";

export function sessionAffinityHeaders({ provider = "", compat = {}, sessionId = "" } = {}) {
  const declared = compat?.sendSessionAffinityHeaders === true;
  const fmt = compat?.sessionAffinityFormat || "";
  const header = AFFINITY_HEADER[provider] || (declared ? (fmt === "openrouter" ? "x-session-id" : "x-opencode-session") : "");
  if (!header) return {};
  // 没有会话 id 也要发：这条头是"路由/计费"用的，缺了直接 400（真机 MissingSessionID）。
  // 探针实测随便一个稳定值就能路由（'ab-test-session-1' → 200），所以退回一个进程级稳定值，
  // 总比把整轮请求打失败强。同进程内保持稳定，便于上游缓存命中。
  const sid = String(sessionId || "").trim() || (_affinityFallback ||= `yuanshu-${process.pid}-${Date.now().toString(36)}`);
  return { [header]: sid };
}

export async function httpJsonFetch(url, options = {}) {  const r = await rawFetch(url, options);
  // body 只读一次后缓存——与旧 python 版语义一致（json()/text() 可重复调用，互不冲突）
  const text = await r.text();
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    json: async () => { try { return JSON.parse(text); } catch { return null; } },
    text: async () => text,
  };
}

// 不缓冲整包：给 chat/completions stream:true 用。调用方自己读 r.body。
export async function httpRawFetch(url, options = {}) {
  const r = await rawFetch(url, options);
  return r;
}

// 二进制版：直接返回 Buffer（替代旧 python 子进程 base64 中转方案）
export async function httpBufferFetch(url, options = {}) {
  const r = await rawFetch(url, options);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ok: r.ok, buffer: () => buf };
}

export default httpJsonFetch;
