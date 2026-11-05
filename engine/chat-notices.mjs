// ===== chat-notices.mjs —— 公告/版本提示拉取（2026-11-05 从 unified-chat.mjs 拆出）=====
//
// 只做一件事：从 GitHub 拉 release 列表并缓存，给前端"有新版本"提示用。
// 与其他对话逻辑无耦合；缓存只在内存里，失败也缓存空列表防限流。
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { json } from "./http-utils.mjs";

export let noticesCache = null;
export async function handleNotices(res) {
  let releases;
  const now = Date.now();
  if (noticesCache && now - noticesCacheAt < NOTICES_TTL) {
    releases = noticesCache;
  } else {
    releases = [];
    try {
      const py = `import urllib.request, json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
try:
    req = urllib.request.Request("https://api.github.com/repos/earendil-works/pi/releases?per_page=8", headers={"User-Agent":"yuanshu","Accept":"application/vnd.github+json"})
    data = json.loads(urllib.request.urlopen(req, timeout=20).read())
    for r in data:
        print(json.dumps({"tag": r.get("tag_name",""), "name": r.get("name",""), "date": (r.get("published_at") or "")[:10], "body": (r.get("body") or "")[:300]}, ensure_ascii=False))
except Exception as e:
    print("ERR:" + str(e))`;
      const out = await new Promise((resolve, reject) => execFile("python", ["-c", py], { timeout: 30000, windowsHide: true, encoding: "utf8" }, (err, stdout) => err ? reject(err) : resolve(stdout)));
      for (const line of out.trim().split("\n").filter(Boolean)) {
        if (line.startsWith("ERR:")) { console.log("[元枢] GitHub 拉取失败:", line.slice(4).slice(0, 60)); continue; }
        try { releases.push(JSON.parse(line)); } catch {}
      }
    } catch {}
    // 失败也缓存（空列表），限流期不反复打 GitHub
    noticesCache = releases;
    noticesCacheAt = now;
    console.log(`[元枢] 更新看板缓存刷新（${releases.length} 条 release，缓存 ${NOTICES_TTL/3600000}h）`);
  }
  let piVersion = "?";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(_piPackage), "..", "package.json"), "utf8"));
    piVersion = pkg.version || "?";
  } catch {}
  // 元枢自身更新日志（CHANGELOG.md 最近 5 个版本，每个最多 6 行）
  let changelog = [];
  try {
    const cl = fs.readFileSync(path.join(import.meta.dirname, "..", "CHANGELOG.md"), "utf8");
    const blocks = [...cl.matchAll(/##\s+\[?v?([\d.]+)\]?[^\n]*\n([\s\S]*?)(?=\n##\s|\s*$)/g)];
    changelog = blocks.slice(0, 5).map(b => ({ version: b[1], lines: b[2].trim().split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")).slice(0, 6) }));
  } catch {}
  json(res, 200, { releases, piVersion, capabilities: CAPABILITIES, appVersion: APP_VERSION, changelog });
}

// SSE 心跳：每 20s 发注释行保持连接活跃（对抗公网隧道/代理的 idle 超时）

// 统一通道：所有模型走 unifiedChat（对话 + 工具 + 思考 + 媒体 + 压缩 + 重试）
