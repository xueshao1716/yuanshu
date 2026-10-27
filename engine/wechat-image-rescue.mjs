// 图片路径"兜底救援"：写了不存在的路径时，找同名/同系列的真实文件（2026-10-28）
//
// 真机事故：小语在微信回「!图（D:\...\albedo-real-16x9\albedo-real-01.png）」，
// 而真实文件在 albedo-gpt-16x9\albedo-gpt-01.png —— 目录名是它自己编的。
// 结果：既没图，用户还看到一串路径文本。两头都难看。
//
// 这里做三件事：
//   1) 路径不存在时，按"同前缀 + 同序号"在生成物目录里找最像的真实文件；
//   2) 找到了就用它发；
//   3) 找不到就把这段标记从文本里**剥掉**，绝不让用户看到裸路径。
import fs from "node:fs";
import path from "node:path";

export const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif)$/i;

/** 在一组根目录里按 basename 找相似图片（返回真实存在的路径）。 */
export function findSimilarImage(missingPath, { roots = [], max = 4 } = {}) {
  const base = path.basename(String(missingPath || ""));
  if (!base) return [];
  const stem = base.replace(IMAGE_EXT, "").toLowerCase();
  const prefix = stem.replace(/[-_]?\d+$/, "");
  const tokens = prefix.split(/[-_]+/).filter((t) => t.length >= 3);
  const num = (stem.match(/(\d+)$/) || [])[1] || "";

  const collect = (dir, out, depth = 0) => {
    if (depth > 2) return out;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { collect(full, out, depth + 1); continue }
      if (!IMAGE_EXT.test(e.name)) continue;
      const name = e.name.replace(IMAGE_EXT, "").toLowerCase();
      let score = 0;
      for (const t of tokens) if (name.includes(t)) score += 2;
      if (num && name.endsWith(num)) score += 2;
      if (name === stem) score += 6;
      if (score >= 4) out.push({ path: full, score });
    }
    return out;
  };

  const all = [];
  for (const root of roots) collect(root, all);
  return all.sort((a, b) => b.score - a.score).slice(0, max).map((h) => h.path);
}

/**
 * 从文本里抽图片路径；不存在的尝试救援，救不回来就剥掉标记。
 * @returns {{text:string, images:string[], rescued:Array<{missing:string, used:string}>, dropped:string[]}}
 */
export function rescueImagePaths(text, { exists = fs.existsSync, roots = [], limit = 6 } = {}) {
  let t = String(text || "");
  const images = [];
  const rescued = [];
  const dropped = [];

  const take = (raw) => {
    const p = String(raw || "").trim().replace(/^["'“”]+|["'“”]+$/g, "");
    if (!p) return false;
    if (exists(p)) { images.push(p); return true }
    const near = findSimilarImage(p, { roots, max: 2 });
    if (near.length) {
      for (const n of near) if (!images.includes(n)) images.push(n);
      rescued.push({ missing: p, used: near[0] });
      return true;
    }
    dropped.push(p);
    return false;
  };

  // ① markdown
  t = t.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (m, p) => (take(p) ? "" : ""));
  // ② !图（路径）/图(路径)/!圖 —— 全角括号、不带感叹号都算
  t = t.replace(/[!！]?\s*[图圖片]\s*[（(]\s*([^）)\n]+?)\s*[）)]/g, (m, p) => (take(p) ? "" : ""));
  // ③ 单独一行的裸路径
  const kept = [];
  for (const line of t.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z]:[\\/][^\s]+\.(?:png|jpe?g|webp|gif))$/i);
    if (m) { if (!take(m[1])) dropped.push(m[1]); continue }
    kept.push(line);
  }

  return {
    text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    images: images.slice(0, limit),
    rescued,
    dropped,
  };
}
