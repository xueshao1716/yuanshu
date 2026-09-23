import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evidenceFixture } from '../helpers/task-evidence-fixture.mjs';
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROMIUM_PATH ? { executablePath: process.env.YUANSHU_CHROMIUM_PATH } : {}) });
const dist = path.resolve(process.env.YUANSHU_EVIDENCE_DIST || 'tmp/verification-dist');
try {
  for (const width of [1440, 390]) {
    const f = await evidenceFixture(dist);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.routeWebSocket('**/*', ws => ws.close());
      await page.addInitScript(token => localStorage.setItem('yuanshu_access_token', token), f.token);
      const enter = async () => {
        await page.goto(`${f.base}/#apps`);
        await page.reload();
        if (width < 900) await page.getByRole('combobox', { name: '选择应用工具' }).selectOption('evolution');
        else await page.getByRole('button', { name: '进化引擎', exact: true }).click();
      };
      await enter();
      const panel = page.getByRole('region', { name: '真实任务验收', exact: true });
      await panel.getByRole('button', { name: /隔离验收 image/ }).click();
      const editor = page.locator('[aria-label="任务验收详情"]');
      const pass = editor.getByRole('button', { name: '标记合格', exact: true });
      await pass.waitFor();
      assert.equal(await pass.isEnabled(), false);
      assert.equal(await editor.getByRole('checkbox').isChecked(), false);
      const img = editor.getByRole('img', { name: '本次交付图片' });
      await img.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('img[alt="本次交付图片"]')?.naturalWidth > 0);
      const submit = async (button, note, skill = false) => {
        if (skill) await editor.getByRole('checkbox').check();
        await editor.getByRole('textbox', { name: '验收说明' }).fill(note);
        const response = page.waitForResponse(r => r.url().includes('/api/dream/evidence/') && r.request().method() === 'POST');
        await editor.getByRole('button', { name: button, exact: true }).click();
        const result = await response; assert.equal(result.status(), 200);
        await editor.getByText(/验收已保存/).waitFor();
      };
      await submit('标记合格', '核对了图片和需求', true);
      assert.equal(f.service.episodes().length, 1);
      await enter();
      await panel.getByRole('button', { name: /隔离验收 image/ }).click();
      await editor.getByText('验收：合格 · 技能样本：可评分', { exact: true }).waitFor();
      assert.equal(await editor.getByRole('checkbox').isChecked(), false);
      await submit('撤销验收', '撤回这次验收'); assert.equal(f.service.episodes().length, 0);
      await submit('标记合格', '重新核对', true); assert.equal(f.service.episodes().length, 1);
      fs.appendFileSync(f.image, 'changed');
      assert.equal(f.service.get(f.runs.image).acceptance, 'stale');
      assert.equal(f.service.episodes().length, 0);
      await editor.getByRole('textbox', { name: '验收说明' }).fill('旧页面不能覆盖新内容');
      const conflict = page.waitForResponse(r => r.url().includes('/api/dream/evidence/') && r.request().method() === 'POST');
      await pass.click(); assert.equal((await conflict).status(), 409);
      await editor.getByText(/请刷新记录/).waitFor();
      await panel.getByRole('button', { name: '刷新验收记录' }).click();
      await editor.getByText(/验收：旧验收已失效/).waitFor();
      for (const kind of ['text', 'document', 'code']) {
        await panel.getByRole('button', { name: new RegExp(`隔离验收 ${kind}`) }).click();
        await editor.getByRole('checkbox').waitFor();
        await submit('标记合格', `核对${kind}交付`, false);
      }
      assert.deepEqual(f.service.list().summary.coverage, { text: 1, image: 0, document: 1, code: 1, media: 0, other: 0 });
      await panel.getByRole('button', { name: /隔离验收 team/ }).click();
      await editor.getByText('天团交付请使用原有送审流程').waitFor();
      assert.equal(await editor.getByRole('button', { name: '标记合格' }).count(), 0);
      await panel.getByRole('button', { name: /隔离验收 text/ }).click();
      for (const button of await editor.getByRole('button').all()) assert.ok((await button.boundingBox()).height >= 44);
      const geometry = await panel.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, right: el.getBoundingClientRect().right }));
      assert.ok(geometry.scroll <= geometry.width + 1 && geometry.right <= width, JSON.stringify(geometry));
      assert.deepEqual(errors, []);
      const endpoint = `${f.base}/api/dream/evidence/${f.runs.text}`, headers = { Authorization: `Bearer ${f.token}` };
      assert.equal((await fetch(endpoint)).status, 401);
      assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{broken' })).status, 400);
      assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ note: 'x'.repeat(30000) }) })).status, 413);
      console.log(JSON.stringify({ width, acceptance: 'passed', persistence: 'passed', revoke: 'passed', staleConflict: 'passed', coverage: 'passed', teamBoundary: 'passed', layout: 'passed', http: 'passed' }));
    } finally { await context.close(); await f.close(); }
  }
} finally { await browser.close(); }
