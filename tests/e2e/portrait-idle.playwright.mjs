import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { setup } from './fixtures/composer-gallery-server.mjs';
import { GALLERIES, imageForSkin } from '../../frontend/src/components/xiaoyu/widget-state.mjs';
const releaseVersion = JSON.parse(fs.readFileSync(new URL('../../version.json', import.meta.url), 'utf8')).version;

for (const gallery of GALLERIES) {
  test(`idle and unavailable facts stay in ${gallery.id}`, async t => {
    const { page, errors } = await setup(t);
    await page.route('**/api/sessions/*/stream?*', route => route.continue());
    await page.route('**/api/companion/facts?*', route => route.fulfill({ json: {
      sessionId: 'isolated', serverEpoch: 'idle-test', revision: 'idle', known: true,
      currentBusy: false, reading: false, otherBusy: 0, evidenceIds: [],
    } }));
    await page.addInitScript(id => {
      localStorage.setItem('xiaoyu_skin', id);
      const now = Date.now.bind(Date);
      window.__idleOffset = 0;
      Date.now = () => now() + window.__idleOffset;
    }, gallery.id);
    await page.reload();
    const portrait = page.locator('.xiaoyu-widget .companion-portrait');
    for (const [offset, action] of [[0, 'listening'], [25_000, 'resting'], [100_000, 'daydreaming'], [290_000, 'resting'], [335_000, 'listening']]) {
      await page.evaluate(value => { window.__idleOffset = value; }, offset);
      try {
        await page.waitForFunction(expected => document.querySelector('.xiaoyu-widget .companion-portrait')?.dataset.action === expected, action, { timeout: 12000 });
      } catch (error) {
        t.diagnostic(JSON.stringify({ expected: action, actual: await portrait.getAttribute('data-action'), errors }));
        throw error;
      }
      assert.equal(await portrait.getAttribute('data-skin'), gallery.id);
      await portrait.locator('img').evaluate(img => img.decode());
      const currentUrl = new URL(await portrait.locator('img').evaluate(img => img.currentSrc));
      assert.equal(currentUrl.pathname, imageForSkin(gallery.id, action));
      assert.equal(currentUrl.searchParams.get('v'), releaseVersion, 'idle poses must not reuse an old-release image cache');
    }
    await page.route('**/api/companion/facts?*', route => route.fulfill({ status: 503, json: {} }));
    await page.waitForFunction(() => document.querySelector('.xiaoyu-widget .companion-portrait')?.dataset.action === 'neutral', null, { timeout: 12000 });
    assert.equal(await portrait.getAttribute('data-skin'), gallery.id);
    await portrait.locator('img').evaluate(img => img.decode());
    const neutralUrl = new URL(await portrait.locator('img').evaluate(img => img.currentSrc));
    assert.equal(neutralUrl.pathname, imageForSkin(gallery.id, 'neutral'));
    assert.equal(neutralUrl.searchParams.get('v'), releaseVersion);
    assert.deepEqual(errors, []);
  });
}
