// ══════════════════════════════════════════════════════════
// engine/ppt-refine.mjs —— AI 辅助改页：对话式单页重设计（人在场迭代）
// SSE 事件：note / tool / tool_end / page_html / lint / done
// 路径校验复用 gallery-core.readDeck（内建 workshop-out 限定）
// ══════════════════════════════════════════════════════════
import path from "node:path";
import fs from "node:fs";
import { readDeck } from "./gallery-core.mjs";
import { lintPage } from "./slides-lint-core.mjs";
import { readThemeCss } from "./ppt-html-paths.mjs";
import { pickWorkshopModel } from "./workshop-model.mjs";

/** 客户端断开时调用 stop；返回 release，正常结束时摘掉监听以免二次 stop。 */
export function attachSseAbort(req, stop) {
  if (!req || typeof req.once !== "function") return () => {};
  let done = false;
  const fire = () => { if (done) return; done = true; try { stop(); } catch {} };
  req.once("close", fire);
  return () => {
    done = true;
    try { req.off?.("close", fire); } catch {}
  };
}

export async function handlePptRefine(ctx, res, body) {
  const { json, WS_ROOT, SESSIONS_DIR, defaultModel, createSessionAgent, SessionManager, sseWrite, req } = ctx;
  const dir = String(body?.dir || "");
  const file = String(body?.file || "");
  const instruction = String(body?.instruction || "").trim().slice(0, 600);
  if (!instruction) return json(res, 400, { error: "缺少修改意见" });
  const deck = readDeck(path.join(WS_ROOT, "workshop-out"), dir); // 路径校验内建
  if (!deck) return json(res, 404, { error: "作品不存在或路径无效" });
  const page = deck.pages.find(p => p.file === file);
  if (!page) return json(res, 404, { error: "页面不存在" });
  const idx = deck.pages.indexOf(page);
  const keyMatch = page.html.match(/theme-([\w-]+)/);
  const themeKey = keyMatch ? keyMatch[1] : "";
  const themeCss = readThemeCss(themeKey);
  const absFile = path.join(WS_ROOT, ...dir.split("/"), ...file.split("/"));
  const oldHtml = page.html;

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const write = (event, data) => { try { sseWrite(res, event, data); } catch {} };
  const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, 15_000); // 外网保活
  write("note", { text: `🤖 开始修改「${page.title || file}」：${instruction}` });

  const sm = SessionManager.create(WS_ROOT, SESSIONS_DIR);
  let agent = null, timer = null, ended = false;
  const releaseAbort = attachSseAbort(req, () => finish(false, "客户端断开"));
  const finish = (ok, msg) => {
    if (ended) return;
    ended = true;
    releaseAbort();
    clearInterval(hb);
    clearTimeout(timer);
    try { agent?.abort?.(); } catch {}
    try { agent?.dispose?.(); } catch {}
    let html = "";
    try { html = fs.existsSync(absFile) ? fs.readFileSync(absFile, "utf8") : ""; } catch { /* 读回失败按未变更 */ }
    if (ok && html && html !== oldHtml) {
      const lint = lintPage(html, themeCss);
      write("page_html", { file, html });
      write("lint", { file, issues: lint });
      write("done", { ok: true, changed: true, lintCount: lint.length });
    } else {
      write("done", { ok, changed: false, message: msg || (ok ? "页面未变化" : "修改未完成") });
    }
    try { res.end(); } catch {}
  };
  timer = setTimeout(() => finish(false, "超时（8 分钟）"), 8 * 60 * 1000);
  try {
    agent = await createSessionAgent(sm, pickWorkshopModel(ctx, body) || defaultModel);
    const unsub = agent.subscribe((ev) => {
      try {
        if (ev.type === "tool_execution_start") write("tool", { name: ev.toolName, id: ev.toolCallId });
        else if (ev.type === "tool_execution_end") write("tool_end", { name: ev.toolName, id: ev.toolCallId, isError: !!ev.isError });
      } catch {}
    });
    const ctxPages = deck.pages.map((p, i) => `${i + 1}.${p.title || p.file}${i === idx ? "（当前页）" : ""}`).join("；");
    const prompt = [
      "你是 ppt-html 技能的执行者。用户对一张设计稿页面提出修改意见，**只改这一页，不要动其他任何文件**。",
      "",
      `修改意见：${instruction}`,
      "",
      "上下文：",
      `- 作品页序：${ctxPages}`,
      "- 当前页（完整 HTML）：",
      "```html",
      oldHtml,
      "```",
    ];
    if (themeCss) prompt.push("- 主题 CSS（保持主题变量与气质，每页内嵌）：", "```css", themeCss, "```");
    else prompt.push("- 保持页内现有主题类与配色");
    prompt.push(
      "",
      "硬规矩：",
      "1. 仍然是一张 1280×720 自包含 HTML 画布（零外链、内嵌全部 CSS/JS）",
      `2. 保持 body.theme-${themeKey || "…"} 类、data-page 属性与 data-field 文案打标（可按需增删字段）`,
      "3. 落实用户修改意见为主，其余保持稳定，不做无关重构",
      "4. 完成后用 write 工具把**完整新 HTML** 写到（正斜杠路径）：",
      absFile.split(path.sep).join("/"),
      "5. 不要长篇说明，一两句话即可",
    );
    await agent.prompt(prompt.join("\n"));
    clearTimeout(timer);
    try { unsub?.(); } catch {}
    finish(true);
  } catch (e) {
    clearTimeout(timer);
    finish(false, String(e?.message || e).slice(0, 120));
  }
}
