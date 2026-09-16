// 主题可读性回归绳（2026-09-16）。
//
// 起因：用户说"主题里也很多黑色背景色覆盖文字的"。逐元素在真浏览器里量过之后，
// 落成两类问题：
//   ① 生成器给的 token 本身不够读（拟木的警告色在枫木底上只有 1.54；soft 底上的
//      主色字 3.19；muted 卡在 2.97）——这类**能算**，就必须在这里钉住；
//   ② 壁纸模式下底色被撤掉、文字直接压在壁纸上（CSS 层的问题，见下面对规则本身的断言）。
//
// 这份测试是"评测绳"：以后谁调 seed 或改派生算法，只要让任何一套主题的任一关键配对
// 掉到线下，这里就红——而不是等用户在某个主题里看不清字才发现。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEEDS, generateTheme, contrast } from '../../frontend/src/theme/generate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const hexToRgb = (hex) => { const h = hex.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const rgbToHex = (rgb) => '#' + rgb.map(c => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
// 半透明色叠在底色上之后是什么颜色（组件的"软底"都这么算）
const blend = (fg, alpha, bg) => rgbToHex(hexToRgb(fg).map((c, i) => c * alpha + hexToRgb(bg)[i] * (1 - alpha)));
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ''));

const THEMES = Object.entries(SEEDS).map(([name, seed]) => [name, generateTheme(seed), seed]);

test('每套主题的关键前景/背景配对都要过 WCAG 线（正文 4.5 / 大字与图标 3.2）', () => {
  const fails = [];
  for (const [name, v, seed] of THEMES) {
    const pairs = [
      ['--pi-text', '--pi-bg', 4.5, '正文 / 最底层'],
      ['--pi-text', '--pi-bg1', 4.5, '正文 / 面板'],
      ['--pi-text', '--pi-bg2', 4.5, '正文 / 弹层'],
      ['--pi-dim', '--pi-bg', 4.5, '次要文字 / 底'],
      ['--pi-dim', '--pi-bg2', 4.5, '次要文字 / 弹层'],
      ['--pi-dim2', '--pi-bg3', 4.5, '三级文字 / 默认按钮'],
      ['--pi-on-accent', '--pi-accent', 4.5, '主色底上的字'],
      ['--pi-accent', '--pi-bg1', 3.0, '主色当文字 / 面板'],
      ['--pi-on-green', '--pi-green', 3.2, '成功色底上的字'],
      ['--pi-on-red', '--pi-red', 3.2, '危险色底上的字'],
      ['--pi-on-yellow', '--pi-yellow', 3.2, '警告色底上的字'],
      ['--pi-success', '--pi-bg1', 3.2, '成功色当文字 / 面板'],
      ['--pi-warning', '--pi-bg1', 3.2, '警告色当文字 / 面板'],
      ['--pi-danger', '--pi-bg1', 3.2, '危险色当文字 / 面板'],
      ['--pi-muted', '--pi-bg', 3.2, 'muted / 底'],
      ['--pi-surface-fg', '--pi-surface', 4.5, 'surface 前景'],
      ['--pi-overlay-fg', '--pi-overlay', 4.5, 'overlay 前景'],
    ];
    for (const [fgKey, bgKey, min, label] of pairs) {
      if (!isHex(v[fgKey]) || !isHex(v[bgKey])) continue;
      const cr = contrast(v[fgKey], v[bgKey]);
      if (cr < min) fails.push(`${name} ${label}：${fgKey} on ${bgKey} = ${cr.toFixed(2)} < ${min}（${v[fgKey]} on ${v[bgKey]}）`);
    }
    // badge：前景画在 "accent 12% 叠在 bg1 上" 这层软底上，必须按真实叠色判
    const badgeBg = blend(seed.accent, 0.12, v['--pi-bg1']);
    const badgeCr = contrast(v['--pi-badge-fg'], badgeBg);
    if (badgeCr < 4.5) fails.push(`${name} badge：${v['--pi-badge-fg']} on ${badgeBg} = ${badgeCr.toFixed(2)} < 4.5`);
  }
  assert.deepEqual(fails, [], '这些配对没达标：\n  ' + fails.join('\n  '));
});

test('对比度解算必须落在线上，不许"看着达标"（实测会停在 3.17 / 4.49）', () => {
  for (const [name, v, seed] of THEMES) {
    for (const [fgKey, bgKey, min] of [['--pi-green', '--pi-bg1', 3.2], ['--pi-warning', '--pi-bg1', 3.2], ['--pi-badge-fg', null, 4.5]]) {
      const bg = bgKey ? v[bgKey] : blend(seed.accent, 0.12, v['--pi-bg1']);
      const cr = contrast(v[fgKey], bg);
      assert.ok(cr >= min, `${name} ${fgKey} = ${cr.toFixed(3)}，差了 ${(min - cr).toFixed(3)}（解算没收敛到位）`);
    }
  }
});

test('壁纸模式：底色这一层不能撤，放字的区域必须有自己的可读底', () => {
  const css = read('frontend', 'src', 'styles.css');
  // 撤掉底色 → 没有自己画底的地方（欢迎页文字列、左导航）直接露在画布默认色上
  const bodyRule = css.split('body.has-wallpaper {')[1]?.split('}')[0] || '';
  assert.ok(!/transparent/.test(bodyRule), `壁纸模式下 body 不能再是 transparent：${bodyRule.trim()}`);
  assert.match(bodyRule, /background:\s*var\(--pi-bg\)/, '壁纸模式必须保留主题底色');
  // 光有底色还不够：欢迎页那一列文字当初被整块撤成透明，字直接压在壁纸上
  const welcome = css.split('body.has-wallpaper .chat-welcome .chat-reading-column {')[1]?.split('}')[0] || '';
  assert.match(welcome, /color-mix\(in srgb, var\(--pi-bg\) \d+%, transparent\)/, '欢迎页文字列要有主题色纱');
  assert.match(welcome, /backdrop-filter/, '色纱要带模糊，否则壁纸纹理仍会干扰字形');
});

test('不许再写死"主色底 + 白字"（各主题主色明度不同，白字在浅主色上只有 4.06）', () => {
  const dir = path.join(ROOT, 'frontend', 'src');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.tsx') ? [path.join(d, e.name)] : []));
  const offenders = walk(dir).filter(f => fs.readFileSync(f, 'utf8').includes('bg-pi-accent text-white'));
  assert.deepEqual(offenders.map(f => path.relative(ROOT, f)), [], '这些文件还在写死白字，应该用 text-pi-on-accent');
  // 主题页预览气泡同理（写死 --pi-bg 当字色）
  const themes = read('frontend', 'src', 'pages', 'Themes.tsx');
  assert.ok(!themes.includes("color: 'var(--pi-bg)'"), '主色底上的字要走 --pi-on-accent');
});
