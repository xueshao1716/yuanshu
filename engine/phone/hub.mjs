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

export function createPhoneHub({ now = Date.now, adb = null } = {}) {
  const devices = new Map(); // deviceId → { id, name, model, android, caps, connectedAt, lastSeen, write, close }
  const waiting = new Map(); // cmdId → { deviceId, resolve, reject, timer }

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
    dev.write(`event: hello\ndata: ${JSON.stringify({ ok: true, deviceId: id })}\n\n`);
    const hb = setInterval(() => { try { dev.write(": ping\n\n"); } catch { /* 断开即忽略 */ } }, 20000);
    hb.unref?.();
    req.on("close", () => {
      clearInterval(hb);
      if (devices.get(id) === dev) devices.delete(id);
      failPending(id, "手机连接断开了");
    });
  }

  function failPending(deviceId, msg) {
    for (const [cid, w] of waiting) if (w.deviceId === deviceId) { waiting.delete(cid); clearTimeout(w.timer); w.reject(new Error(msg)); }
  }

  /** 手机更新能力开关（用户在 App 里拨开关后立刻上报，不用重连）。 */
  function hello({ deviceId, name, model, android, caps } = {}) {
    const dev = devices.get(String(deviceId || ""));
    if (!dev) return { ok: false, error: "设备未连接" };
    if (name) dev.name = String(name).slice(0, 60);
    if (model) dev.model = String(model).slice(0, 60);
    if (android) dev.android = String(android).slice(0, 20);
    if (caps !== undefined) dev.caps = normCaps(caps);
    dev.lastSeen = now();
    return { ok: true, device: view(dev) };
  }

  function result({ deviceId, id, ok, data, error } = {}) {
    const w = waiting.get(String(id || ""));
    if (!w) return { ok: false, error: "指令不存在或已超时" };
    if (deviceId && w.deviceId !== String(deviceId)) return { ok: false, error: "设备不匹配" };
    waiting.delete(String(id)); clearTimeout(w.timer);
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
    const app = pick(deviceId);
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
      const timer = setTimeout(() => { if (waiting.delete(id)) reject(new Error(`手机 ${Math.round(timeoutMs / 1000)} 秒内没有回应（可能被系统省电冻结，打开一下 App 再试）`)); }, timeoutMs);
      timer.unref?.();
      waiting.set(id, { deviceId: dev.id, resolve, reject, timer });
      signal?.addEventListener?.("abort", () => { if (waiting.delete(id)) { clearTimeout(timer); reject(new Error("已取消")); } }, { once: true });
      dev.write(`event: cmd\ndata: ${JSON.stringify({ id, cmd, args })}\n\n`);
    });
  }

  function view(d) {
    return { id: d.id, name: d.name, model: d.model, android: d.android, caps: d.caps, connectedAt: d.connectedAt, lastSeen: d.lastSeen };
  }

  function status() {
    return { devices: [...devices.values()].map(view), pending: waiting.size, adb: adb ? adb.status() : null };
  }

  return { connect, hello, result, send, pick, target, status, get online() { return devices.size; } };
}

function normCaps(caps) {
  const list = Array.isArray(caps) ? caps : String(caps || "").split(",");
  return [...new Set(list.map((c) => String(c).trim()).filter((c) => /^[a-z_]{1,24}$/.test(c)))];
}
