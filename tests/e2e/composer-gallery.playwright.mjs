import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { setup, reachable } from './fixtures/composer-gallery-server.mjs';
import { GALLERIES, imageForSkin } from '../../frontend/src/components/xiaoyu/widget-state.mjs';
import { portraitFor } from '../../frontend/src/components/xiaoyu/companion-state.mjs';
import { portraitAssetUrl } from '../../frontend/src/components/xiaoyu/portrait-asset.mjs';
const releaseVersion = JSON.parse(fs.readFileSync(new URL('../../version.json', import.meta.url), 'utf8')).version;

for (const width of [1440, 390]) {
  test(`slash menu is reachable and works with Chinese keyboard at ${width}`, async t => {
    const { page, input, errors } = await setup(t, width);
    await input.fill('/');
    const menu = page.getByRole('listbox', { name: '斜杠命令' });
    await menu.waitFor();
    assert.equal(await reachable(menu.getByRole('option').first()), true, 'slash options are not covered');
    await input.fill('／he');
    await menu.getByRole('option', { name: /\/help/ }).click();
    assert.equal(await input.inputValue(), '');
    await page.getByText(/可用命令：/).waitFor();
    assert.deepEqual(errors, []);
  });
  test(`bare mention offers files and attaches by touch/click at ${width}`, async t => {
    const { page, input, errors } = await setup(t, width);
    await input.fill('@');
    const item = page.getByRole('option', { name: /notes.txt/ });
    await item.waitFor();
    assert.equal(await reachable(item), true);
    if (width < 900) await item.tap(); else await item.click();
    await page.locator('.mobile-composer').getByRole('button', { name: '✕', exact: true }).waitFor();
    assert.equal(await input.inputValue(), '');
    assert.deepEqual(errors, []);
  });
  test(`mention at caret preserves following text at ${width}`, async t => {
    const { page, input } = await setup(t, width);
    await input.fill('请参考 @notes 然后解释');
    await input.evaluate(el => { el.setSelectionRange(9, 9); el.dispatchEvent(new Event('select', { bubbles: true })); });
    await input.press('ArrowLeft');
    await input.press('ArrowRight');
    await page.getByRole('option', { name: /notes.txt/ }).click();
    await page.locator('.mobile-composer').getByRole('button', { name: '✕', exact: true }).waitFor();
    assert.equal(await input.inputValue(), '请参考  然后解释');
  });
  test(`IME confirmation never executes a command at ${width}`, async t => {
    const { page, input } = await setup(t, width);
    await input.fill('/');
    const menu = page.getByRole('listbox', { name: '斜杠命令' });
    await menu.waitFor();
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
    assert.equal(await input.inputValue(), '/', 'confirming IME must not create a session or erase draft');
  });
  test(`all four portrait galleries agree across widget, panel and tide at ${width}`, async t => {
    const { page, errors } = await setup(t, width);
    const widget = page.locator('.xiaoyu-widget');
    for (const gallery of GALLERIES) {
      await widget.click();
      const panel = page.locator('#xiaoyu-panel');
      await panel.locator('.companion-settings > summary').click();
      await panel.getByRole('button', { name: new RegExp(gallery.label) }).click();
      const action = await widget.locator('.companion-portrait').getAttribute('data-action');
      const expected = portraitAssetUrl(gallery.id === 'portrait' ? portraitFor(action).src : imageForSkin(gallery.id, action), releaseVersion);
      for (const location of [widget, panel]) {
        const portrait = location.locator('.companion-portrait');
        assert.equal(await portrait.getAttribute('data-skin'), gallery.id);
        assert.equal(await portrait.locator('img').getAttribute('src'), expected);
        await portrait.locator('img').evaluate(img => img.decode());
      }
      assert.equal(await panel.getByRole('link', { name: '下载当前立绘' }).getAttribute('href'), expected);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '查看情绪潮汐与真人形象', exact: true }).click();
      const tide = page.getByRole('dialog', { name: '情绪潮汐与真人形象' });
      assert.equal(await tide.locator('.companion-portrait').getAttribute('data-skin'), gallery.id, 'tide must not silently switch to original gallery');
      assert.equal(await tide.locator('img').getAttribute('src'), expected);
      await page.keyboard.press('Escape');
    }
    await page.reload();
    await widget.waitFor();
    assert.equal(await widget.getAttribute('data-skin'), GALLERIES.at(-1).id, 'selected gallery survives refresh');
    assert.deepEqual(errors, []);
  });
}

test('obsolete file search cannot replace newer results', async t => {
  const { page, input } = await setup(t);
  let slow;
  await page.route('**/api/ws/search?*', route => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'old') { slow = route; return; }
    return route.fulfill({ json: { results: [{ name: 'new.txt', path: 'new.txt' }] } });
  });
  await input.fill('@old');
  await page.waitForRequest(r => r.url().includes('/api/ws/search?q=old'));
  await input.fill('@new');
  await page.getByRole('option', { name: /new.txt/ }).waitFor();
  await slow.fulfill({ json: { results: [{ name: 'old.txt', path: 'old.txt' }] } });
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole('option', { name: /old.txt/ }).count(), 0);
});

test('failed file read preserves mention text and offers retry', async t => {
  const { page, input } = await setup(t);
  await page.route('**/api/ws/read?*', route => route.fulfill({ status: 500, json: { error: 'fixture read failure' } }));
  await input.fill('参考 @notes');
  await page.getByRole('option', { name: /notes.txt/ }).click();
  await page.getByText('文件读取失败，请重新选择重试。', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '参考 @notes');
});

test('gallery change cannot display a previous gallery image while loading', async t => {
  const { page } = await setup(t);
  const widget = page.locator('.xiaoyu-widget');
  await widget.locator('img').evaluate(img => img.decode());
  await page.route('**/assets/portraits/*author-v2.webp*', () => {});
  await widget.click();
  const panel = page.locator('#xiaoyu-panel');
  await panel.locator('.companion-settings > summary').click();
  await panel.getByRole('button', { name: /小语自绘组/ }).click();
  const current = await widget.locator('img').evaluate(img => img.currentSrc);
  assert.ok(!current || current.includes('author-v2.webp'), 'old bitmap must not remain visible under the new gallery label: ' + current);
});

test('menus stay visible above an open mobile keyboard and support keyboard navigation', async t => {
  const { page, input } = await setup(t, 390);
  await page.setViewportSize({ width: 390, height: 400 });
  await page.evaluate(() => document.documentElement.classList.add('keyboard-open'));
  await input.fill('/');
  const menu = page.getByRole('listbox', { name: '斜杠命令' });
  assert.equal(await reachable(menu.getByRole('option').first()), true, 'first command cannot be above the viewport');
  for (let i = 0; i < 4; i++) await input.press('ArrowDown');
  assert.equal(await reachable(menu.getByRole('option').last()), true, 'keyboard highlight scrolls into view');
  await input.press('Enter');
  await page.getByText(/可用命令：/).waitFor();
  await input.fill('＠');
  await page.getByRole('option', { name: /notes.txt/ }).waitFor();
  assert.equal(await reachable(page.getByRole('option', { name: /notes.txt/ })), true);
  await input.press('Escape');
  assert.equal(await page.getByRole('listbox').count(), 0);
  await input.press('n');
  await page.getByRole('option', { name: /notes.txt/ }).waitFor();
  await input.fill('/');
  await menu.waitFor();
  await input.press('Escape');
  assert.equal(await page.getByRole('listbox').count(), 0);
});
