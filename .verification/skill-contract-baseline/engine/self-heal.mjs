// engine/self-heal.mjs —— 自愈修复/在线更新/设计器对比（2026-08-20 从 server.mjs 拆出）
// 依赖注入：initSelfHeal({ directChat, runGit, cwd, getModelList, getDefaultModel, _repairFiles })
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { json } from "./http-utils.mjs";
import { wsSafePath } from "./workspace-api.mjs";
import { loadProjectRules } from "./context-loader.mjs";
import { createSessionAgent } from "./session-manager.mjs";

// 修复前留底的源码清单（2026-08-20 拆模块时随块迁入本模块；路径相对 repoRoot()）
const REPAIR_BACKUP_FILES = [
  "server.mjs", "config.mjs", "public/index.html",
  "engine/workshop.mjs", "engine/memory.mjs", "engine/emotion.mjs", "engine/sanitize.mjs",
  "engine/filebox.mjs", "engine/browser.mjs", "engine/search-web.mjs",
];

let _directChat = null, _runGit = null, _cwd = "", _getModelList = () => [], _getDefaultModel = () => null, _piPackage = "";
let _SessionManager = null, _sessionsDir = "";
export function repoRoot() {
  return path.resolve(import.meta.dirname, "..");
}
export function initSelfHeal({ directChat = null, runGit = null, cwd = "", getModelList = null, getDefaultModel = null, piPackage = "", SessionManager = null, sessionsDir = "" } = {}) {
  _directChat = directChat; _runGit = runGit; _cwd = cwd; if (getModelList) _getModelList = getModelList; if (getDefaultModel) _getDefaultModel = getDefaultModel; _piPackage = piPackage;
  if (SessionManager) _SessionManager = SessionManager;
  if (sessionsDir) _sessionsDir = sessionsDir;
}

// ══ 自愈修复 ══
let repairBusy = false;

// 修复前检查点：把修复可能触碰的源码备份到 backups/repair-<ts>/，改坏可回滚（对标 /refine 的回滚能力）
export function createRepairCheckpoint() {
  try {
    const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const root = repoRoot();
    const dir = path.join(root, "backups", "repair-" + ts);
    fs.mkdirSync(dir, { recursive: true });
    for (const rel of REPAIR_BACKUP_FILES) {
      const src = path.join(root, rel);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(dir, rel.replace(/[\\/]/g, "__")));
    }
    for (const sub of ["js", "css"]) {
      const srcDir = path.join(root, "public", sub);
      if (!fs.existsSync(srcDir)) continue;
      const dstDir = path.join(dir, "public-" + sub);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const f of fs.readdirSync(srcDir)) {
        try { fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f)); } catch {}
      }
    }
    return { dir };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 120) };
  }
}

// ══ 在线更新（git pull + 重启）══
// 检查更新：对比本地 HEAD 和远程 origin/main
// ⚠️ 代理根治：本机 git 全局/系统代理可能指向未运行的 7890（死代理）→ git 全卡死。
//    git 命令统一加 -c http.proxy= -c https.proxy= 绕过系统代理直连。
const GIT_NO_PROXY = ["-c", "http.proxy=", "-c", "https.proxy="];
export async function handleUpdateCheck(res) {
  try {
    const { execFile } = await import("node:child_process");
    const run = (args) => new Promise((resolve) => {
      execFile("git", ["-C", import.meta.dirname, ...GIT_NO_PROXY, ...args], { encoding: "utf8", timeout: 20000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || "").trim() }));
    });
    const [localR, remoteR, behindR] = await Promise.all([
      run(["rev-parse", "HEAD"]),
      run(["ls-remote", "origin", "refs/heads/main"]),
      run(["rev-list", "--count", "HEAD..origin/main"]),
    ]);
    const local = localR.ok ? localR.out : "";
    const remote = remoteR.ok ? remoteR.out.split(/\s+/)[0] : "";
    const behind = behindR.ok ? parseInt(behindR.out, 10) || 0 : 0;
    // 后端 pi 引擎版本：本地 vs npm 最新（用 CONFIG.piPackage 定位引擎包）
    let engineLocal = "", engineLatest = "";
    try {
      if (_piPackage) {
        const pkgPath = path.join(path.dirname(_piPackage), "..", "package.json");
        if (fs.existsSync(pkgPath)) {
          const v = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
          if (v) engineLocal = String(v);
        }
      }
    } catch {}
    try {
      engineLatest = await new Promise((resolve) => {
        execFile("cmd.exe", ["/c", "npm view @earendil-works/pi-coding-agent version"], { encoding: "utf8", timeout: 20000, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout || "").trim()));
      });
    } catch {}
    json(res, 200, {
      ok: true,
      local: local.slice(0, 8),
      remote: remote.slice(0, 8),
      behind,
      upToDate: behind === 0,
      hasRemote: !!remote && remote !== local,
      // 引擎（后端）
      engineLocal,
      engineLatest,
      engineOutdated: !!(engineLocal && engineLatest && engineLocal !== engineLatest),
    });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e).slice(0, 100) });
  }
}

// 执行更新：git fetch + pull，然后提示重启
export async function handleUpdateApply(res, body) {
  try {
    const { execFile, spawn } = await import("node:child_process");
    const run = (args) => new Promise((resolve) => {
      execFile("git", ["-C", import.meta.dirname, ...GIT_NO_PROXY, ...args], { encoding: "utf8", timeout: 60000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || "").trim(), err: String(err?.message || "").slice(0, 200) }));
    });
    const msgs = [];
    // 1. 引擎升级（如需）
    if (body?.engine) {
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"; // Windows 上 npm 是 .cmd，execFile 直接 spawn 会 ENOENT
      const engUp = await new Promise((resolve) => {
        execFile(npmCmd, ["i", "-g", "@earendil-works/pi-coding-agent@latest"], { encoding: "utf8", timeout: 180000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || "").trim(), err: String(err?.message || "").slice(0, 200) }));
      });
      if (engUp.ok) msgs.push("引擎已升级");
      else return json(res, 500, { error: "引擎升级失败: " + engUp.err });
    }
    // 2. 前端 git 拉取（只拉不合并，避免本地改动冲突；若干净直接 pull）
    const fetchR = await run(["fetch", "origin"]);
    if (!fetchR.ok) return json(res, 500, { error: "fetch 失败: " + fetchR.err });
    const pullR = await run(["pull", "--ff-only", "origin", "main"]);
    if (!pullR.ok) {
      return json(res, 409, { error: "拉取冲突: " + pullR.err + "（本地有未提交改动，请先处理）" });
    }
    msgs.push("前端已更新");
    // 更新成功 → 后台重启服务（detached，当前进程退出由 watchdog 接管）
    const { execSync } = await import("node:child_process");
    try { execSync(`taskkill /F /PID ${process.pid}`, { windowsHide: true }); } catch {}
    json(res, 200, { ok: true, message: "更新成功（" + msgs.join(" + ") + "），服务重启中…（约 10 秒）" });
    // 延迟触发重启：由 watchdog 检测到服务挂了自动拉起新代码
    setTimeout(() => { try { process.exit(0); } catch {} }, 1500);
  } catch (e) {
    json(res, 500, { error: String(e?.message || e).slice(0, 100) });
  }
}

export async function handleRepair(res, body) {
  const issue = String(body?.issue || "").trim();
  if (!issue) return json(res, 400, { error: "缺少问题描述" });
  if (repairBusy) return json(res, 409, { error: "已有修复任务进行中" });
  repairBusy = true;
  // write 提到 try 外：catch 也要用它回错误事件，且 res.writeHead 抛错时不能再引用未定义变量
  const write = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
  // 成功路径随即重启进程，无需复位；其余路径（含 writeHead 抛错）必须复位，否则 /api/repair 永久 409
  let restartScheduled = false;
  try {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(":\n\n");
    // 修复前检查点：先留底，改坏可回滚（对标 /refine 的回滚能力）
    const cp = createRepairCheckpoint();
    const cpMsg = cp.error ? `⚠️ 检查点创建失败: ${cp.error}` : `修复前检查点已保存：${cp.dir}`;
    write("delta", { text: `🛡 ${cpMsg}\n` });
    const sm = _SessionManager.create(_cwd, _sessionsDir);
    const agent = await createSessionAgent(sm, _getDefaultModel());
    write("delta", { text: "🧠 正在分析代码并修复…\n" });
    const root = repoRoot();
    const repairPrompt = [
      `你是元枢（${root}）的修复工程师。用户报告了问题：`,
      issue,
      "",
      "请：",
      "1. 用 read 工具检查 server.mjs / public/index.html 相关代码",
      "2. 定位并修复问题",
      "3. 用 bash 运行 node --check server.mjs 验证语法",
      "4. 完成后回复「修复完成」并简述改了什么",
      "",
      `注意：只修改 ${root} 下的文件，不要动 node_modules。`,
      `修复前检查点：${cp.dir ? `已保存到 ${cp.dir}（改坏的话把该目录文件复制回 ${root} 即可回滚，也可用 git 恢复）` : "创建失败（" + (cp.error || "未知") + "），改动用 git 跟踪，改坏可用 git checkout 恢复"}`,
      "修复前先读 工程/经验库/experience.md 是否有同类踩坑，避免重复犯错；修复完成后按经验库格式沉淀本次问题的根因与解法（1-3 条，每条 3 行内），并在回复末尾注明已沉淀的经验。",
    ].join("\n");
    const reply = await agent.prompt(repairPrompt);
    write("delta", { text: "\n" + String(reply || "").slice(0, 800) + "\n" });
    write("delta", { text: `\n✅ 修复完成，重启服务中…（页面会自动恢复）\n🛡 回滚方式：${cp.error ? "检查点创建失败，请用 git 恢复" : `复制 ${cp.dir} 内文件回 ${root}`}` });
    write("done", { repair: true });
    restartScheduled = true;
    setTimeout(() => {
      console.log("[元枢] 自愈重启…");
      try { spawn(process.execPath, [process.argv[1]], { detached: true, stdio: "ignore" }); } catch {}
      setTimeout(() => { try { process.exit(0); } catch {} }, 900);
    }, 1500);
  } catch (e) {
    write("error", { message: String(e?.message || e).slice(0, 300) });
  } finally {
    if (!restartScheduled) repairBusy = false;
  }
}

// ══ 可视化设计器：AI 生成页面 ══
export async function handleDesignerGenerate(res, body) {
  const promptText = String(body?.prompt || "").trim();
  if (!promptText) return json(res, 400, { error: "缺少描述" });
  try {
    const fullPrompt = `你是资深网页设计师。根据需求生成一个完整、自包含的 HTML 页面。

需求：${promptText}

要求：
- 输出完整的 <!DOCTYPE html> 代码，样式全部内联在 <style> 标签里
- 现代美观的设计，配色协调，有层次感，移动端也能看（用简单的响应式）
- 不要使用外部图片链接（用 CSS 渐变、纯色、或 data URI 占位）
- 可以直接在浏览器打开预览
- 只输出 HTML 代码，不要任何解释、不要 markdown 代码围栏`;
    const result = await _directChat(_getDefaultModel(), fullPrompt);
    const raw = String(result?.text || "").trim();
    if (!raw) return json(res, 500, { error: "模型未返回内容，请重试" });
    const m = raw.match(/```html\s*([\s\S]*?)```/);
    const html = (m ? m[1] : raw).trim();
    if (!html.includes("<!DOCTYPE") && !html.includes("<html")) return json(res, 500, { error: "模型未返回 HTML" });
    json(res, 200, { html });
  } catch (e) { json(res, 500, { error: String(e?.message || e).slice(0, 150) }); }
}

// POST /api/designer/save —— 保存页面到工程
export async function handleDesignerSave(res, body) {
  const { project, filename, html } = body || {};
  const clean = String(project || "").replace(/[\/:*?"<>|\s]+/g, "-").slice(0, 60);
  const fname = String(filename || "index.html").replace(/[\/:*?"<>|]+/g, "-").slice(0, 60);
  if (!clean || !html) return json(res, 400, { error: "缺少项目名或内容" });
  const safe = wsSafePath(path.join("工程", clean, fname));
  if (!safe) return json(res, 403, { error: "路径越权" });
  try {
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, html, "utf8");
    json(res, 200, { ok: true, path: "工程/" + clean + "/" + fname });
  } catch (e) { json(res, 500, { error: String(e?.message || e).slice(0, 100) }); }
}

// 多模型对比（借鉴 Open WebUI：同一问题同时问多个模型，结果并排展示）
export async function handleCompare(res, body) {
  const message = String(body?.message || "").trim();
  const models = Array.isArray(body?.models) ? body.models.slice(0, 12) : [];
  if (!message) return json(res, 400, { error: "消息不能为空" });
  if (!models.length) return json(res, 400, { error: "至少选择一个模型" });
  const tasks = models.map(async (mk) => {
    const m = _getModelList().find(x => x.provider === mk.provider && x.id === mk.id);
    if (!m) return { provider: mk.provider, id: mk.id, error: "模型未找到" };
    const t0 = Date.now();
    try {
      const rules = loadProjectRules();
      const history = rules.length ? [{ role: "system", content: rules.join("\n") }] : [];
      const r = await _directChat(m, message, history);
      return { provider: m.provider, id: m.id, text: r?.text || "（无回复）", ms: Date.now() - t0, error: r?.error };
    } catch (e) {
      return { provider: m.provider, id: m.id, error: String(e?.message || e).slice(0, 100), ms: Date.now() - t0 };
    }
  });
  const results = await Promise.all(tasks);
  json(res, 200, { message, results });
}
