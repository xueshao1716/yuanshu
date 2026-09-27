// ══════════════════════════════════════════════════════════
// engine/distill-theme-core.mjs —— 从网页蒸馏 PPT 主题（纯逻辑，fsMod/无副作用，可单测）
// 思路对齐 OpenDesign：设计规范 = 结构化 token（背景/正文/弱化/强调/字体栈），
// 而不是一张截图。机械提取 → 规则分类 → 生成与 ppt-html templates 同构的 theme CSS。
// ══════════════════════════════════════════════════════════

// ── 颜色工具 ──
export function parseColor(raw) {
  let m = String(raw).trim().match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  m = String(raw).match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[,\/\s]+/).filter(Boolean).map(Number);
    if (p.length >= 3) return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p[3] === undefined ? 1 : p[3] };
  }
  m = String(raw).match(/^hsla?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[,\/\s]+/).filter(Boolean).map(parseFloat);
    if (p.length >= 3) {
      const { r, g, b } = hslToRgb(p[0], p[1] / 100, p[2] / 100);
      return { r, g, b, a: p[3] === undefined ? 1 : p[3] };
    }
  }
  return null;
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return { r: t[0] + m, g: t[1] + m, b: t[2] + m };
}

export function toHex({ r, g, b }) {
  const f = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${f(r)}${f(g)}${f(b)}`.toUpperCase();
}

export function hsl({ r, g, b }) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function contrast(a, b) { // 相对亮度对比度（WCAG 简化）
  const lum = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ── 提取：HTML 文本 → 颜色/字体/圆角频次 ──
export function extractTokens(html) {
  const colors = new Map(), fonts = new Map(), radii = new Map();
  let bodyBg = "";
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const scan = (css, isRoot) => {
    if (!css) return;
    for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) bump(colors, m[0].toLowerCase());
    for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) bump(fonts, m[1].trim().slice(0, 120));
    for (const m of css.matchAll(/border-radius\s*:\s*([^;}]+)/gi)) bump(radii, m[1].trim().slice(0, 40));
    if (isRoot) { // body/html/:root 的 background 是强语义信号（页面主底色）
      for (const m of css.matchAll(/(?:^|})[^{}]*(?:body|html|:root)[^{}]*{([^}]*)}/gi)) {
        const b = m[1].match(/background(?:-color)?\s*:\s*([^;}]+)/i);
        if (b && !/transparent|none/i.test(b[1])) bodyBg = b[1].trim().split(/\s+/)[0];
      }
    }
  };
  for (const m of String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) scan(m[1], true);
  for (const m of String(html).matchAll(/style\s*=\s*"([^"]*)"/gi)) scan(m[1], false);
  const meta = String(html).match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);
  if (meta) { bump(colors, meta[1].toLowerCase()); if (!bodyBg) bodyBg = meta[1]; }
  return { colors: [...colors.entries()], fonts: [...fonts.entries()], radii: [...radii.entries()], bodyBg };
}

// ── 分类：token 频次 → 语义角色（bg/fg/muted/accent/accent2）──
export function classifyColors(entries, hints = {}) {
  const parsed = [];
  for (const [raw, count] of entries) {
    const c = parseColor(raw);
    if (!c || c.a < 0.5) continue; // 半透明叠加层干扰大，跳过
    parsed.push({ raw, hex: toHex(c), ...hsl(c), count });
  }
  if (!parsed.length) return { bg: "#FFFFFF", fg: "#111827", muted: "#6B7280", accent: "#2563EB", accent2: "#D97706", bgIsDark: false };
  const total = parsed.reduce((s, p) => s + p.count, 0);
  const weight = (p) => p.count / total;
  // bg：优先 body/html/:root 的语义背景（两极才可信），否则取极亮/极暗高频色（不限饱和度——深蓝背景 s 高是常态）
  const bipolar = parsed.filter(p => p.l > 0.82 || p.l < 0.22);
  const hintP = hints.bodyBg ? parsed.find(p => p.hex === toHex(parseColor(hints.bodyBg) || {})) : null;
  const bgP = (hintP && (hintP.l > 0.75 || hintP.l < 0.3)) ? hintP
    : (bipolar.length ? bipolar.slice().sort((a, b) => weight(b) - weight(a))[0]
      : parsed.slice().sort((a, b) => weight(b) - weight(a))[0]);
  const bgIsDark = bgP.l < 0.5;
  // fg：与 bg 对比度最大的低饱和色（排除与 bg 同色）
  const fgP = parsed.filter(p => p.hex !== bgP.hex && p.s < 0.5 && contrast(p, bgP) > 2.5)
    .sort((a, b) => contrast(b, bgP) - contrast(a, bgP))[0]
    || parsed.filter(p => p.hex !== bgP.hex).sort((a, b) => contrast(b, bgP) - contrast(a, bgP))[0];
  // muted：灰阶中介色（排除与 fg/bg 撞色）
  const mutedP = parsed.filter(p => p.s < 0.2 && p.hex !== bgP.hex && p.hex !== fgP.hex
    && contrast(p, bgP) > 1.3 && contrast(p, bgP) < contrast(fgP, bgP))
    .sort((a, b) => weight(b) - weight(a))[0];
  // accent：高饱和、频次权重高、与 bg/fg 均不同
  const vivid = parsed.filter(p => p.s > 0.4 && p.l > 0.2 && p.l < 0.85 && contrast(p, bgP) > 1.4 && contrast(p, fgP) > 1.15)
    .sort((a, b) => weight(b) - weight(a));
  const accentP = vivid[0];
  const accent2P = vivid.find(p => p !== accentP && Math.abs(p.h - (accentP?.h ?? -999)) > 30);
  const fallbackMuted = bgIsDark ? "#FFFFFFB8" : "#111827A6";
  return {
    bg: bgP.hex, fg: fgP.hex,
    muted: mutedP ? mutedP.hex : fallbackMuted,
    accent: accentP ? accentP.hex : (bgIsDark ? "#4F8CFF" : "#2563EB"),
    accent2: accent2P ? accent2P.hex : (bgIsDark ? "#D9B36C" : "#D97706"),
    bgIsDark, accentsSeen: vivid.length,
  };
}

// ── 生成：token → 与 ppt-html templates 同构的 theme CSS ──
export function buildThemeCss(key, label, cls, fonts) {
  const c = cls;
  const bg2 = shiftL(c.bg, c.bgIsDark ? 0.05 : -0.04);
  const cardA = c.bgIsDark ? "rgba(255,255,255,.06)" : "rgba(17,24,39,.05)";
  const lineA = c.bgIsDark ? "rgba(255,255,255,.16)" : "rgba(17,24,39,.14)";
  const accentA = hexToRgba(c.accent, c.bgIsDark ? 0.18 : 0.12);
  const serif = /serif|song|宋|ming|明/i.test(fonts || "") ? '"Georgia",serif' : null;
  const fontBody = fonts || 'system-ui,"PingFang SC","Microsoft YaHei",sans-serif';
  const fontDisp = serif || fontBody;
  const rgba = (hex, a) => hexToRgba(hex, a);
  return `/* theme-${key} —— ${label}（网址蒸馏，${new Date().toISOString().slice(0, 10)}）*/
:root, body.theme-${key} {
  --bg: ${c.bg}; --bg2: ${bg2}; --fg: ${c.fg}; --muted: ${rgba(c.fg, 0.62)};
  --accent: ${c.accent}; --gold: ${c.accent2}; --card: ${cardA};
  --line: ${lineA};
}
body.theme-${key} { margin:0; font-family:${fontBody}; color:var(--fg); }
body.theme-${key} .slide {
  background:
    radial-gradient(900px 500px at 85% -10%, ${accentA}, transparent 60%),
    radial-gradient(700px 420px at -8% 110%, ${rgba(c.accent2, 0.10)}, transparent 55%),
    var(--bg);
}
body.theme-${key} .cover-kicker { font-size:16px; letter-spacing:.35em; color:var(--gold); text-transform:uppercase; }
body.theme-${key} .cover-title { font-size:88px; line-height:1.15; margin:24px 0 16px; font-weight:700; }
body.theme-${key} .cover-sub { font-size:22px; color:var(--muted); }
body.theme-${key} .cover-meta { font-size:15px; color:var(--muted); margin-top:48px; letter-spacing:.08em; }
body.theme-${key} .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; }
body.theme-${key} .page-title { font-size:44px; font-weight:700; margin:0 0 8px; }
body.theme-${key} .page-sub { font-size:16px; color:var(--muted); }
body.theme-${key} .big-num { font-family:${fontDisp}; font-size:104px; font-weight:700; color:var(--accent); line-height:1; }
body.theme-${key} .accent-bar { width:56px; height:4px; background:var(--accent); border-radius:2px; }
body.theme-${key} .sec-num { font-family:${fontDisp}; font-size:220px; color:${rgba(c.accent, 0.16)}; line-height:1; }
`;
}

function shiftL(hex, d) {
  const c = parseColor(hex);
  if (!c) return hex;
  const { h, s, l } = hsl(c);
  return toHex(hslToRgb(h, s, Math.max(0, Math.min(1, l + d))));
}
function hexToRgba(hex, a) {
  const c = parseColor(hex);
  if (!c) return hex;
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

export function slugify(name) {
  const s = String(name || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return s || "distilled";
}
