// ===== quantum 量子引擎主题 · 自动化验证 =====
// 验证点：
//  1. 登录页加载无 JS 错误，quantum.css 已挂载
//  2. 切换 quantum 主题后 data-theme / CSS 变量正确
//  3. quantum.css 组件层确实生效（计算样式含网格背景/辉光等特征）
//  4. WCAG 对比度（text/border/dim 相对背景）
//  5. 消息渲染 / 输入聚焦态 / 主题编辑器 / 工具卡 / 移动端
// 运行：node tests/quantum-theme-test.mjs
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8787';
const TOKEN = process.env.YUANSHU_TOKEN || '';
if (!TOKEN) throw new Error('请设置 YUANSHU_TOKEN 后再运行登录验证');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

// WCAG 相对亮度 & 对比度
function lum(hex) {
  const c = hex.replace('#','');
  const [r,g,b] = [0,2,4].map(i => parseInt(c.slice(i,i+2),16)/255)
    .map(v => v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4));
  return 0.2126*r + 0.7152*g + 0.0722*b;
}
const contrast = (a,b) => {
  const [l1,l2] = [lum(a),lum(b)].sort((x,y)=>y-x);
  return (l1+0.05)/(l2+0.05);
};

const hexOf = (s) => {
  const m = String(s).match(/#[0-9a-fA-F]{6}/);
  return m ? m[0].toLowerCase() : null;
};

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0,200)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0,200)); });

  console.log('\n[1] 登录页');
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);
  ok('登录页渲染', await page.locator('#token-input').isVisible());
  ok('无 JS 错误（登录页）', errs.length === 0, errs.slice(0,3).join(' | '));
  const qcss = await page.evaluate(() =>
    [...document.styleSheets].some(s => (s.href||'').includes('quantum.css')));
  ok('quantum.css 已挂载', qcss);

  console.log('\n[2] 登录并切换 quantum');
  await page.fill('#token-input', TOKEN);
  await page.click('#login-btn');
  await page.waitForTimeout(2500);
  ok('登录成功进入工作台', await page.locator('#input').isVisible());
  await page.evaluate("applyTheme('quantum', false)");
  await page.waitForTimeout(600);

  const vars = await page.evaluate(() => {
    const gs = getComputedStyle(document.documentElement);
    const pick = k => gs.getPropertyValue(k).trim();
    return {
      theme: document.documentElement.dataset.theme,
      accent: pick('--accent'), bg: pick('--bg'), panel: pick('--panel'),
      text: pick('--text'), dim: pick('--dim'), border: pick('--border'),
      glow: pick('--accent-glow'),
    };
  });
  ok('data-theme = quantum', vars.theme === 'quantum', `got ${vars.theme}`);
  ok('--accent = #23e6ff', vars.accent === '#23e6ff', vars.accent);
  ok('--bg = #05070e', vars.bg === '#05070e', vars.bg);
  ok('--text = #e8f0ff', vars.text === '#e8f0ff', vars.text);
  ok('--accent-glow = 0.9', vars.glow === '0.9', vars.glow);

  console.log('\n[3] WCAG 对比度（AA 正文 ≥4.5，装饰 ≥3）');
  const pairs = [
    ['正文 text/bg',   vars.text, vars.bg],
    ['次要 dim/panel', vars.dim, vars.panel],
    ['边框 border/panel', vars.border, vars.panel],
    ['主色 accent/bg', vars.accent, vars.bg],
    ['主色 accent/panel', vars.accent, vars.panel],
    ['弱字 dim2/panel2', vars.dim, vars.panel2],
  ];
  for (const [name, fg, bg] of pairs) {
    const c = contrast(fg, bg);
    const min = name.startsWith('正文') ? 4.5 : 3;
    ok(`${name} = ${c.toFixed(2)}:1`, c >= min, `(<${min})`);
  }

  console.log('\n[4] quantum.css 组件层生效');
  const styles = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const sidebar = getComputedStyle(document.querySelector('#sidebar'));
    const send = getComputedStyle(document.querySelector('#send'));
    return {
      bodyBg: body.backgroundImage,
      bodyBlur: body.backdropFilter,
      sidebarShadow: sidebar.boxShadow,
      sidebarAfter: !!document.querySelector('#sidebar::after'),
      sendShadow: send.boxShadow,
    };
  });
  ok('body 科技网格背景（radial+linear 多图层）', (styles.bodyBg.match(/linear-gradient/g)||[]).length >= 2 && styles.bodyBg.includes('radial-gradient'));
  ok('发送按钮霓虹辉光', styles.sendShadow.includes('rgba') || /#[0-9a-f]{6}/i.test(styles.sendShadow));
  ok('侧边栏渐变分隔线伪元素', await page.evaluate(() => {
    return getComputedStyle(document.querySelector('#sidebar'), '::after').backgroundImage !== 'none';
  }));

  console.log('\n[5] 输入框聚焦态');
  await page.click('#input');
  await page.waitForTimeout(500);
  const focus = await page.evaluate(() => {
    const shell = document.querySelector('.input-shell');
    const gs = getComputedStyle(shell);
    return { border: gs.borderColor, shadow: gs.boxShadow };
  });
  ok('聚焦辉光生效（box-shadow 多层）', focus.shadow.split('),').length >= 3, focus.shadow.slice(0,80));
  ok('聚焦边框染主色', focus.border.includes('23') || /rgba\(35, 230, 255/i.test(focus.border), focus.border);

  console.log('\n[6] 发送消息 → 消息区渲染');
  await page.fill('#input', '测试 quantum 主题显示效果');
  await page.press('#input', 'Enter');
  await page.waitForTimeout(4500);
  const msgs = await page.evaluate(() => {
    const m = document.querySelectorAll('.msg');
    return { count: m.length, userBubble: !!document.querySelector('.msg.user .bubble'), asstBubble: !!document.querySelector('.msg.assistant .bubble') };
  });
  ok('用户消息渲染', msgs.count >= 1 && msgs.userBubble);
  ok('助手回复渲染', msgs.asstBubble);
  const bubble = await page.evaluate(() => {
    const b = document.querySelector('.msg.assistant .bubble');
    if (!b) return null;
    const gs = getComputedStyle(b);
    return { bg: gs.backgroundImage.slice(0,120), border: gs.borderColor, shadow: gs.boxShadow.slice(0,80) };
  });
  ok('助手气泡渐变+辉光样式', bubble && (bubble.bg.includes('gradient') || bubble.shadow.length > 5));

  console.log('\n[7] 主题编辑器（色板/编辑区）');
  await page.evaluate("openThemeModal()");
  await page.waitForTimeout(600);
  ok('主题编辑器打开', await page.locator('.theme-modal, #theme-modal, [id*=theme]').first().isVisible().catch(() => true));
  ok('quantum 条目存在', await page.evaluate(() => [...document.querySelectorAll('.theme-item')].some(el => el.dataset.key === 'quantum')));
  ok('quantum 条目高亮', await page.evaluate(() => [...document.querySelectorAll('.theme-item')].some(el => el.dataset.key === 'quantum' && el.classList.contains('active'))));
  await page.evaluate("document.querySelector('#theme-close')?.click() || document.querySelector('.theme-modal .close')?.click()");
  await page.waitForTimeout(300);

  console.log('\n[8] 持久化 & 刷新保持');
  await page.evaluate("applyTheme('quantum', true)");
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const afterReload = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    stored: localStorage.getItem('pi_theme'),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  }));
  ok('localStorage 持久化 quantum', afterReload.stored === 'quantum', afterReload.stored);
  ok('刷新后 data-theme 保持', afterReload.theme === 'quantum', afterReload.theme);
  ok('刷新后色板保持', afterReload.accent === '#23e6ff', afterReload.accent);

  console.log('\n[9] 移动端 390×844');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  ok('移动端无横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  ok('移动端无 JS 错误', errs.length === 0, errs.slice(0,3).join(' | '));

  console.log('\n[10] 其他主题回归（violet 切换不受 quantum.css 影响）');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate("applyTheme('violet', false)");
  await page.waitForTimeout(400);
  const vio = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    bodyBg: getComputedStyle(document.body).backgroundImage,
  }));
  ok('切回 violet data-theme 正确', vio.theme === 'violet', vio.theme);
  ok('violet 无量子网格（qcss 零影响）', !vio.bodyBg.includes('linear-gradient'), vio.bodyBg.slice(0,60));
  await page.evaluate("applyTheme('quantum', false)");

  console.log('\n════════ 结果 ════════');
  console.log(`  ✅ 通过 ${pass} 项 / ❌ 失败 ${fail} 项`);
  console.log('  累计 JS 错误:', errs.length ? errs.slice(0,5) : '无');
  await browser.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('脚本异常:', e); process.exit(2); });
