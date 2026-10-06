// 微信接入（iLink Bot）：扫码登录、收发消息、每个好友对应一个元枢会话。
// 状态全部落在 <dir>：account.json（凭证，只本机）、cursor.json（轮询游标）、
// sessions.json（好友 → 会话）、settings.json（是否开启）。status() 从不返回凭证。
// 对话走本机回环：伙伴本人（扫码绑定的 userId）走 /api/runs，和网页聊天同一条任务链路，
// 才铸得出母体执行身份（培养工具要它）；其他发信人仍走 /api/chat，没有执行身份。
// 2026-10-07：以前全走 /api/chat——那条路不建 run，身份永远为空，培养工具每次都报 identity_denied。
import fs from "node:fs";
import path from "node:path";
import { createIlinkClient, normalizeMessage, splitForWechat, stripMarkdownForWechat, updatesOk, RATE_LIMITED, ILINK_BASE } from "./wechat-ilink.mjs";

const QR_POLL_MS = 1500;
const QR_DEADLINE_MS = 4 * 60_000;
const QR_REFRESH_LIMIT = 3;
const REPLY_GAP_MS = 3500;
const RECENT_LIMIT = 20;

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; } };
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
};
export const maskId = (id) => {
  const s = String(id || "");
  const [head, domain] = s.split("@");
  if (!head) return "";
  if (head.length <= 8) return `${head[0]}…${domain ? "@" + domain : ""}`;
  return `${head.slice(0, 4)}…${head.slice(-3)}${domain ? "@" + domain : ""}`;
};
const preview = (t, n = 40) => String(t || "").replace(/\s+/g, " ").slice(0, n);

// 从 /api/chat 的 SSE 里只收正文 delta；工具名、思考等不发到微信。
export async function readChatStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", answer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split("\n");
      const event = (lines.find((l) => l.startsWith("event:")) || "").slice(6).trim();
      const data = (lines.find((l) => l.startsWith("data:")) || "").slice(5).trim();
      if (!data) continue;
      let d;
      try { d = JSON.parse(data); } catch { continue; }
      if (event === "delta") answer += d.text || "";
      else if (event === "error") throw new Error(d.message || "chat error");
    }
  }
  return answer.trim();
}

// 从 /api/runs/:id/events 的 SSE 里只收正文 delta；任务以 failed/stopped/interrupted 结束时报错。
export async function readRunStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", answer = "", ended = "", failure = "";
  // 事件流在任务结束后不会自己关（连接时已结束才会），收到终态事件就主动断开，否则桥会一直挂着
  while (!ended) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = (block.split("\n").find((l) => l.startsWith("data:")) || "").slice(5).trim();
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "delta") answer += ev.data?.text || "";
      else if (["completed", "failed", "stopped", "interrupted"].includes(ev.type)) {
        ended = ev.type;
        failure = String(ev.data?.message || ev.data?.reason || ev.type);
        break;
      }
    }
  }
  if (ended) await reader.cancel().catch(() => {});
  if (ended && ended !== "completed" && !answer.trim()) {
    const err = new Error(`任务${ended}：${failure.slice(0, 160)}`);
    if (/404|not.?found|不存在/i.test(failure)) err.status = 404;
    throw err;
  }
  return answer.trim();
}

export function createLoopbackChat({ base, token, fetch: f = globalThis.fetch, now = () => Date.now() }) {
  const headers = () => ({ "Content-Type": "application/json", ...(token() ? { Authorization: `Bearer ${token()}` } : {}) });
  return {
    async createSession(name) {
      const res = await f(`${base()}/api/sessions`, { method: "POST", headers: headers(), body: JSON.stringify({ name, group: "wechat" }) });
      if (!res.ok) throw new Error(`建会话失败 ${res.status}`);
      const j = await res.json();
      if (!j.id) throw new Error("建会话失败：没有 id");
      return j.id;
    },
    async ask(message, sessionId, { owner = false } = {}) {
      if (owner) {
        const created = await f(`${base()}/api/runs`, { method: "POST", headers: headers(), body: JSON.stringify({
          sessionId, message, clientRequestId: `wechat-${sessionId}-${now()}`,
          backgroundRecovery: false, // 服务重启后续跑出来的回复没人往微信送，宁可明着失败
        }) });
        if (!created.ok) {
          const t = await created.text().catch(() => "");
          const err = new Error(`/api/runs ${created.status}: ${t.slice(0, 160)}`);
          err.status = created.status;
          throw err;
        }
        const { runId } = await created.json();
        const res = await f(`${base()}/api/runs/${encodeURIComponent(runId)}/events?after=0`, { headers: headers() });
        if (!res.ok || !res.body) throw Object.assign(new Error(`/api/runs events ${res.status}`), { status: res.status });
        return readRunStream(res);
      }
      const res = await f(`${base()}/api/chat`, { method: "POST", headers: headers(), body: JSON.stringify({ message, sessionId }) });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        const err = new Error(`/api/chat ${res.status}: ${t.slice(0, 160)}`);
        err.status = res.status;
        throw err;
      }
      return readChatStream(res);
    },
  };
}

export function createWechatBridge({
  dir, chat, client = createIlinkClient(), legacyDir = "",
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(), log = () => {},
}) {
  const file = (n) => path.join(dir, n);
  const loadAccount = () => readJson(file("account.json"), null);
  const settings = () => ({ enabled: false, notify: false, ...readJson(file("settings.json"), {}) });
  const setEnabled = (enabled) => writeJson(file("settings.json"), { ...settings(), enabled });
  // 状态目录自带 .gitignore：就算工作区是 git 仓库，凭证也不会被提交。
  try { fs.mkdirSync(dir, { recursive: true }); if (!fs.existsSync(file(".gitignore"))) fs.writeFileSync(file(".gitignore"), "*\n"); } catch {}
  let sessions = readJson(file("sessions.json"), {});
  const saveSessions = () => writeJson(file("sessions.json"), sessions);

  const login = { state: "idle", qrUrl: "", message: "", startedAt: 0, token: 0 };
  const stats = { received: 0, replied: 0, failed: 0, lastAt: 0, lastError: "", startedAt: 0 };
  const recent = [];
  // 每个好友最近一条消息的 context_token：主动发消息（通知）时带上，回复能挂到同一个对话上。
  let contexts = readJson(file("contexts.json"), {});
  const remember = (sender, tokenValue) => {
    if (!tokenValue || contexts[sender] === tokenValue) return;
    contexts = { ...contexts, [sender]: tokenValue };
    writeJson(file("contexts.json"), contexts);
  };
  const note = (dir_, who, text) => {
    recent.unshift({ at: now(), dir: dir_, who: maskId(who), text: preview(text) });
    recent.length = Math.min(recent.length, RECENT_LIMIT);
  };
  let loop = null, stopping = false;
  const inflight = new Set();
  const queue = [];
  let flushing = false;

  // 小语自己搭的独立桥（工程/ilink-weixin-*.json）：首次启动把凭证、游标、会话映射接过来。
  function importLegacy() {
    if (!legacyDir || loadAccount() || settings().legacyImported) return false;
    const acc = readJson(path.join(legacyDir, "ilink-weixin-account.json"), null);
    if (!acc?.token) return false;
    writeJson(file("account.json"), acc);
    writeJson(file("settings.json"), { ...settings(), legacyImported: true }); // 退出登录后不再从旧目录复活
    const st = readJson(path.join(legacyDir, "ilink-bridge-state.json"), null);
    if (st?.buf) writeJson(file("cursor.json"), { buf: st.buf, ack: st.ack || "" });
    const map = readJson(path.join(legacyDir, "ilink-weixin-sessions.json"), null);
    if (map && typeof map === "object") { sessions = { ...map, ...sessions }; saveSessions(); }
    log("[微信] 已接管独立桥的登录凭证");
    return true;
  }

  async function flush(acc) {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        let r = await client.sendText(acc.token, job.to, job.text, job.contextToken, acc.base_url || ILINK_BASE);
        if (r?.ret === RATE_LIMITED) { await sleep(3000); r = await client.sendText(acc.token, job.to, job.text, job.contextToken, acc.base_url || ILINK_BASE); }
        if (r?.ret && r.ret !== 0) { stats.failed++; stats.lastError = `发送失败 ret=${r.ret} ${r.errmsg || ""}`.trim(); }
        else { stats.replied++; note("out", job.to, job.text); }
        if (queue.length) await sleep(REPLY_GAP_MS);
      }
    } finally { flushing = false; }
  }
  const reply = (acc, to, text, contextToken) => {
    for (const part of splitForWechat(stripMarkdownForWechat(text))) queue.push({ to, text: part, contextToken });
    return flush(acc);
  };

  async function sessionFor(sender, fresh = false) {
    if (!fresh && sessions[sender]) return sessions[sender];
    const id = await chat.createSession(`微信·${maskId(sender)}`);
    sessions[sender] = id;
    saveSessions();
    return id;
  }

  async function handle(acc, m) {
    inflight.add(m.sender);
    try {
      let answer;
      // 只有扫码绑定的本人算「伙伴亲自发起」；陌生发信人拿不到母体执行身份
      const owner = !!acc?.userId && m.sender === acc.userId;
      try {
        answer = await chat.ask(m.text, await sessionFor(m.sender), { owner });
      } catch (e) {
        if (e.status !== 404 && e.status !== 400) throw e;
        answer = await chat.ask(m.text, await sessionFor(m.sender, true), { owner }); // 会话被删：换新会话重来一次
      }
      await reply(acc, m.sender, answer || "这次没组织出回复，稍后再问我一次。", m.contextToken);
    } catch (e) {
      stats.failed++;
      stats.lastError = preview(e.message, 160);
      await reply(acc, m.sender, "我这边出了点问题，稍后再发一次试试。", m.contextToken);
    } finally {
      inflight.delete(m.sender);
    }
  }

  async function run() {
    const acc = loadAccount();
    const at = acc.base_url || ILINK_BASE;
    let cursor = { buf: "", ack: "", ...readJson(file("cursor.json"), {}) };
    let backoff = 2000;
    stats.startedAt = now();
    while (!stopping) {
      try {
        const r = await client.getUpdates(acc.token, cursor, at);
        if (!updatesOk(r)) {
          if (r?.ret === RATE_LIMITED) { await sleep(3000); continue; }
          stats.lastError = `收消息失败 ret=${r?.ret} ${r?.errmsg || ""}`.trim();
          await sleep(backoff); backoff = Math.min(backoff * 2, 30_000);
          continue;
        }
        backoff = 2000;
        if (r.get_updates_buf) cursor = { buf: r.get_updates_buf, ack: r.ack_token || cursor.ack };
        writeJson(file("cursor.json"), cursor);
        for (const raw of r.msgs || []) {
          const m = normalizeMessage(raw, acc.botId);
          if (!m || m.isGroup || !m.text) continue;
          stats.received++; stats.lastAt = now();
          remember(m.sender, m.contextToken);
          note("in", m.sender, m.text);
          if (inflight.has(m.sender)) { void reply(acc, m.sender, "上一条我还在想，稍等一下。", m.contextToken); continue; }
          void handle(acc, m);
        }
      } catch (e) {
        if (stopping) break;
        stats.lastError = preview(e.message, 160);
        await sleep(backoff); backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  function start() {
    if (!loadAccount()?.token) throw Object.assign(new Error("还没登录微信，先扫码"), { status: 409 });
    setEnabled(true);
    stopping = false; // 停止后长轮询还没返回时再开：沿用那个循环，不起第二个
    if (loop) return;
    loop = run().catch((e) => { stats.lastError = preview(e.message, 160); }).finally(() => { loop = null; });
  }
  async function stop({ keepEnabled = false } = {}) {
    if (!keepEnabled) setEnabled(false);
    stopping = true;
    // 长轮询最长 40 秒才返回；不等它，状态立刻显示停止，下一次 getupdates 结束后循环自己退出。
  }

  async function runLogin(token) {
    let at = ILINK_BASE, refresh = 0;
    let qr = await client.fetchQr(at);
    if (!qr.value) throw new Error("没拿到登录二维码");
    Object.assign(login, { state: "waiting", qrUrl: qr.url || qr.value, message: "用微信扫码" });
    const deadline = now() + QR_DEADLINE_MS;
    while (login.token === token && now() < deadline) {
      await sleep(QR_POLL_MS);
      if (login.token !== token) return;
      const st = await client.qrStatus(qr.value, at);
      if (st.status === "scaned") Object.assign(login, { state: "scanned", message: "已扫码，在手机上点确认" });
      else if (st.status === "scaned_but_redirect" && st.redirect_host) at = `https://${st.redirect_host}`;
      else if (st.status === "expired") {
        if (++refresh > QR_REFRESH_LIMIT) throw new Error("二维码多次过期，重新点登录");
        qr = await client.fetchQr(at);
        Object.assign(login, { state: "waiting", qrUrl: qr.url || qr.value, message: "二维码已刷新，重新扫" });
      } else if (st.status === "confirmed") {
        const acc = { token: String(st.bot_token || ""), botId: String(st.ilink_bot_id || ""), userId: String(st.ilink_user_id || ""), base_url: String(st.baseurl || at), saved_at: new Date(now()).toISOString() };
        if (!acc.token || !acc.botId) throw new Error("确认成功但凭证不全，重新登录");
        await stop({ keepEnabled: true });
        while (loop) await sleep(50);
        writeJson(file("account.json"), acc);
        try { for (const n of ["cursor.json", "contexts.json"]) fs.rmSync(file(n), { force: true }); contexts = {}; } catch {}
        Object.assign(login, { state: "confirmed", qrUrl: "", message: "已登录" });
        start();
        return;
      }
    }
    if (login.token === token) throw new Error("超时没扫码，重新点登录");
  }

  return {
    boot() {
      try { importLegacy(); } catch (e) { log(`[微信] 接管独立桥失败：${e.message}`); }
      if (settings().enabled && loadAccount()?.token) start();
    },
    status() {
      const acc = loadAccount();
      return {
        loggedIn: !!acc?.token,
        bot: acc?.botId ? maskId(acc.botId) : "",
        owner: acc?.userId ? maskId(acc.userId) : "",
        since: acc?.saved_at || "",
        enabled: settings().enabled,
        notify: settings().notify,
        running: !!loop && !stopping,
        friends: Object.keys(sessions).length,
        login: { state: login.state, qrUrl: login.qrUrl, message: login.message },
        stats: { ...stats },
        recent: [...recent],
      };
    },
    startLogin() {
      const token = (login.token || 0) + 1;
      Object.assign(login, { token, state: "starting", qrUrl: "", message: "正在取二维码", startedAt: now() });
      runLogin(token).catch((e) => { if (login.token === token) Object.assign(login, { state: "failed", qrUrl: "", message: preview(e.message, 120) }); });
      return { ok: true };
    },
    cancelLogin() { login.token++; Object.assign(login, { state: "idle", qrUrl: "", message: "" }); },
    start, stop,
    async logout() {
      await stop();
      for (const n of ["account.json", "cursor.json", "contexts.json"]) fs.rmSync(file(n), { force: true });
      Object.assign(login, { state: "idle", qrUrl: "", message: "" });
    },
    setNotify(on) { writeJson(file("settings.json"), { ...settings(), notify: !!on }); return { notify: !!on }; },
    // 主动发给机器人的主人（扫码的那个人），给交付通知用；要先在面板里打开「通知发到微信」。
    async notifyOwner(text) {
      const acc = loadAccount();
      if (!acc?.token || !acc.userId) throw Object.assign(new Error("微信没登录"), { status: 409 });
      if (!settings().notify) throw Object.assign(new Error("没打开「通知发到微信」"), { status: 409 });
      await reply(acc, acc.userId, text, contexts[acc.userId] || "");
      return { ok: true };
    },
    _waitIdle: async () => { while (loop || flushing) await sleep(10); },
  };
}
