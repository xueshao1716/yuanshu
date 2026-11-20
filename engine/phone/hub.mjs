// ===== 手机控制通道（2026-11-20）=====
//
// 用户要「像 Grok 那样，手机客户端能控制手机」。原有的手机连接只有一条单向的通知流
// （/api/notify/stream，服务器→手机），没有下发指令的路。这里补一条双向通道：
//   手机 App（原生前台服务）连 GET /api/phone/stream，收 `cmd` 事件；
//   执行完 POST /api/phone/result 回传；服务器这边按 id 等结果，超时就报错。
// 权限不在这里管：每项能力是否开放由手机端自己的开关决定（默认全关），
// 手机在 hello 里报上来，这里只做「没开就别发」的提前拦截，真正的拦截在手机上。
import { randomUUID } from "node:crypto";
import { ADB_CAPS } from "./adb.mjs";

export const DEFAULT_TIMEOUT_MS = 30_000;
// 手机断线后等它重连的宽限期。结果走独立的 POST /api/phone/result，SSE 断了指令不一定丢：
// 荣耀/华为等系统在元枢切到后台（比如刚 open_app）时会掐掉长连接，几秒后前台服务又连回来。
export const RECONNECT_GRACE_MS = 15_000;

export function createPhoneHub({ now = Date.now, adb = null, graceMs = RECONNECT_GRACE_MS } = {}) {
  const devices = new Map(); // deviceId → { id, name, model, android, caps, connectedAt, lastSeen, write, close }
  const waiting = new Map(); // cmdId → { deviceId, resolve, reject, timer, grace }
  const recent = new Map(); // deviceId → 最近一次断开时间（用来判断「刚掉线，值得等一下」）
  const comeback = new Map(); // deviceId → Set<() => void>，设备重连时唤醒在等的 send
  const events = []; // 最近的连接/断开记录，status 里给出，方便查掉线规律
  const log = (type, id, extra = {}) => { events.push({ t: now(), type, device: id, ...extra }); if (events.length > 40) events.shift(); };

  function connect(res, req, { deviceId, name = "", model = "", android = "", caps = [] } = {}) {
    const id = String(deviceId || "").slice(0, 80);
    if (!id) { res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "缺少 device" })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const old = devices.get(id);
    if (old) old.close?.(); // 同一台手机重连：旧连接作废，旧连接上未完成的指令判失败
    const dev = {
      id, name: String(name || "手机").slice(0, 60), model: String(model || "").slice(0, 60), android: String(android || "").slice(0, 20),
      caps: normCaps(caps), connectedAt: now(), lastSeen: now(),
      write: (s) => { if (!res.writableEnded) res.write(s); },
      close: () => { try { res.end(); } catch { /* 已断 */ } },
    };
    devices.set(id, dev);
    log("connect", id, recent.has(id) ? { offlineMs: now() - recent.get(id) } : {});
    recent.delete(id);
    // 断线期间没拿到结果的指令重发一次（手机按 id 去重，已在执行的不会做两遍）
    for (const [cid, w] of waiting) {
      if (w.deviceId !== id) continue;
      if (w.grace) { clearTimeout(w.grace); w.grace = null; }
      dev.write(`event: cmd\ndata: ${JSON.stringify({ id: cid, cmd: w.cmd, args: w.args, retry: true })}\n\n`);
    }
    const wake = comeback.get(id); comeback.delete(id);
    for (const fn of wake || []) fn();
    dev.write(`event: hello\ndata: ${JSON.stringify({ ok: true, deviceId: id })}\n\n`);
    const hb = setInterval(() => { try { dev.write(": ping\n\n"); } catch { /* 断开即忽略 */ } }, 20000);
    hb.unref?.();
    req.on("close", () => {
      clearInterval(hb);
      if (devices.get(id) !== dev) return; // 已被同一台手机的新连接顶替，等待中的指令留给新连接
      devices.delete(id);
      recent.set(id, now());
      log("close", id, { pending: [...waiting.values()].filter((w) => w.deviceId === id).length });
      for (const [cid, w] of waiting) {
        if (w.deviceId !== id || w.grace) continue;
        w.grace = setTimeout(() => {
          if (devices.has(id) || !waiting.delete(cid)) return;
          clearTimeout(w.timer);
          w.reject(new Error("手机连接断开了，15 秒内没有连回来（多半是系统把元枢后台冻结了：请在手机「应用启动管理」里把元枢设为手动管理并允许后台活动）"));
        }, graceMs);
        w.grace.unref?.();
      }
    });
  }

  /** 设备刚掉线（2 分钟内）时等它连回来，最多 waitMs；否则立即返回 null。 */
  function waitBack(deviceId, waitMs) {
    const ids = deviceId ? [String(deviceId)] : [...recent.keys()];
    const fresh = ids.filter((id) => recent.has(id) && now() - recent.get(id) < 120_000);
    if (!fresh.length || waitMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); for (const id of fresh) comeback.get(id)?.delete(wake); resolve(v); };
      const wake = () => finish(pick(deviceId));
      const timer = setTimeout(() => finish(null), waitMs);
      timer.unref?.();
      for (const id of fresh) { if (!comeback.has(id)) comeback.set(id, new Set()); comeback.get(id).add(wake); }
    });
  }

  /** 手机更新能力开关（用户在 App 里拨开关后立刻上报，不用重连）。 */
  function hello({ deviceId, name, model, android, caps, lastError } = {}) {
    const dev = devices.get(String(deviceId || ""));
    if (!dev) return { ok: false, error: "设备未连接" };
    if (name) dev.name = String(name).slice(0, 60);
    if (model) dev.model = String(model).slice(0, 60);
    if (android) dev.android = String(android).slice(0, 20);
    if (caps !== undefined) dev.caps = normCaps(caps);
    if (lastError) { dev.lastError = String(lastError).slice(0, 2000); log("app-error", dev.id); }
    dev.lastSeen = now();
    return { ok: true, device: view(dev) };
  }

  function result({ deviceId, id, ok, data, error } = {}) {
    const w = waiting.get(String(id || ""));
    if (!w) return { ok: false, error: "指令不存在或已超时" };
    if (deviceId && w.deviceId !== String(deviceId)) return { ok: false, error: "设备不匹配" };
    waiting.delete(String(id)); clearTimeout(w.timer); if (w.grace) clearTimeout(w.grace);
    const dev = devices.get(w.deviceId); if (dev) dev.lastSeen = now();
    if (ok === false) w.reject(new Error(String(error || "手机端执行失败").slice(0, 500)));
    else w.resolve(data ?? {});
    return { ok: true };
  }

  /** 选设备：指定了就用指定的，没指定就用最近活跃的那台。 */
  function pick(deviceId) {
    if (deviceId) return devices.get(String(deviceId)) || null;
    let best = null;
    for (const d of devices.values()) if (!best || d.lastSeen > best.lastSeen) best = d;
    return best;
  }

  /** 和 pick 一样，但手机 App 不在线时回落到 USB 调试设备（开发捷径，默认关）。 */
  async function target(deviceId) {
    if (deviceId && String(deviceId).startsWith("adb:")) {
      const list = adb ? await adb.refresh() : [];
      const serial = String(deviceId).slice(4);
      return list.includes(serial) ? adbDevice(serial) : null;
    }
    const app = pick(deviceId) || await waitBack(deviceId, graceMs);
    if (app || deviceId || !adb) return app;
    const list = await adb.refresh();
    return list.length ? adbDevice(list[0]) : null;
  }
  const adbDevice = (serial) => ({ id: `adb:${serial}`, name: `USB 调试 ${serial}`, caps: [...ADB_CAPS], adb: true });

  function send(cmd, args = {}, { deviceId, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    if (deviceId && String(deviceId).startsWith("adb:")) {
      if (!adb) return Promise.reject(new Error("USB 调试通道未启用"));
      return adb.act(String(deviceId).slice(4), cmd, args);
    }
    const dev = pick(deviceId);
    if (!dev) return Promise.reject(new Error("没有在线的手机：请在手机上打开元枢 App 并登录（后台保持连接即可）"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const w = waiting.get(id); if (w?.grace) clearTimeout(w.grace); if (waiting.delete(id)) reject(new Error(`手机 ${Math.round(timeoutMs / 1000)} 秒内没有回应（可能被系统省电冻结，打开一下 App 再试）`)); }, timeoutMs);
      timer.unref?.();
      waiting.set(id, { deviceId: dev.id, cmd, args, resolve, reject, timer, grace: null });
      signal?.addEventListener?.("abort", () => { const w = waiting.get(id); if (w?.grace) clearTimeout(w.grace); if (waiting.delete(id)) { clearTimeout(timer); reject(new Error("已取消")); } }, { once: true });
      dev.write(`event: cmd\ndata: ${JSON.stringify({ id, cmd, args })}\n\n`);
    });
  }

  function view(d) {
    return { id: d.id, name: d.name, model: d.model, android: d.android, caps: d.caps, connectedAt: d.connectedAt, lastSeen: d.lastSeen, ...(d.lastError ? { lastError: d.lastError } : {}) };
  }

  function status() {
    return { devices: [...devices.values()].map(view), pending: waiting.size, adb: adb ? adb.status() : null, events: events.slice(-20) };
  }

  return { connect, hello, result, send, pick, target, status, get online() { return devices.size; } };
}

function normCaps(caps) {
  const list = Array.isArray(caps) ? caps : String(caps || "").split(",");
  return [...new Set(list.map((c) => String(c).trim()).filter((c) => /^[a-z_]{1,24}$/.test(c)))];
}
