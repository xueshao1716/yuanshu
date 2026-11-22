// ===== app-release.mjs —— 手机端新版本提醒（2026-11-20）=====
//
// 网页/桌面端的「发现新版本」比的是电脑上的代码提交，手机 APK 有没有新版 App 自己不知道，
// 只能口头通知。这里读工作区「安装包」目录里版本号最高的 元枢-vX.Y.Z-arm64.apk，
// App 拿自己的 versionName 来比，较新就提示一键下载安装。
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { json } from "./http-utils.mjs";

const APK_RE = /^元枢-v(\d+)\.(\d+)\.(\d+)-arm64\.apk$/;

export function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((n) => Number(n) || 0);
  const pb = String(b || "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** 安装包目录里版本最高的 APK；没有就 null。 */
export function latestApk(dir) {
  let best = null;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const name of names) {
    const m = APK_RE.exec(name);
    if (!m) continue;
    const version = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
    if (best && compareVersions(version, best.version) <= 0) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile() && st.size > 0) best = { version, name, size: st.size, builtAt: st.mtime.toISOString() };
    } catch {}
  }
  return best;
}

// notify：最近一个标了「大更新」的版本（version.json，见 auto-update.mjs）。App 只在
// 自己比它旧时弹窗；更小的版本不打扰，只在「更多」菜单里留个入口。
export function createAppReleaseRoutes(dir, readNotify = () => "") {
  return [
    ["GET", "/api/app/latest", (res) => {
      const apk = latestApk(dir);
      let notify = "";
      try { notify = String(readNotify() || ""); } catch {}
      return json(res, 200, apk ? { ok: true, notify, android: { ...apk, url: "/api/app/apk" } } : { ok: true, notify, android: null });
    }],
    // 只给最新那一个，不接受文件名参数：不会被拿来读目录里别的文件
    ["GET", "/api/app/apk", async (res) => {
      const apk = latestApk(dir);
      if (!apk) return json(res, 404, { error: "安装包目录里还没有 APK" });
      res.writeHead(200, {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Length": apk.size,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(apk.name)}`,
        "Cache-Control": "no-store",
      });
      try { await pipeline(fs.createReadStream(path.join(dir, apk.name)), res); } catch { res.destroy(); }
    }],
  ];
}
