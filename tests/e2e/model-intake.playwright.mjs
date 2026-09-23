// Isolated browser routes: exercises the shipped UI without altering real credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.YUANSHU_PLAYWRIGHT_MODULE || 'playwright');
const token = fs.readFileSync(new URL('../../.token', import.meta.url), 'utf8').trim();
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(), errors = [], writes = [];
    let registered = false, verification = null, failCatalog = true;
    const model = () => ({ provider: 'fixture', id: 'test-native', name: '模型接入验收', api: 'anthropic-messages', capabilities: { chat: true }, verification });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(t => localStorage.setItem('yuanshu_access_token', t), token);
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()).pathname;
      const json = value => route.fulfill({ json: value });
      if (url === '/api/models') return json({ models: registered ? [model()] : [], current: null, cwd: 'fixture' });
      if (url === '/api/models/manage') return json({ providers: registered ? [{ provider: 'fixture', baseUrl: 'https://example.test/gateway/v2', api: 'anthropic-messages', hasKey: true, modelCount: 1 }] : [] });
      if (url === '/api/keys/presets') return json({ presets: { anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages' } } });
      if (request.method() !== 'GET') {
        const body = request.postDataJSON(); writes.push({ url, body });
        if (url === '/api/models/discover') {
          if (failCatalog) { failCatalog = false; return route.fulfill({ status: 422, json: { error: '目录拒绝鉴权，可手动登记', upstreamStatus: 401 } }); }
          return json({ models: [{ id: 'test-native' }], source: 'manual' });
        }
        if (url === '/api/models/add') { registered = true; return json({ saved: true, modelCount: 1, discoveredCount: 1 }); }
        if (url === '/api/models/verify') {
          verification = { ok: true, status: 'verified', checkedAt: new Date().toISOString(), reportedModel: 'native-upstream', message: '已收到文本回答；工具、视觉及媒体能力尚未验证' };
          return json(verification);
        }
        if (url === '/api/models/remove') { registered = false; return json({ ok: true }); }
        return json({ error: 'No production writes in browser acceptance' });
      }
      if (url === '/api/run/overview') return json({ active: [], recent: [] });
      if (url === '/api/sessions') return json({ sessions: [] });
      return route.continue();
    });
    await page.goto('http://127.0.0.1:8787/#models');
    await page.getByRole('button', { name: '添加 API', exact: true }).click();
    await page.getByLabel('服务商名称', { exact: true }).fill('fixture');
    await page.getByLabel(/^接口协议/).selectOption('anthropic-messages');
    await page.getByLabel('API Key', { exact: true }).fill('fixture-not-a-real-key');
    await page.getByLabel(/^API 地址/).fill('https://example.test/gateway/v2');
    await page.getByRole('button', { name: '发现模型', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '目录拒绝鉴权' }).waitFor();
    assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), 'fixture-not-a-real-key');
    await page.getByLabel(/^手动模型 ID/).fill('test-native');
    await page.getByRole('button', { name: '预览手动登记', exact: true }).click();
    await page.getByText('待手动登记 1 个模型 · 尚未验证调用', { exact: true }).waitFor();
    await page.getByRole('button', { name: '保存接入', exact: true }).click();
    await page.getByRole('heading', { name: '模型接入验收', exact: true }).waitFor();
    await page.getByText('已保存 fixture · 1 个已配置模型。请按需验证文本调用。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '验证文本', exact: true }).click();
    await page.getByText('文本验证通过', { exact: true }).waitFor();
    await page.getByText('上游报告模型：native-upstream', { exact: true }).waitFor();
    assert.equal(writes.filter(w => w.url === '/api/models/add').length, 1);
    assert.equal(writes.filter(w => w.url === '/api/models/verify').length, 1);
    assert.equal(writes[0].body.api, 'anthropic-messages');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(os.tmpdir(), `yuanshu-model-intake-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await page.getByLabel(/API Key/).inputValue(), '');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '重新发现', exact: true }).click();
    await page.getByText(/目录已刷新 · 发现 1 个/).waitFor();
    await page.getByRole('button', { name: '移除 fixture', exact: true }).click();
    await page.getByRole('button', { name: '确认移除', exact: true }).click();
    await page.getByText('已移除 fixture', { exact: true }).waitFor();
    await page.getByRole('heading', { name: '模型接入验收', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('heading', { name: '模型接入验收', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport: viewport.width, discovery401: 'retained form and login', manualNativeSave: 'passed', verificationAndRefresh: 'passed', editRescanRemove: 'passed', overflow: false }));
    await context.close();
  }
} finally { await browser.close(); }
