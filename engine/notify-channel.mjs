// ===== notify-channel.mjs —— 推送通道的"界面化"（2026-10-27）=====
//
// 用户原话：「你不能直接做扫码接口，保存接口吗，我存起来很麻烦的」
// 所以把「手写文件」换成「面板里粘贴 + 一键测试」：
//   · 读/存 pushplus token（只存本机工作区，状态接口只回脱敏尾巴）
//   · 发一条测试推送，把结果写进 pushplus-state.json（和 notify.py 共用）
//   · 通道体检：配置 / 上次结果 / 失败原因
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export const TOKEN_REL = path.join("工程", "pushplus-token.txt");
export const STATE_REL = path.join("工程", "pushplus-state.json");
export const PUSHPLUS_SEND = "https://www.pushplus.plus/send";

const tokenPath = (ws) => path.join(String(ws || "."), TOKEN_REL);
const statePath = (ws) => path.join(String(ws || "."), STATE_REL);

export const maskToken = (t) => {
  const s = String(t || "");
  if (s.length <= 8) return s ? "****" : "";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

export function readToken(wsRoot) {
  try {
    const t = fs.readFileSync(tokenPath(wsRoot), "utf8").trim();
    return t && !t.startsWith("#") ? t : "";
  } catch { return "" }
}

/** 宽松校验：pushplus token 是 32 位左右十六进制；只挡明显不是 token 的东西。 */
export function validateToken(raw) {
  const t = String(raw || "").trim();
  if (!t) return { ok: false, error: "token 不能为空" };
  if (t.length < 16 || t.length > 128) return { ok: false, error: "长度不像 token（应在 16~128 之间）" };
  if (!/^[A-Za-z0-9._-]+$/.test(t)) return { ok: false, error: "含有非法字符（token 只应包含字母、数字、.-_）" };
  return { ok: true, token: t };
}

/** 保存 token（覆盖写，只留 token 一行）。 */
export function saveToken(wsRoot, raw) {
  const v = validateToken(raw);
  if (!v.ok) return v;
  const p = tokenPath(wsRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${v.token}\n`, "utf8");
  // 顺手把状态里的 configured 更新，避免面板显示旧值
  try { writeState(wsRoot, { ...readState(wsRoot), configured: true, savedAt: Date.now() }) } catch {}
  return { ok: true, masked: maskToken(v.token) };
}

export function clearToken(wsRoot) {
  try { fs.rmSync(tokenPath(wsRoot), { force: true }) } catch {}
  try { writeState(wsRoot, { ...readState(wsRoot), configured: false, at: Date.now() }) } catch {}
  return { ok: true };
}

export function readState(wsRoot) {
  try { return JSON.parse(fs.readFileSync(statePath(wsRoot), "utf8")) } catch { return {} }
}

function writeState(wsRoot, data) {
  const p = statePath(wsRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 通道状态（不含 token 明文）。
 * @returns {{configured:boolean, masked:string, ok:boolean|null, at:number, detail:string, okCount:number, failCount:number}}
 */
export function channelStatus(wsRoot) {
  const token = readToken(wsRoot);
  const st = readState(wsRoot);
  return {
    configured: !!token,
    masked: maskToken(token),
    ok: typeof st.ok === "boolean" ? st.ok : null,
    at: Number(st.at) || 0,
    detail: String(st.detail || ""),
    okCount: Number(st.okCount) || 0,
    failCount: Number(st.failCount) || 0,
  };
}

/** 发一条测试推送。 */
export async function sendTest(wsRoot, { text = "元枢推送测试：收到这条说明通道通了。", fetch: f = globalThis.fetch } = {}) {
  const token = readToken(wsRoot);
  if (!token) return { ok: false, error: "还没保存 token" };
  const at = Date.now();
  try {
    const res = await f(PUSHPLUS_SEND, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, title: "元枢推送测试", content: text, template: "txt" }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text().catch(() => "");
    let code = res.status;
    try { const j = JSON.parse(body); if (typeof j?.code === "number") code = j.code } catch {}
    const ok = code === 200;
    const prev = readState(wsRoot);
    writeState(wsRoot, {
      at, ok, channel: "pushplus", detail: ok ? "HTTP 200" : `HTTP ${code} ${body.slice(0, 120)}`,
      configured: true, lastOkAt: ok ? at : (Number(prev.lastOkAt) || 0),
      okCount: (Number(prev.okCount) || 0) + (ok ? 1 : 0),
      failCount: (Number(prev.failCount) || 0) + (ok ? 0 : 1),
    });
    return ok ? { ok: true, detail: "已发送，去微信看看" } : { ok: false, error: `推送失败：HTTP ${code} ${body.slice(0, 120)}` };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 160);
    const prev = readState(wsRoot);
    writeState(wsRoot, {
      at, ok: false, channel: "pushplus", detail: msg, configured: true,
      lastOkAt: Number(prev.lastOkAt) || 0,
      okCount: Number(prev.okCount) || 0, failCount: (Number(prev.failCount) || 0) + 1,
    });
    return { ok: false, error: `推送异常：${msg}` };
  }
}

/** 打开 pushplus 控制台（让用户去取 token 的那一步尽量少）。 */
export function openConsole({ platform = process.platform, run = execFile } = {}) {
  const url = "https://www.pushplus.plus/";
  try {
    if (platform === "win32") execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true });
    else if (platform === "darwin") execFile("open", [url]);
    else execFile("xdg-open", [url]);
    return { ok: true, url };
  } catch (e) {
    return { ok: false, url, error: String(e?.message || e).slice(0, 120) };
  }
}
