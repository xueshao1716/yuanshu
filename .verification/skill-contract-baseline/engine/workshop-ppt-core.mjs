// ══════════════════════════════════════════════════════════
// engine/workshop-ppt-core.mjs —— PPT 工作室核心纯逻辑（2026-09-03 升级：预览/干预/历史）
// 从 workshop.mjs 抽出，全部注入 fs 便于单测：
//   validateSlides   —— 前端编辑后重建前的 slides 结构校验（与 generate_pptx.py 白名单对齐）
//   findSlidesJson   —— 在本轮工作目录里探测 agent 产出的 slides JSON（含 slides 字段的 .json）
//   appendHistory    —— 生成历史（workshop-out/ppt-history.json，最新在前，上限 50 条）
// ══════════════════════════════════════════════════════════
import * as fs from "node:fs";
import { join, relative, extname, sep } from "node:path";

// 与 generate_pptx.py LAYOUT_MAP 保持一致
export const PPT_LAYOUTS = new Set([
  "TitleSlide", "TitleAndContent", "TwoColumnText", "SectionHeader", "ContentWithCaption", "BulletList", "BlankSlide",
]);
const MAX_SLIDES = 30;

/** 校验前端提交的 slides 结构。返回 { ok, error? } */
export function validateSlides(slides) {
  if (!Array.isArray(slides) || slides.length === 0) return { ok: false, error: "slides 必须是非空数组" };
  if (slides.length > MAX_SLIDES) return { ok: false, error: `页数超上限（${MAX_SLIDES}）` };
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, error: `第 ${i + 1} 页格式错误` };
    if (!PPT_LAYOUTS.has(s.layout)) return { ok: false, error: `第 ${i + 1} 页 layout 无效（${s.layout}）` };
    if (typeof s.title !== "string" || !s.title.trim()) return { ok: false, error: `第 ${i + 1} 页标题不能为空` };
    if (!Array.isArray(s.content)) return { ok: false, error: `第 ${i + 1} 页 content 必须是数组` };
    if (s.content.some(c => typeof c !== "string")) return { ok: false, error: `第 ${i + 1} 页要点必须是字符串` };
  }
  return { ok: true };
}

/** 探测工作目录里的 slides JSON（第一个含 slides 数组的 .json 文件）。返回绝对路径或 null */
export function findSlidesJson(workDir, fsMod = fs) {
  try {
    let names;
    try { names = fsMod.readdirSync(workDir); } catch { return null; } // 目录不存在/不可读
    for (const n of names) {
      if (!n.toLowerCase().endsWith(".json")) continue;
      const p = join(workDir, n);
      try {
        const st = fsMod.statSync(p);
        if (!st.isFile()) continue;
        const d = JSON.parse(fsMod.readFileSync(p, "utf8"));
        if (d && Array.isArray(d.slides) && d.slides.length > 0) return p;
      } catch { /* 单文件解析失败跳过 */ }
    }
  } catch { /* 目录不可读 */ }
  return null;
}

/** 追加历史（原子写；最新在前；上限 50 条）*/
export function appendHistory(historyPath, entry, fsMod = fs) {
  let entries = [];
  try {
    if (fsMod.existsSync(historyPath)) {
      const d = JSON.parse(fsMod.readFileSync(historyPath, "utf8"));
      if (Array.isArray(d?.entries)) entries = d.entries;
    }
  } catch { /* 损坏则重建 */ }
  entries.unshift({ ts: new Date().toISOString(), ...entry });
  fsMod.writeFileSync(historyPath, JSON.stringify({ version: 1, entries: entries.slice(0, 50) }, null, 2));
  return entries.length;
}

/**
 * Pick the PPT produced by one run. The run directory is authoritative; a
 * broad artifact scan is only a compatibility fallback and must stay inside
 * that directory to avoid cross-run delivery when two jobs finish together.
 */
export function selectPptArtifact(workDir, wsRoot, scanRecentArtifacts, fsMod = fs) {
  const direct = join(workDir, "presentation.pptx");
  try {
    if (fsMod.existsSync(direct)) {
      const st = fsMod.statSync(direct);
      if ((typeof st.isFile !== "function" || st.isFile()) && Number(st.size) > 0) {
        return {
          name: "presentation.pptx",
          path: relative(wsRoot, direct).split(sep).join("/"),
          size: st.size,
          mime: "",
          mtimeMs: st.mtimeMs,
        };
      }
    }
  } catch {}
  let arts = [];
  try { arts = typeof scanRecentArtifacts === "function" ? scanRecentArtifacts(5 * 60 * 1000, 20) : []; } catch {}
  const prefix = relative(wsRoot, workDir).split(sep).join("/").replace(/\/$/, "");
  return (Array.isArray(arts) ? arts : []).find((a) => {
    const p = String(a?.path || "").replace(/\\/g, "/");
    return extname(String(a?.name || p)).toLowerCase() === ".pptx" && (p === prefix || p.startsWith(prefix + "/"));
  }) || null;
}

/** 读历史 */
export function readHistory(historyPath, fsMod = fs) {
  try {
    if (!fsMod.existsSync(historyPath)) return [];
    const d = JSON.parse(fsMod.readFileSync(historyPath, "utf8"));
    return Array.isArray(d?.entries) ? d.entries : [];
  } catch { return []; }
}
