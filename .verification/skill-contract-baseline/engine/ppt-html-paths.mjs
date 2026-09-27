// ppt-html 路径：模板目录可配置；本地 HTML 只认工作空间白名单子目录
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAFE_HTML_DIRS = ["workshop-out", "tmp"];

export function resolvePptHtmlTemplates({ env = process.env, homedir = os.homedir() } = {}) {
  const fromEnv = env.PPT_HTML_TEMPLATES || env.PI_PPT_HTML_TEMPLATES;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(homedir, ".agents", "skills", "ppt-html", "templates");
}

export function isInsideSafeHtmlDir(wsRoot, htmlPath, safeDirs = SAFE_HTML_DIRS) {
  const clean = path.resolve(wsRoot, String(htmlPath || "").replace(/\\/g, "/"));
  if (!clean.toLowerCase().endsWith(".html")) return false;
  const root = path.resolve(wsRoot);
  const rel = path.relative(root, clean);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return safeDirs.includes(rel.split(/[\\/]/)[0]);
}

export function readThemeCss(themeKey, templatesDir = resolvePptHtmlTemplates()) {
  if (!themeKey) return "";
  try {
    const tp = path.join(templatesDir, `theme-${themeKey}.css`);
    if (fs.existsSync(tp)) return fs.readFileSync(tp, "utf8");
  } catch { /* 主题读不到就不附 */ }
  return "";
}
