// ══════════════════════════════════════════════════════════
// engine/slides-lint-core.mjs —— 设计稿硬质检（纯函数，可单测）
// 思路来自 slides-grab 的 linter 概念：agent 自觉之外再加机械关卡。
// 规则：R1 小字号 R2 阶梯混乱 R3 对比度不足 R4 要点超载
//       R5 无可编辑字段 R6 外链资源 R7 画布缺失 R8 标题过小
// ══════════════════════════════════════════════════════════

/** 从 CSS 文本抽取 font-size 的 px 值（含选择器上下文片段） */
function fontSizes(css) {
  const out = [];
  for (const m of css.matchAll(/([^{}]{0,80})\{[^{}]*font-size\s*:\s*([\d.]+)px/g)) {
    out.push({ px: parseFloat(m[2]), ctx: ((m[1] || "").trim().split("\n").pop() || "").trim().slice(0, 40) });
  }
  return out;
}

/** WCAG 相对对比度（#rrggbb 输入；解析失败返回 21 不误报） */
export function contrastHex(a, b) {
  const lum = (hex) => {
    const m = hex.replace("#", "");
    const v = [0, 2, 4].map(i => parseInt(m.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  if (!/^#[0-9a-fA-F]{6}$/.test(a) || !/^#[0-9a-fA-F]{6}$/.test(b)) return 21;
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function extractVar(css, name) {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  return m ? m[1] : "";
}

/** 单页 lint。pageHtml 页面全文；themeCss 可选（用于对比度检查）。返回 [{rule,severity,msg}] */
export function lintPage(pageHtml, themeCss = "") {
  const issues = [];
  const inline = [...String(pageHtml).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join("\n");
  const css = inline + "\n" + themeCss;

  // R7 画布：1280×720 声明
  const hasCanvas = /1280/.test(pageHtml) && (/720/.test(pageHtml) || /aspect-ratio\s*:\s*16\s*\/\s*9/i.test(pageHtml));
  if (!hasCanvas) issues.push({ rule: "canvas", severity: "error", msg: "缺少 1280×720 画布声明" });

  // R6 外链资源（设计稿必须零外部依赖；svg 命名空间除外）
  const ext = [...String(pageHtml).matchAll(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+["']/gi)]
    .filter(m => !/w3\.org/.test(m[0]));
  if (ext.length) issues.push({ rule: "external", severity: "error", msg: `引用了 ${ext.length} 处外部资源（须零外链）` });

  // R1 小字号
  const sizes = fontSizes(inline);
  const tiny = sizes.filter(s => s.px < 14);
  if (tiny.length) issues.push({ rule: "min-font", severity: "warn", msg: `${tiny.length} 处字号 <14px（最小 ${Math.min(...tiny.map(t => t.px))}px，投影可读性差）` });

  // R2 阶梯：排序后相邻差 <8% 的对数过多
  const uniq = [...new Set(sizes.map(s => s.px))].sort((a, b) => a - b);
  let closePairs = 0;
  for (let i = 1; i < uniq.length; i++) if (uniq[i] / uniq[i - 1] < 1.08) closePairs++;
  if (uniq.length >= 4 && closePairs > 2) issues.push({ rule: "ladder", severity: "warn", msg: `字号阶梯混乱：${uniq.join("/")} 中 ${closePairs} 对相邻差 <8%` });

  // R8 标题字号：cover-title / page-title 类任一过小（大封面掩不住小页标题）
  const titleSize = sizes.filter(s => /cover-title|page-title/.test(s.ctx)).map(s => s.px);
  if (titleSize.length && Math.min(...titleSize) < 36) issues.push({ rule: "title-size", severity: "warn", msg: `存在标题字号 <36px（最小 ${Math.min(...titleSize)}px）` });

  // R4 要点超载
  const liCount = (String(pageHtml).match(/<li[\s>]/gi) || []).length;
  if (liCount > 7) issues.push({ rule: "bullets", severity: "warn", msg: `${liCount} 个列表项（每页要点建议 ≤5-7）` });

  // R5 可编辑字段
  const fields = (String(pageHtml).match(/data-field=/g) || []).length;
  if (!fields) issues.push({ rule: "data-field", severity: "warn", msg: "无 data-field 标记（文案不可编辑）" });

  // R3 对比度：主题 CSS 变量组合（fg/bg、accent/bg）
  if (themeCss) {
    const bg = extractVar(themeCss, "bg"), fg = extractVar(themeCss, "fg"), accent = extractVar(themeCss, "accent");
    if (bg && fg && contrastHex(fg, bg) < 4.5) issues.push({ rule: "contrast", severity: "error", msg: `正文/背景对比度 ${contrastHex(fg, bg).toFixed(1)} < 4.5（${fg} on ${bg}）` });
    if (bg && accent && contrastHex(accent, bg) < 2.2) issues.push({ rule: "contrast", severity: "warn", msg: `强调色/背景对比度 ${contrastHex(accent, bg).toFixed(1)} 偏低（${accent} on ${bg}）` });
  }
  return issues;
}

/** 整 deck lint：pages=[{file,html}]，返回每页与汇总 */
export function lintDeck(pages, themeCss = "") {
  const perPage = {};
  let total = 0, errors = 0;
  for (const p of pages) {
    const list = lintPage(p.html, themeCss);
    perPage[p.file] = list;
    total += list.length;
    errors += list.filter(i => i.severity === "error").length;
  }
  return { perPage, total, errors, ok: errors === 0 };
}
