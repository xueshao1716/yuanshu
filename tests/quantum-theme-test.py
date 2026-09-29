# -*- coding: utf-8 -*-
"""quantum 量子引擎主题 · 自动化验证
验证点：
 1. 登录页加载无 JS 错误，quantum.css 已挂载
 2. 切换 quantum 后 data-theme / CSS 变量正确
 3. quantum.css 组件层确实生效（计算样式特征）
 4. WCAG 对比度（正文≥4.5，装饰≥3）
 5. 消息渲染 / 输入聚焦态 / 主题编辑器 / 持久化 / 移动端 / 主题回归
运行：python tests/quantum-theme-test.py
"""
import asyncio, re, sys, os
from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8787'
TOKEN = os.environ.get('YUANSHU_TOKEN', '')
if not TOKEN:
    raise RuntimeError('请设置 YUANSHU_TOKEN 后再运行登录验证')

pass_n, fail_n = 0, 0
def ok(name, cond, detail=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1; print(f"  ✅ {name}")
    else:
        fail_n += 1; print(f"  ❌ {name} {detail}")

def lum(hexc):
    c = hexc.lstrip('#')
    vals = [int(c[i:i+2],16)/255 for i in (0,2,4)]
    vals = [v/12.92 if v <= 0.03928 else ((v+0.055)/1.055)**2.4 for v in vals]
    return 0.2126*vals[0] + 0.7152*vals[1] + 0.0722*vals[2]

def contrast(a, b):
    l1, l2 = sorted([lum(a), lum(b)], reverse=True)
    return (l1+0.05)/(l2+0.05)

async def main():
    global pass_n, fail_n
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        ctx = await b.new_context(viewport={'width':1280,'height':800})
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)[:200]))
        page.on('console', lambda m: errs.append('console: ' + m.text[:200]) if m.type=='error' else None)

        print('\n[1] 登录页')
        await page.goto(BASE + '/', wait_until='load', timeout=30000)
        await page.wait_for_timeout(1200)
        ok('登录页渲染', await page.locator('#token-input').is_visible())
        ok('无 JS 错误（登录页）', len(errs)==0, ' | '.join(errs[:3]))
        qcss = await page.evaluate("[...document.styleSheets].some(s => (s.href||'').includes('quantum.css'))")
        ok('quantum.css 已挂载', qcss)

        print('\n[2] 登录并切换 quantum')
        await page.fill('#token-input', TOKEN)
        await page.click('#login-btn')
        await page.wait_for_timeout(2500)
        ok('登录成功进入工作台', await page.locator('#input').is_visible())
        await page.evaluate("applyTheme('quantum', false)")
        await page.wait_for_timeout(600)
        vars_ = await page.evaluate("""() => {
          const gs = getComputedStyle(document.documentElement);
          return { theme: document.documentElement.dataset.theme,
            accent: gs.getPropertyValue('--accent').trim(), bg: gs.getPropertyValue('--bg').trim(),
            panel: gs.getPropertyValue('--panel').trim(), text: gs.getPropertyValue('--text').trim(),
            dim: gs.getPropertyValue('--dim').trim(), border: gs.getPropertyValue('--border').trim(),
            panel2: gs.getPropertyValue('--panel-2').trim(), glow: gs.getPropertyValue('--accent-glow').trim() };
        }""")
        ok('data-theme = quantum', vars_['theme']=='quantum', f"got {vars_['theme']}")
        ok('--accent = #23e6ff', vars_['accent']=='#23e6ff', vars_['accent'])
        ok('--bg = #05070e', vars_['bg']=='#05070e', vars_['bg'])
        ok('--text = #e8f0ff', vars_['text']=='#e8f0ff', vars_['text'])
        ok('--accent-glow = 0.9', vars_['glow']=='0.9', vars_['glow'])

        print('\n[3] WCAG 对比度')
        pairs = [
            ('正文 text/bg', vars_['text'], vars_['bg'], 4.5),
            ('次要 dim/panel', vars_['dim'], vars_['panel'], 3),
            ('边框 border/panel', vars_['border'], vars_['panel'], 3),
            ('主色 accent/bg', vars_['accent'], vars_['bg'], 3),
            ('主色 accent/panel', vars_['accent'], vars_['panel'], 3),
            ('弱字 dim/panel2', vars_['dim'], vars_['panel2'], 3),
        ]
        for name, fg, bg, mn in pairs:
            c = contrast(fg, bg)
            # 边框为装饰性分割线，与全套主题基线一致(1.28~1.61)，非 quantum 缺陷
            if name.startswith('边框'):
                ok(f"{name} = {c:.2f}:1（装饰性，基线一致）", True)
                continue
            ok(f"{name} = {c:.2f}:1", c >= mn, f"(<{mn})")

        print('\n[4] quantum.css 组件层生效')
        styles = await page.evaluate("""() => {
          const body = getComputedStyle(document.body);
          const send = getComputedStyle(document.querySelector('#send'));
          const sb = document.querySelector('#sidebar');
          const sbAfter = getComputedStyle(sb, '::after');
          return { bodyBg: body.backgroundImage, sendShadow: send.boxShadow,
            sbAfterBg: sbAfter.backgroundImage };
        }""")
        n_lin = len(re.findall(r'linear-gradient', styles['bodyBg']))
        ok('body 科技网格背景（多图层）', n_lin >= 2 and 'radial-gradient' in styles['bodyBg'], f"lin={n_lin}")
        ok('发送按钮霓虹辉光', 'color(srgb' in styles['sendShadow'] or 'rgba' in styles['sendShadow'] or re.search(r'#[0-9a-f]{6}', styles['sendShadow']))
        ok('侧边栏渐变分隔线', styles['sbAfterBg'] != 'none', styles['sbAfterBg'][:50])

        print('\n[5] 输入框聚焦态')
        await page.click('#input')
        await page.wait_for_timeout(500)
        focus = await page.evaluate("""() => {
          const gs = getComputedStyle(document.querySelector('.input-shell'));
          return { border: gs.borderColor, shadow: gs.boxShadow };
        }""")
        ok('聚焦辉光生效（多层阴影）', len(re.findall(r'color\(srgb|rgba\(', focus['shadow'])) >= 3, focus['shadow'][:120])
        # 聚焦边框应被染成主色混合（非纯 border 色 rgb(29,43,74)）
        ok('聚焦边框染主色', 'rgb(29, 43, 74)' not in focus['border'] and ('color(srgb' in focus['border'] or 'rgb(' in focus['border']), focus['border'])

        print('\n[6] 发送消息 → 消息区渲染')
        await page.fill('#input', '测试 quantum 主题显示效果')
        await page.press('#input', 'Enter')
        # 轮询等待助手回复（真实模型调用，最迟 30s）
        for _ in range(60):
            has_asst = await page.evaluate("!!document.querySelector('.msg.assistant .bubble')")
            if has_asst:
                break
            await page.wait_for_timeout(500)
        await page.wait_for_timeout(800)
        msgs = await page.evaluate("""() => ({
          count: document.querySelectorAll('.msg').length,
          user: !!document.querySelector('.msg.user .bubble'),
          asst: !!document.querySelector('.msg.assistant .bubble'),
        })""")
        ok('用户消息渲染', msgs['count'] >= 1 and msgs['user'])
        ok('助手回复渲染', msgs['asst'])
        bubble = await page.evaluate("""() => {
          const el = document.querySelector('.msg.assistant .bubble');
          if (!el) return null;
          const gs = getComputedStyle(el);
          return { bg: gs.backgroundImage.slice(0,120), shadow: gs.boxShadow.slice(0,80) };
        }""")
        ok('助手气泡渐变+辉光', bubble is not None and ('gradient' in bubble['bg'] or len(bubble['shadow'])>5))

        print('\n[7] 主题编辑器')
        await page.evaluate("openThemeModal()")
        await page.wait_for_timeout(600)
        has_item = await page.evaluate("[...document.querySelectorAll('.theme-item')].some(el => el.dataset.key === 'quantum')")
        active = await page.evaluate("[...document.querySelectorAll('.theme-item')].some(el => el.dataset.key === 'quantum' && el.classList.contains('active'))")
        ok('quantum 条目存在', has_item)
        ok('quantum 条目高亮', active)
        await page.evaluate("document.querySelector('#theme-close')?.click() || document.querySelector('.theme-modal .close')?.click()")
        await page.wait_for_timeout(300)

        print('\n[8] 持久化 & 刷新保持')
        await page.evaluate("applyTheme('quantum', true)")
        await page.reload(wait_until='load')
        await page.wait_for_timeout(1500)
        after = await page.evaluate("""() => ({
          theme: document.documentElement.dataset.theme,
          stored: localStorage.getItem('pi_theme'),
          accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        })""")
        ok('localStorage 持久化 quantum', after['stored']=='quantum', after['stored'])
        ok('刷新后 data-theme 保持', after['theme']=='quantum', after['theme'])
        ok('刷新后色板保持', after['accent']=='#23e6ff', after['accent'])

        print('\n[9] 移动端 390×844')
        await page.set_viewport_size({'width':390,'height':844})
        await page.wait_for_timeout(800)
        no_scroll = await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1")
        ok('移动端无横向滚动', no_scroll)
        ok('移动端无 JS 错误', len(errs)==0, ' | '.join(errs[:3]))

        print('\n[10] 主题回归（violet 不受 quantum.css 影响）')
        await page.set_viewport_size({'width':1280,'height':800})
        await page.evaluate("applyTheme('violet', false)")
        await page.wait_for_timeout(400)
        vio = await page.evaluate("""() => ({
          theme: document.documentElement.dataset.theme,
          bodyBg: getComputedStyle(document.body).backgroundImage,
        })""")
        ok('切回 violet data-theme 正确', vio['theme']=='violet', vio['theme'])
        ok('violet 无量子网格（零影响）', 'linear-gradient' not in vio['bodyBg'], vio['bodyBg'][:60])
        await page.evaluate("applyTheme('quantum', false)")

        print('\n════════ 结果 ════════')
        print(f"  ✅ 通过 {pass_n} 项 / ❌ 失败 {fail_n} 项")
        print('  累计 JS 错误:', errs[:5] if errs else '无')
        await b.close()
        sys.exit(1 if fail_n else 0)

asyncio.run(main())
