// ══════════════════════════════════════════════════════════
// engine/distill-theme.mjs —— 网址蒸馏主题：URL/本地HTML → token → theme CSS 入库技能 templates
// 双通道：url（服务端 fetch，10s 超时）/ htmlPath（白名单目录内的本地 HTML，适配登录墙 SPA 另存件）
// ══════════════════════════════════════════════════════════
import path from "node:path";
import fs from "node:fs";
import { extractTokens, classifyColors, buildThemeCss, slugify } from "./distill-theme-core.mjs";
import { resolvePptHtmlTemplates, isInsideSafeHtmlDir } from "./ppt-html-paths.mjs";

const BUILTIN = new Set(["navy", "magazine", "dark", "riso"]);
function templatesDir(ctx) { return ctx.templatesDir || resolvePptHtmlTemplates(); }

export function handlePptThemes(ctx, res) {
  const { json } = ctx;
  let themes = [];
  try {
    for (const f of fs.readdirSync(templatesDir(ctx))) {
      const m = f.match(/^theme-(.+)\.css$/);
      if (!m) continue;
      const head = fs.readFileSync(path.join(templatesDir(ctx), f), "utf8").split("\n")[0] || "";
      const label = head.replace(/^\/\*\s*theme-[^—]*——?\s*/, "").replace(/\s*\*\/\s*$/, "").trim() || m[1];
      themes.push({ key: m[1], label, builtin: BUILTIN.has(m[1]) });
    }
  } catch { /* 目录异常返回空 */ }
  return json(res, 200, { themes });
}

export async function handlePptDistill(ctx, res, body) {
  const { json, WS_ROOT } = ctx;
  const fetch = ctx.fetch || globalThis.fetch;
  const url = String(body?.url || "").trim();
  const htmlPath = String(body?.htmlPath || "").trim();
  const name = String(body?.name || "").trim();

  let html = "", source = "";
  try {
    if (url) {
      if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: "URL 必须 http(s) 开头" });
      const ctrl = AbortSignal.timeout ? AbortSignal.timeout(12_000) : undefined;
      const r = await fetch(url, { signal: ctrl, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36", "Accept": "text/html,*/*" }, redirect: "follow" });
      if (!r.ok) return json(res, 502, { error: `抓取失败 HTTP ${r.status}` });
      html = await r.text();
      source = url;
    } else if (htmlPath) {
      const clean = path.resolve(WS_ROOT, htmlPath.replace(/\\/g, "/"));
      if (!isInsideSafeHtmlDir(WS_ROOT, htmlPath) || !fs.existsSync(clean)) return json(res, 400, { error: "htmlPath 必须是 workshop-out/tmp 下的 .html" });
      html = fs.readFileSync(clean, "utf8");
      source = htmlPath;
    } else {
      return json(res, 400, { error: "需要 url 或 htmlPath" });
    }
  } catch (e) {
    return json(res, 502, { error: `抓取失败：${String(e?.message || e).slice(0, 120)}` });
  }

  const tokens = extractTokens(html);
  if (tokens.colors.length < 4) return json(res, 422, { error: "页面 CSS 颜色太少，无法蒸馏（SPA 空壳或纯图页）", source });
  const cls = classifyColors(tokens.colors);
  const fontTop = tokens.fonts.slice().sort((a, b) => b[1] - a[1]).map(f => f[0]);
  const fontBody = pickFont(fontTop, /serif|song|宋|ming/i) || pickFont(fontTop, /pingfang|yahei|noto|system|sans/i) || fontTop[0] || "";
  const label = name || hostLabel(source) || "蒸馏主题";
  const key = slugify(name || hostLabel(source) || "distilled");

  const destDir = templatesDir(ctx);
  fs.mkdirSync(destDir, { recursive: true });
  const cssPath = path.join(destDir, `theme-${key}.css`);
  fs.writeFileSync(cssPath, buildThemeCss(key, label, cls, fontBody));

  return json(res, 200, {
    ok: true, key, label, cssFile: `theme-${key}.css`, source,
    tokens: {
      colors: tokens.colors.length, fonts: fontTop.slice(0, 5), radii: tokens.radii.length,
      bg: cls.bg, fg: cls.fg, muted: cls.muted, accent: cls.accent, accent2: cls.accent2, bgIsDark: cls.bgIsDark,
    },
  });
}

function pickFont(list, re) { return list.find(f => re.test(f)) || ""; }
function hostLabel(src) {
  const m = String(src).match(/^https?:\/\/([^\/?#]+)/);
  if (!m) return "";
  return m[1].replace(/^www\./, "").split(".").slice(0, -1).join("-") || m[1].split(".")[0];
}
