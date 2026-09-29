import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, reachable } from './fixtures/composer-gallery-server.mjs';

const capabilities = { available: true, streaming: true, model: 'stepaudio-2.5-tts', provider: 'stepfun-plan', voice: 'linjiajiejie', voiceLabel: '邻家姐姐', maxChars: 2000 };
async function prepare(t, width) {
  const fixture = await setup(t, width), { page } = fixture;
  await page.addInitScript(() => {
    window.__spoken = []; window.__cancelled = 0;
    window.__voices = [{ voiceURI: 'xiaoxiao', name: '小晓', lang: 'zh-CN' }, { voiceURI: 'xiaoyun', name: '小云', lang: 'zh-TW' }];
    const synth = Object.assign(new EventTarget(), {
      getVoices: () => window.__voices, cancel() { window.__cancelled++; }, pause() {}, resume() {},
      speak(u) { window.__spoken.push({ text: u.text, voice: u.voice?.voiceURI, lang: u.lang }); u.onstart?.(); },
    });
    Object.defineProperty(window, 'speechSynthesis', { value: synth });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  });
  await page.route('**/api/tts/capabilities', route => route.fulfill({ json: capabilities }));
  await page.reload();
  await fixture.input.waitFor();
  return fixture;
}
async function openSound(page) {
  await page.getByRole('button', { name: '查看情绪潮汐与真人形象' }).click();
  await page.getByRole('tab', { name: '声音', exact: true }).click();
  return page.getByRole('tabpanel', { name: '声音', exact: true });
}

for (const width of [1440, 390, 320]) test(`composer call entry and consolidated sound settings are reachable at ${width}px`, async t => {
  const { page, errors } = await prepare(t, width);
  const call = page.locator('.sendbox-shell').getByRole('button', { name: '语音通话', exact: true });
  assert.equal(await call.count(), 1, 'voice call belongs inside the input shell');
  assert.ok(await reachable(call));
  for (const label of ['语音通话', '语音输入', '附加文件', '模型参数']) {
    const control = page.getByRole('button', { name: label, exact: true });
    assert.ok(await reachable(control), label);
    const box = await control.boundingBox();
    assert.ok(box.width >= (width < 900 ? 36 : 32) && box.height >= (width < 900 ? 44 : 32), label);
  }
  assert.equal(await page.getByRole('switch', { name: '自动朗读新回复' }).count(), 0);
  const sound = await openSound(page);
  const toggle = sound.getByRole('switch', { name: '自动朗读新回复' });
  const model = sound.getByRole('combobox', { name: '朗读通道' });
  const voice = sound.getByRole('combobox', { name: '朗读音色' });
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await model.inputValue(), 'device');
  await voice.selectOption('xiaoyun');
  await sound.getByRole('button', { name: '试听声音' }).click();
  assert.deepEqual(await page.evaluate(() => window.__spoken.map(v => [v.voice, v.lang])), [['xiaoyun', 'zh-TW']]);
  await sound.getByRole('button', { name: '停止试听' }).waitFor();
  const cancelled = await page.evaluate(() => window.__cancelled);
  await page.getByRole('tab', { name: '情绪', exact: true }).click();
  assert.ok(await page.evaluate(n => window.__cancelled > n, cancelled), 'leaving sound stops its preview');
  await page.getByRole('tab', { name: '声音', exact: true }).click();
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await model.selectOption('cloud');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'switching engines requires fresh auto-read opt-in');
  await sound.getByText('邻家姐姐', { exact: true }).waitFor();
  await sound.getByText(/正文发送给阶跃/).waitFor();
  assert.equal(await sound.getByRole('combobox', { name: '朗读音色' }).count(), 0, 'one fixed cloud voice is not a fake selector');
  await model.selectOption('device');
  await page.screenshot({ path: `tmp/speech-settings-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: '关闭形象面板' }).click();
  assert.ok(await page.getByRole('button', { name: '查看情绪潮汐与真人形象' }).evaluate(el => el === document.activeElement));
  await page.screenshot({ path: `tmp/speech-composer-${width}.png`, fullPage: true });
  await page.reload(); await openSound(page);
  assert.equal(await voice.inputValue(), 'xiaoyun');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'reload never opts into automatic playback');
  assert.equal(await page.evaluate(() => window.__spoken.length), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
});

for (const width of [1440, 390, 320]) test(`compact composer reserves room for a long model name at ${width}px`, async t => {
  const { page, errors } = await setup(t, width);
  await page.route('**/api/models', route => route.fulfill({ json: {
    models: [{ provider: 'fixture', id: 'long-model', name: 'Claude Sonnet 4.5 Thinking' }],
    current: { provider: 'fixture', id: 'long-model' },
  } }));
  await page.reload();
  const model = page.locator('.composer-toolbar [data-slot="model-trigger"]');
  await model.getByText('Claude Sonnet 4.5 Thinking', { exact: true }).waitFor();
  const modelBox = await model.boundingBox();
  assert.ok(modelBox.width >= (width >= 900 ? 200 : width >= 390 ? 160 : 96), 'model gets the available width instead of the old narrow cap');
  const buttons = page.locator('.composer-actions').getByRole('button');
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    assert.ok(box.width <= (width < 900 ? 36 : 32), 'idle actions use compact widths');
    assert.ok(Math.abs(box.y + box.height / 2 - modelBox.y - modelBox.height / 2) <= 1, 'model and idle actions fit on one row');
    assert.ok(await reachable(button), 'adjacent controls remain independently clickable');
  }
  assert.ok(await reachable(model));
  await model.click();
  await page.getByRole('menuitemradio').filter({ hasText: 'Claude Sonnet 4.5 Thinking' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.matches('.composer-toolbar [data-slot="model-trigger"]'));
  assert.ok(await model.evaluate(el => el === document.activeElement));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
});

test('sound tabs support keyboard navigation and short mobile viewport scrolling', async t => {
  const { page, errors } = await prepare(t, 390);
  await page.setViewportSize({ width: 390, height: 400 });
  await openSound(page);
  const sound = page.getByRole('tab', { name: '声音', exact: true }), mood = page.getByRole('tab', { name: '情绪', exact: true });
  await sound.press('ArrowLeft'); assert.equal(await mood.getAttribute('aria-selected'), 'true');
  await mood.press('End'); assert.equal(await sound.getAttribute('aria-selected'), 'true');
  const preview = page.getByRole('button', { name: '试听声音' });
  await preview.scrollIntoViewIfNeeded(); assert.ok(await reachable(preview));
  const close = page.getByRole('button', { name: '关闭形象面板' });
  assert.ok(await reachable(close));
  await close.click();
  assert.deepEqual(errors, []);
});

test('late device voices refresh while open and unavailable cloud has an explicit retry', async t => {
  const { page } = await prepare(t, 390);
  await page.route('**/api/tts/capabilities', route => route.fulfill({ json: { available: false, reason: '未配置可用的阶跃语音模型或密钥' } }));
  await page.reload();
  const sound = await openSound(page);
  await page.evaluate(() => { window.__voices.push({ voiceURI: 'new', name: '新音色', lang: 'zh-CN' }); window.speechSynthesis.dispatchEvent(new Event('voiceschanged')); });
  await sound.getByRole('combobox', { name: '朗读音色' }).selectOption('new');
  await sound.getByRole('combobox', { name: '朗读通道' }).selectOption('cloud');
  assert.ok(await sound.getByRole('button', { name: '试听声音' }).isDisabled());
  await sound.getByText('未配置可用的阶跃语音模型或密钥').waitFor();
  await page.route('**/api/tts/capabilities', route => route.fulfill({ json: capabilities }));
  await sound.getByRole('button', { name: '重试检测' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="试听声音"]')?.disabled);
  await sound.getByText('邻家姐姐', { exact: true }).waitFor();
});
