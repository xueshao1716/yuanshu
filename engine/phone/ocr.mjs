// 截图识字（2026-11-21）：微信、小程序、游戏这类界面无障碍读不到控件树（screen_read 返回空），
// 而常用的快模型又看不了图——截了图也等于没看。这里在电脑上用 Windows 自带 OCR 把截图变成
// 「文字 + 位置」，给模型一份和控件表同样用法的列表（编号 o1、o2…，tap 这个编号就点文字中心）。
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "ocr-image.ps1");

/** 默认实现：只在 Windows 上可用；别的系统返回 null（调用方当作「识别不了」）。 */
export function ocrImage(file, { run } = {}) {
  if (!run && process.platform !== "win32") return Promise.resolve(null);
  const exec = run || ((args) => new Promise((resolve, reject) => {
    execFile("powershell", args, { encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout));
  }));
  return exec(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Path", file])
    .then((out) => { try { return JSON.parse(String(out).trim()); } catch { return null; } })
    .catch(() => null);
}

/**
 * OCR 结果 → 控件表同款的元素列表。scale 是截图相对真实屏幕的缩放（手机端宽于 1080 会缩），
 * bounds 换回屏幕坐标，tap 才点得准。去掉状态栏和元枢自己的「正在操作」浮条。
 */
export function ocrElements(result, scale = 1) {
  const s = scale > 0 ? scale : 1;
  const out = [];
  const statusBar = (Number(result?.height) || 0) * 0.035; // 顶部状态栏（时间、网速、电量）没用
  for (const l of result?.lines || []) {
    const text = String(l?.text || "").trim();
    if (!text || /元枢正在操作/.test(text) || Number(l?.bounds?.[3]) < statusBar) continue;
    const b = (l.bounds || []).map((v) => Math.round(Number(v) / s));
    if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) continue;
    out.push({ text, bounds: b });
  }
  // 从上到下、从左到右，和人读屏的顺序一致
  out.sort((a, b) => (Math.abs(a.bounds[1] - b.bounds[1]) < 12 ? a.bounds[0] - b.bounds[0] : a.bounds[1] - b.bounds[1]));
  return out.map((e, i) => ({ id: `o${i + 1}`, ...e }));
}

/** 编号 → 中心点；找不到返回 null。 */
export function ocrCenter(elements, id) {
  const e = (elements || []).find((x) => x.id === id);
  if (!e) return null;
  const [l, t, r, b] = e.bounds;
  return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) };
}
