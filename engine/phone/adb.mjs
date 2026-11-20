// 开发捷径：电脑上用 USB 调试（adb）直接操作手机，不用装新版 App 也能试 phone 工具。
// 默认关；在 记忆/运行时/手机控制.json 写 {"adb": true} 才启用。只覆盖 adb 做得到的动作：
// 打开网址/应用、点按、滑动、按键、输入（仅 ASCII）、读界面（uiautomator dump）、截图。
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const ADB_CAPS = ["apps", "screen"];

function findAdb() {
  const cands = [process.env.ADB, process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools", "adb.exe"), "C:\\Android\\Sdk\\platform-tools\\adb.exe"].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || "adb";
}

export function createAdbAdapter({ enabled = () => false, run } = {}) {
  const bin = findAdb();
  const exec = run || ((args, { encoding = "utf8", timeout = 20000 } = {}) => new Promise((resolve, reject) => {
    execFile(bin, args, { encoding, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout));
  }));
  let devices = [], checkedAt = 0;

  async function refresh() {
    if (!enabled()) { devices = []; return devices; }
    if (Date.now() - checkedAt < 5000) return devices;
    checkedAt = Date.now();
    try {
      const out = await exec(["devices"]);
      devices = String(out).split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device").map((p) => p[0]);
    } catch { devices = []; }
    return devices;
  }

  let lastTree = [];
  async function readScreen(serial) {
    await exec(["-s", serial, "shell", "uiautomator", "dump", "/sdcard/yuanshu-ui.xml"]);
    const xml = String(await exec(["-s", serial, "shell", "cat", "/sdcard/yuanshu-ui.xml"]));
    lastTree = parseUiXml(xml);
    return { source: "adb", elements: lastTree.map(({ cx, cy, ...e }) => e) };
  }

  async function act(serial, cmd, a) {
    const sh = (...args) => exec(["-s", serial, "shell", ...args]);
    switch (cmd) {
      case "open_url": await sh("am", "start", "-a", "android.intent.action.VIEW", "-d", `'${String(a.url).replace(/'/g, "")}'`); return { ok: true };
      case "open_app": await sh("monkey", "-p", String(a.app).replace(/[^\w.]/g, ""), "-c", "android.intent.category.LAUNCHER", "1"); return { ok: true, note: "adb 模式下 app 需要是包名" };
      case "screen_read": return readScreen(serial);
      case "tap": {
        let x = a.x, y = a.y;
        if (a.elementId !== undefined) { const el = lastTree.find((e) => e.id === String(a.elementId)); if (!el) throw new Error("控件编号已失效，请先 screen_read"); x = el.cx; y = el.cy; }
        await sh("input", "tap", String(Math.round(x)), String(Math.round(y))); return { ok: true };
      }
      case "type": {
        if (/[^\x20-\x7e]/.test(a.text)) throw new Error("adb 只能输入英文/数字，中文需要 App 的屏幕操作能力");
        if (a.elementId !== undefined) await act(serial, "tap", { elementId: a.elementId });
        await sh("input", "text", `'${String(a.text).replace(/'/g, "").replace(/ /g, "%s")}'`); return { ok: true };
      }
      case "swipe": {
        const v = { up: [540, 1600, 540, 600], down: [540, 600, 540, 1600], left: [900, 1000, 180, 1000], right: [180, 1000, 900, 1000] }[a.direction];
        await sh("input", "swipe", ...v.map(String), "300"); return { ok: true };
      }
      case "key": await sh("input", "keyevent", { back: "4", home: "3", recents: "187", notifications: "83" }[a.key] || "4"); return { ok: true };
      case "screenshot": {
        const buf = await exec(["-s", serial, "exec-out", "screencap", "-p"], { encoding: "buffer", timeout: 30000 });
        return { png: Buffer.from(buf).toString("base64") };
      }
      case "stop": return { ok: true };
      default: throw new Error(`adb 模式不支持 ${cmd}，需要手机上的元枢 App`);
    }
  }

  return {
    enabled, refresh, act,
    status: () => ({ enabled: !!enabled(), devices: [...devices] }),
  };
}

/** uiautomator 的 XML → 编号控件表（只留有文字/可点/可输入的）。 */
export function parseUiXml(xml) {
  const out = [];
  let n = 0;
  for (const m of String(xml).matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attr = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attr[a[1]] = a[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr.bounds || "");
    if (!b) continue;
    const text = attr.text || attr["content-desc"] || "";
    const clickable = attr.clickable === "true", editable = /EditText/.test(attr.class || "");
    if (!text && !clickable && !editable) continue;
    if (attr.password === "true") continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue;
    out.push({ id: String(++n), text: text.slice(0, 120), type: String(attr.class || "").split(".").pop(), clickable, editable, bounds: [x1, y1, x2, y2], cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 });
    if (n >= 150) break;
  }
  return out;
}
