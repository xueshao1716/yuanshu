// ══ 专项工作台模块（从 server.mjs 拆出：新专项功能在此扩展，不再塞 server.mjs）══
// 设计：依赖注入（ctx 由 server.mjs 提供），无反向 import，避免循环依赖
// 新增专项（文章/视频）：照 handleWorkshopPpt 复制，改 skill 名 + 表单字段 + 产物后缀即可
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateSlides, findSlidesJson, appendHistory, readHistory, selectPptArtifact } from "./workshop-ppt-core.mjs";
import { lintDeck, lintPage } from "./slides-lint-core.mjs";
import { fillHtmlBrief, formatHtmlBriefBlock, lintDeckBrief } from "./workshop-html-brief.mjs";
import { loadAndPersistDeck } from "./workshop-html-deck.mjs";
import { readThemeCss } from "./ppt-html-paths.mjs";
import { pickWorkshopModel } from "./workshop-model.mjs";
import { attachSseAbort } from "./ppt-refine.mjs";
export { handlePptRefine } from "./ppt-refine.mjs";

// 工作台独立页映射（可直达 URL）
export const WORKSHOP_PAGES = {
  "/workspace": "workspace.html",
  "/workshop": "workshop.html",
  "/workshop/modelbench": "workshop-modelbench.html",
  "/workshop/ppt": "workshop-ppt.html",
  "/workshop/designer": "workshop-designer.html",
  "/workshop/wanxiang": "workshop-wanxiang.html",
  "/workshop/image": "workshop-image.html",
  "/workshop/novel": "workshop-novel.html",
  "/workshop/refine": "workshop-refine.html",
  "/workshop/article": "workshop-article.html",
  "/workshop/video": "workshop-video.html",
  "/workshop/omega": "workshop-omega.html",
};

// 按技能名找文件路径（供注入 agent 自行 read SKILL.md）
export async function findSkillPath(ctx, name) {
  try {
    const loader = new ctx.DefaultResourceLoader({ cwd: ctx.CONFIG.cwd, agentDir: ctx.getAgentDir() });
    await loader.reload();
    const { skills } = loader.getSkills();
    const s = (skills || []).find(x => x.name === name);
    if (s?.filePath) return s.filePath;
  } catch {}
  // 回退：多目录搜索（兼容适配器扫描范围外的地方装技能）——技能仓库可能新增，候选逐个探测
  const here = path.dirname(fileURLToPath(import.meta.url));
  const os = await import("node:os");
  const fallbackDirs = [
    path.join(here, "skills"),                            // engine/skills/
    path.join(here, "..", "skills"),                      // 仓库根 skills/（novel-forge-v10）
    ctx?.CONFIG?.cwd ? path.join(ctx.CONFIG.cwd, "skills") : "",
    path.join(os.homedir(), ".agents", "skills"),          // 用户级 .agents/skills/（ppt-generator 等在这）
    process.env.PI_SKILL_EXTRA_DIR || "",
    process.env.PI_NOVEL_FORGE_DIR || "",
  ].filter(Boolean);
  for (const dir of fallbackDirs) {
    try {
      const p = path.join(dir, name, "SKILL.md");
      if (fs.existsSync(p)) return p;
      // 技能目录可能就是 SKILL.md 直接放根（如 novel-forge-v10）
      if (path.basename(dir) === name && fs.existsSync(path.join(dir, "SKILL.md"))) return path.join(dir, "SKILL.md");
    } catch {}
  }
  return "";
}

// ══ PPT 工作室：创建独立 agent → 注入 ppt-generator 技能指令 → 七角色生成 JSON → 脚本产 .pptx → SSE 流式 ══
export async function handleWorkshopPpt(ctx, res, body) {
  const { CONFIG, SESSIONS_DIR, defaultModel, createSessionAgent, SessionManager, scanRecentArtifacts, sseWrite, json, getAgentDir, DefaultResourceLoader, WS_ROOT, req } = ctx;
  const theme = String(body?.theme || "").trim();
  if (!theme) return json(res, 400, { error: "缺少主题" });
  const pages = Math.min(Math.max(parseInt(body?.pages, 10) || 10, 3), 25);
  const style = String(body?.style || "专业商务").slice(0, 20);
  const audience = String(body?.audience || "").slice(0, 40);
  const picked = pickWorkshopModel(ctx, body) || defaultModel;
  const skillPath = await findSkillPath(ctx, "ppt-generator");
  if (!skillPath) return json(res, 500, { error: "未找到 ppt-generator 技能" });
  // findSkillPath 返回 SKILL.md 文件路径（loader 的 filePath 是文件）→ skillDir 才是技能根目录
  const skillDir = path.dirname(skillPath);
  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  });
  const write = (event, data) => { try { sseWrite(res, event, data); } catch {} };
  write("note", { text: `📊 开始制作 PPT「${theme}」（${pages} 页 · ${style}）…` });
  const sm = SessionManager.create(CONFIG.cwd, SESSIONS_DIR);
  let agent = null;
  let timer = null;
  let finished = false;
  try {
    agent = await createSessionAgent(sm, picked);
    write("note", { text: "🧠 已启动七角色协作流程（主题→模板→内容→配图→润色→构建）…" });
    const unsub = agent.subscribe((ev) => {
      try {
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          write("delta", { text: ev.assistantMessageEvent.delta });
        } else if (ev.type === "tool_execution_start") {
          write("tool", { name: ev.toolName, args: ev.args, id: ev.toolCallId });
        } else if (ev.type === "tool_execution_end") {
          const text = Array.isArray(ev.result?.content) ? ev.result.content.map(c => c.text || "").join("") : "";
          write("tool_end", { name: ev.toolName, id: ev.toolCallId, isError: !!ev.isError, output: text.slice(0, 500) });
        }
      } catch {}
    });
    const id = Date.now().toString(36);
    // ⚠️ Windows 下中文路径会被 bash/python 子进程编码打乱(GBK/UTF-8) → 脚本写不出产物。
    // 工作目录改用纯 ascii(不掺中文'工程'/主题名)，产物留在 workshop-out(能被资产库扫到，不被 _ 前缀排除)。
    const workDir = path.join(WS_ROOT, "workshop-out", `ppt-${id}`);
    fs.mkdirSync(workDir, { recursive: true });
    const prompt = `你是 ppt-generator 技能的执行者。用户通过「PPT 工作室」提交了表单，请按技能流程**跳过用户确认环节，直接完整执行**：

用户需求：
- 主题：${theme}
- 目标受众：${audience || "（未指定，按通用场景）"}
- 页数：约 ${pages} 页
- 风格：${style}

执行要求：
1. 先 read 技能文件了解完整流程：${skillPath.replace(/\\/g, "/")}
   （以及 references/ppt_structure_guide.md 的 JSON 格式规范，如果它在技能目录下）
2. 按七角色协作生成结构化内容（metadata + slides），产出 JSON 文件
3. 调用技能脚本生成 .pptx：
   python ${path.join(skillDir, "scripts", "generate_pptx.py").replace(/\\/g, "/")} --input <你的JSON路径> --output ${path.join(workDir, "presentation.pptx").replace(/\\/g, "/")}
4. 确认 .pptx 已生成（用 bash 检查文件存在和大小），然后回复一句话总结：主题、页数、文件位置

注意：产物 .pptx 必须生成在 ${workDir.replace(/\\/g, "/")} 目录内。JSON 中间文件可留在同目录。`;
    // 超时兜底（生成可能较慢，给 10 分钟）
    let releaseAbort = () => {};
    const finish = async () => {
      if (finished) return;
      finished = true;
      try { releaseAbort(); } catch {}
      try { unsub(); } catch {}
      try { agent?.abort?.(); } catch {}
      // 先认本轮目录的产物；兼容旧 agent 的全局扫描也必须限制在本轮目录，
      // 避免并发任务同时完成时把别人的 presentation.pptx 交付出去。
      const file = selectPptArtifact(workDir, WS_ROOT, scanRecentArtifacts);
      // 产物留在 ascii 工作区 workshop-out（能被 scanRecentArtifacts 扫到），不回迁避免中文编码风险
      if (file) {
        // 不再回迁到中文'工程'目录（易踩 GBK/UTF-8 编码），产物 path 就是 workshop-out 相对路径
      }
      if (file) {
        write("file", file);
        write("note", { text: `✅ PPT 已生成：${file.name}（${(file.size / 1024).toFixed(0)} KB）` });
        // 2026-09-03：探测 slides JSON → 推前端做结构化预览/设计干预；写生成历史
        try {
          const jsonAbs = findSlidesJson(workDir);
          if (jsonAbs) {
            const rel = path.relative(WS_ROOT, jsonAbs).replace(/\\/g, "/");
            const doc = JSON.parse(fs.readFileSync(jsonAbs, "utf8"));
            if (Array.isArray(doc?.slides) && doc.slides.length) {
              write("json", { path: rel, name: path.basename(jsonAbs), slides: doc.slides, metadata: doc.metadata || {} });
              appendHistory(path.join(WS_ROOT, "workshop-out", "ppt-history.json"), { id, theme, pages, style, file, json: rel });
            }
          }
        } catch { /* 预览/历史是增益，失败不影响主流程 */ }
      } else {
        write("note", { text: "⚠️ 生成流程结束，但未在工作空间检测到 .pptx 产物，请查看上方过程输出" });
      }
      write("done", { ok: !!file, file });
      try { res.end(); } catch {}
      try { agent?.dispose?.(); } catch {}
    };
    releaseAbort = attachSseAbort(req, () => finish());
    timer = setTimeout(finish, 10 * 60 * 1000);
    await agent.prompt(prompt);
    clearTimeout(timer);
    await finish();
  } catch (e) {
    clearTimeout(timer);
    if (finished) return;
    write("error", { message: String(e?.message || e).slice(0, 200) });
    try { agent?.abort?.(); } catch {}
    try { agent?.dispose?.(); } catch {}
    try { res.end(); } catch {}
  }
}

// ══ PPT 设计干预：大纲预览编辑 → 本地秒级重建 .pptx（2026-09-03）══
// 前端在结构化预览卡上改标题/要点/页序后调此端点：服务端校验 → 原子写回 JSON → 重跑 generate_pptx.py（不调 agent，秒级）
export async function rebuildPptx(ctx, res, body) {
  const { json, WS_ROOT, getAgentDir } = ctx;
  const rel = String(body?.jsonPath || "");
  const slides = body?.slides;
  // 路径安全：必须在 WS_ROOT/workshop-out 内
  const outRoot = path.join(WS_ROOT, "workshop-out");
  const abs = path.resolve(WS_ROOT, rel);
  if (!abs.startsWith(outRoot + path.sep)) return json(res, 400, { error: "jsonPath 必须在 workshop-out 内" });
  if (!fs.existsSync(abs)) return json(res, 404, { error: "大纲 JSON 不存在" });
  const v = validateSlides(slides);
  if (!v.ok) return json(res, 400, { error: v.error });
  // 保留 metadata，替换 slides
  let doc = {};
  try { doc = JSON.parse(fs.readFileSync(abs, "utf8")) || {}; } catch {}
  if (!doc.metadata || typeof doc.metadata !== "object") doc.metadata = { title: "presentation" };
  doc.slides = slides;
  const tmp = abs + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, abs);
  // 定位技能脚本（技能可能搬家，走 findSkillPath）
  const skillPath = await findSkillPath(ctx, "ppt-generator");
  if (!skillPath) return json(res, 500, { error: "未找到 ppt-generator 技能脚本" });
  const script = path.join(path.dirname(skillPath), "scripts", "generate_pptx.py");
  if (!fs.existsSync(script)) return json(res, 500, { error: "generate_pptx.py 不存在" });
  const workDir = path.dirname(abs);
  const outPptx = path.join(workDir, "presentation.pptx");
  const r = await new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (code, err) => { if (!settled) { settled = true; resolve({ code, err, out }); } };
    try {
      const p = spawn("python", [script, "--input", abs, "--output", outPptx], { cwd: workDir, windowsHide: true, timeout: 60_000 });
      p.stdout.on("data", d => { out += d; });
      p.stderr.on("data", d => { out += d; });
      p.on("error", e => done(-1, String(e?.message || e)));
      p.on("close", code => done(code, code !== 0 ? out.slice(-400) : ""));
    } catch (e) { done(-1, String(e?.message || e)); }
    setTimeout(() => done(-1, "重建超时（60s）"), 65_000);
  });
  if (r.code !== 0 || !fs.existsSync(outPptx)) {
    return json(res, 500, { error: "重建失败：" + (r.err || r.out || `exit ${r.code}`).slice(-300) });
  }
  const st = fs.statSync(outPptx);
  const file = { name: path.basename(outPptx), path: path.relative(WS_ROOT, outPptx).split(path.sep).join("/"), size: st.size, mime: "", mtimeMs: st.mtimeMs };
  json(res, 200, { ok: true, file, slides });
}

/** PPT 生成历史（最近 50 次，供页面载入往期大纲再编辑/重建）*/
export async function listPptHistory(ctx, res) {
  const { json, WS_ROOT } = ctx;
  const entries = readHistory(path.join(WS_ROOT, "workshop-out", "ppt-history.json"));
  // 摘要化：不回传大 slides（点开单条再按需读）
  json(res, 200, { entries: entries.map(e => ({ id: e.id, ts: e.ts, theme: e.theme, pages: e.pages, style: e.style, file: e.file, json: e.json })) });
}

// ══ PPT 设计稿工作室（HTML 路线，对标扣子/Gamma）：每页一张 1280×720 设计过的 HTML 画布 ══
// 管线：agent 读 ppt-html 技能 → 产 deck.json + pages/*.html → SSE 逐页推 HTML → 前端 iframe 真渲染
// 干预：前端 data-field 文案替换（本地保存回写）+ 单页重设计（agent 重做该页）；导出：浏览器打印 PDF
export async function handleWorkshopPptHtml(ctx, res, body) {
  const { CONFIG, SESSIONS_DIR, defaultModel, createSessionAgent, SessionManager, sseWrite, json, getAgentDir, DefaultResourceLoader, WS_ROOT, req } = ctx;
  const theme = String(body?.theme || "").trim();
  if (!theme) return json(res, 400, { error: "缺少主题" });
  const pages = Math.min(Math.max(parseInt(body?.pages, 10) || 8, 3), 20);
  const themeKey = ["navy", "magazine", "dark", "riso"].includes(body?.themeKey) ? body.themeKey : "navy";
  const audience = String(body?.audience || "").slice(0, 40);
  const brief = fillHtmlBrief({ theme, audience, pages, themeKey, verb: body?.verb, fields: body?.brief });
  const picked = pickWorkshopModel(ctx, body) || defaultModel;
  const skillPath = await findSkillPath(ctx, "ppt-html");
  if (!skillPath) return json(res, 500, { error: "未找到 ppt-html 技能" });
  const skillDir = path.dirname(skillPath);
  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  });
  const write = (event, data) => { try { sseWrite(res, event, data); } catch {} };
  write("note", { text: `🎨 设计稿模式：${pages} 页 · 主题模板 ${themeKey} · 开始排版设计…` });
  // SSE 心跳：每 15s 发注释行防外网空闲超时（Cloudflare ~100s 掐无输出连接）；agent 写一页可达数分钟无事件
  const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, 15_000);
  const sm = SessionManager.create(CONFIG.cwd, SESSIONS_DIR);
  let agent = null;
  let timer = null;
  let finished = false;
  try {
    agent = await createSessionAgent(sm, picked);
    const unsub = agent.subscribe((ev) => {
      try {
        if (ev.type === "tool_execution_start") {
          write("tool", { name: ev.toolName, args: ev.args, id: ev.toolCallId });
        } else if (ev.type === "tool_execution_end") {
          const text = Array.isArray(ev.result?.content) ? ev.result.content.map(c => c.text || "").join("") : "";
          write("tool_end", { name: ev.toolName, id: ev.toolCallId, isError: !!ev.isError, output: text.slice(0, 400) });
        }
      } catch {}
    });
    const id = Date.now().toString(36);
    const workDir = path.join(WS_ROOT, "workshop-out", `ppthtml-${id}`);
    fs.mkdirSync(workDir, { recursive: true });
    const prompt = `你是 ppt-html 技能的执行者。用户通过「PPT 工作室·设计稿模式」提交了表单，**直接完整执行，跳过确认**：

用户需求：
- 主题：${theme}
- 目标受众：${audience || "（未指定，按通用场景）"}
- 页数：${pages} 页左右
- 主题模板：theme-${themeKey}（务必把 ${path.join(skillDir, "templates", `theme-${themeKey}.css`).split(path.sep).join("/")} 的 CSS 全文放进每页 <style> 开头）

${formatHtmlBriefBlock(brief)}

执行要求：
1. 先 read 技能规范：${skillPath.split(path.sep).join("/")}，严格按「每页 HTML 硬规矩 + 排版纪律 + 版式骨架 + 六项 brief」执行
2. 产物全部写入 ${workDir.split(path.sep).join("/")}：deck.json + pages/page-01.html 起（两位数序号）。deck.json 顶层必须有 "verb": "${brief.verb}"
3. 每页都要是"设计过的版面"：一个视觉焦点、字号阶梯、留白充足、accent 克制；图形用 CSS 渐变/几何形，禁止外部图片和 CDN。封面必须让人看出动词「${brief.verb}」，内页不要另起一套动作
4. 写完自检（bash：页数、theme- class、data-page、data-field、文件大小、deck.json 含 verb），然后回复一句话总结：页数 + 动词 + 每页一句话摘要`;
    let releaseAbort = () => {};
    const finish = async () => {
      if (finished) return;
      finished = true;
      try { releaseAbort(); } catch {}
      clearInterval(hb);
      try { unsub(); } catch {}
      try { agent?.abort?.(); } catch {}
      try { agent?.dispose?.(); } catch {}
      // 扫产物：deck.json + pages/*.html，逐页推给前端
      try {
        const { deck, list, deckPath } = loadAndPersistDeck(workDir, { verb: brief.verb });
        if (deck && Array.isArray(deck.slides || deck) && (deck.slides || deck).length) {
          const relDir = path.relative(WS_ROOT, workDir).split(path.sep).join("/");
          write("deck_meta", { dir: relDir, count: list.length, themeKey });
          const deckPages = [];
          for (const item of list) {
            const f = path.join(workDir, item.file);
            if (!fs.existsSync(f)) continue;
            const html = fs.readFileSync(f, "utf8");
            deckPages.push({ file: item.file, html });
            write("deck_page", { file: item.file, title: item.title || "", layout: item.layout || "", html });
          }
          // 硬质检：机械规则检查全 deck，报告落盘 + SSE 推前端
          try {
            const themeCssPath = path.join(skillDir, "templates", `theme-${themeKey}.css`);
            const themeCss = fs.existsSync(themeCssPath) ? fs.readFileSync(themeCssPath, "utf8") : "";
            const report = lintDeck(deckPages, themeCss);
            const briefIssues = lintDeckBrief(deck || {});
            if (briefIssues.length) {
              report.perPage["deck.json"] = briefIssues;
              report.total += briefIssues.length;
            }
            fs.writeFileSync(path.join(workDir, "lint-report.json"), JSON.stringify(report, null, 2));
            write("deck_lint", { dir: relDir, total: report.total, errors: report.errors, ok: report.ok, perPage: report.perPage });
          } catch { /* lint 失败不阳塞交付 */ }
          appendHistory(path.join(WS_ROOT, "workshop-out", "ppt-history.json"), {
            id, theme, pages, style: `html:${themeKey}`, file: { name: "deck.json", path: relDir + "/deck.json", size: fs.statSync(deckPath).size }, json: relDir + "/deck.json", kind: "html",
          });
          write("done", { ok: true, dir: relDir, count: list.length });
        } else {
          write("note", { text: "⚠️ 未检测到 deck.json / pages 产物，请查看过程输出" });
          write("done", { ok: false });
        }
      } catch (e) {
        write("error", { message: String(e?.message || e).slice(0, 200) });
        write("done", { ok: false });
      }
      try { res.end(); } catch {}
    };
    releaseAbort = attachSseAbort(req, () => finish());
    // 兜底按时长缩放：设计稿每页约 3-8 分钟，10 页可达 80 分钟，固定 12 分钟会中途杀 agent
    timer = setTimeout(finish, Math.max(20, pages * 8) * 60 * 1000);
    await agent.prompt(prompt);
    clearTimeout(timer);
    await finish();
  } catch (e) {
    clearTimeout(timer);
    if (finished) return;
    write("error", { message: String(e?.message || e).slice(0, 200) });
    try { agent?.abort?.(); } catch {}
    try { agent?.dispose?.(); } catch {}
    try { res.end(); } catch {}
  }
}

/** 文案干预保存：回写单页 HTML（路径限 workshop-out，内容校验），并同步 deck.json 标题 */
export async function savePptHtmlPage(ctx, res, body) {
  const { json, WS_ROOT } = ctx;
  const rel = String(body?.file || "");
  const html = String(body?.html || "");
  const title = String(body?.title || "").slice(0, 80);
  const outRoot = path.join(WS_ROOT, "workshop-out");
  const abs = path.resolve(WS_ROOT, rel);
  if (!abs.startsWith(outRoot + path.sep)) return json(res, 400, { error: "路径必须在 workshop-out 内" });
  if (!abs.endsWith(".html")) return json(res, 400, { error: "只能保存 HTML" });
  if (!fs.existsSync(abs)) return json(res, 404, { error: "页面文件不存在" });
  if (html.length < 200 || html.length > 200_000) return json(res, 400, { error: "HTML 大小异常" });
  if (!html.includes("<style") || !html.includes("data-page")) return json(res, 400, { error: "HTML 缺少 <style>/data-page，疑似非设计稿页面" });
  const tmp = abs + ".tmp";
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, abs);
  // 同步 deck.json 标题
  try {
    const deckPath = path.join(path.dirname(path.dirname(abs)), "deck.json");
    if (fs.existsSync(deckPath) && title) {
      const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
      const list = deck.slides || deck;
      const item = list.find(x => x.file === path.relative(path.dirname(path.dirname(abs)), abs).split(path.sep).join("/"));
      if (item) item.title = title;
      fs.writeFileSync(deckPath, JSON.stringify(deck, null, 2));
    }
  } catch {}
  // 保存后回带该页硬质检（theme CSS 从页面 theme-<key> class 推断）
  let lint = [];
  try {
    const keyMatch = html.match(/body[.\s][^>]*theme-([\w-]+)/);
    let themeCss = "";
    if (keyMatch) {
      themeCss = readThemeCss(keyMatch[1]);
    }
    lint = lintPage(html, themeCss);
  } catch { /* lint 失败不影响保存 */ }
  json(res, 200, { ok: true, lint });
}
