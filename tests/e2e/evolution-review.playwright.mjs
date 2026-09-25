import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceFixture } from '../helpers/task-evidence-fixture.mjs';
import { initEvolutionApi, proposeEvolution, listEvolution, startEvolutionEvaluation, applyEvolution } from '../../engine/evolution-api.mjs';
import { json, readBody } from '../../engine/http-utils.mjs';
const { chromium } = await import(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.YUANSHU_CHROMIUM_PATH ? { executablePath: process.env.YUANSHU_CHROMIUM_PATH } : {}) });
const dist = path.resolve(process.env.YUANSHU_EVIDENCE_DIST || 'tmp/verification-dist');
try {
  for (const width of [1440, 390]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-prompt-browser-'));
    const prompts = path.join(root, 'prompts'); fs.mkdirSync(prompts);
    const original = 'You are a careful helper. Follow the task and deliver complete answers grounded in evidence.';
    fs.writeFileSync(path.join(prompts, 'demo.md'), original);
    const model = { provider: 'fixture', id: 'no-network' };
    let fail = false, calls = 0;
    initEvolutionApi({ root, prompts, chat: async (_m, messages, opts) => {
      assert.equal(opts.tools, false);
      if (messages[0].content.includes('提示词进化引擎')) return { text: JSON.stringify({ variants: [{ label: '候选A', content: original + ' State uncertainty.' }] }) };
      calls++;
      if (fail) return { error: 'fixture interruption' };
      const sys = messages[0].content;
      return { text: sys.includes('出题器') ? '{"questions":["事实不全怎么办？","如何验收？"]}' : sys.includes('严格评委') ? '85/100' :
        sys.includes('State uncertainty') ? '候选回答：明确不确定性，并核对证据。' : '原版回答：按要求完成。', usedModel: model };
    } });
    const { id } = await proposeEvolution({ name: 'demo', model });
    await startEvolutionEvaluation(id, model).completion;
    const f = await evidenceFixture(dist, async (req, res, url) => {
      if (url === '/api/evolution/proposals') { json(res, 200, { proposals: listEvolution() }); return true; }
      if (url === '/api/evolution/apply') { const b = await readBody(req); json(res, 200, applyEvolution(b.id, b.variantIndex, b.review)); return true; }
      if (url === '/api/evolution/evaluate') { const b = await readBody(req); const { completion, ...result } = startEvolutionEvaluation(b.id, model); json(res, 200, result); return true; }
      return false;
    });
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.routeWebSocket('**/*', ws => ws.close());
      await page.addInitScript(token => localStorage.setItem('yuanshu_access_token', token), f.token);
      const enter = async () => {
        await page.goto(`${f.base}/#apps`); await page.reload();
        if (width < 900) await page.getByRole('combobox', { name: '选择应用工具' }).selectOption('evolution');
        else await page.getByRole('button', { name: '进化引擎', exact: true }).click();
      };
      await enter();
      await page.getByText('查看原版与候选回答，独立验收', { exact: true }).click();
      const apply = page.getByRole('button', { name: '确认对照结果并应用', exact: true });
      assert.equal(await apply.isEnabled(), false);
      await page.getByLabel('第 1 题对比结论').selectOption('better');
      await page.getByLabel('第 2 题对比结论').selectOption('worse');
      await page.getByLabel('核对说明').fill('核对事实和不确定性');
      assert.equal(await apply.isEnabled(), false);
      await page.getByLabel('第 2 题对比结论').selectOption('equal');
      assert.equal(await apply.isEnabled(), true);
      // A new evaluation must reset all human choices, not reuse a previous approval.
      await page.getByRole('button', { name: '跑评测（使用模型额度）', exact: true }).click();
      await page.getByText('查看原版与候选回答，独立验收', { exact: true }).click();
      assert.equal(await page.getByLabel('第 1 题对比结论').inputValue(), '');
      assert.equal(await apply.isEnabled(), false);
      await page.getByLabel('第 1 题对比结论').selectOption('better');
      await page.getByLabel('第 2 题对比结论').selectOption('equal');
      await page.getByLabel('核对说明').fill('重新逐题核对，无退步');
      const geometry = await apply.evaluate(el => ({ right: el.closest('details').getBoundingClientRect().right, pageWidth: document.documentElement.scrollWidth }));
      assert.ok(geometry.right <= width && geometry.pageWidth <= width + 1, JSON.stringify(geometry));
      const screenshot = path.resolve(`tmp/evolution-review-${width}.png`);
      await apply.scrollIntoViewIfNeeded(); await page.screenshot({ path: screenshot });
      await apply.click(); await page.getByText('已应用', { exact: true }).waitFor();
      const p = listEvolution()[0]; assert.equal(p.approval.source, 'human');
      assert.equal(fs.readFileSync(path.join(prompts, p.backup), 'utf8'), original);
      assert.equal(fs.readFileSync(path.join(prompts, 'demo.md'), 'utf8'), original + ' State uncertainty.');
      // Failed evaluation remains visible and cannot open an approval form.
      const next = await proposeEvolution({ name: 'demo', model }); fail = true;
      await startEvolutionEvaluation(next.id, model).completion;
      await enter(); await page.getByText('评测未完成：评测调用失败或空回复', { exact: true }).waitFor();
      assert.equal(await apply.count(), 0); assert.deepEqual(errors, []);
      console.log(JSON.stringify({ width, comparisons: 'passed', reset: 'passed', applyBackup: 'passed', failedState: 'passed', layout: 'passed', calls, screenshot }));
    } finally {
      await context.close(); await f.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); }
