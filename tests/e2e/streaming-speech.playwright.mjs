import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './fixtures/composer-gallery-server.mjs';

const capabilities = { available: true, streaming: true, model: 'stepaudio-2.5-tts', voice: 'linjiajiejie', voiceLabel: '邻家姐姐' };
async function prepare(t, mode = 'device') {
  const fixture = await setup(t, 390), { page } = fixture;
  const posted = []; let run = 0;
  await page.route('**/api/tts/capabilities', route => route.fulfill({ json: capabilities }));
  await page.route('**/api/runs', route => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { runId: `live-${++run}`, sessionId: 'isolated', status: 'running', lastSeq: 0 } });
  });
  await page.addInitScript(() => {
    window.__heard = []; window.__tts = []; window.__runs = {}; window.__pcm = []; window.__mic = 0;
    Object.defineProperty(window, 'speechSynthesis', { value: Object.assign(new EventTarget(), {
      getVoices: () => [], cancel() {}, pause() {}, resume() {},
      speak(utterance) { window.__heard.push(utterance); utterance.onstart?.(); },
    }) });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    navigator.mediaDevices.getUserMedia = async () => { window.__mic++; throw new Error('No microphone in read-aloud tests'); };
    const originalCreate = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = originalCreate.call(this), start = source.start.bind(source);
      source.start = at => { window.__pcm.push(at); start(at); }; return source;
    };
    const originalFetch = window.fetch.bind(window), encoder = new TextEncoder();
    window.__push = (type, data = {}) => {
      const stream = window.__runs[Object.keys(window.__runs).at(-1)];
      stream.controller.enqueue(encoder.encode(`data: ${JSON.stringify({ runId: stream.id, seq: ++stream.seq, type, data })}\n\n`));
    };
    window.fetch = (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (/^\/api\/runs\/live-\d+\/events$/.test(path)) {
        const id = path.split('/')[3];
        const body = new ReadableStream({ start(controller) { window.__runs[id] = { id, controller, seq: 0 }; } });
        return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
      }
      if (path === '/api/tts/stream') {
        const entry = { text: JSON.parse(init.body).text, aborted: false }; window.__tts.push(entry);
        const body = new ReadableStream({ start(controller) {
          entry.controller = controller;
          entry.finish = () => { controller.enqueue(encoder.encode('{"type":"done"}\n')); controller.close(); };
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'audio', data: btoa('\0'.repeat(24000)), sampleRate: 24000 }) + '\n'));
        } });
        init.signal.addEventListener('abort', () => { entry.aborted = true; }, { once: true });
        return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }));
      }
      return originalFetch(input, init);
    };
  });
  await page.reload(); await fixture.input.waitFor();
  await page.getByRole('button', { name: '查看情绪潮汐与真人形象' }).click();
  await page.getByRole('tab', { name: '声音', exact: true }).click();
  if (mode === 'cloud') await page.getByRole('combobox', { name: '朗读通道' }).selectOption('cloud');
  await page.getByRole('switch', { name: '自动朗读新回复' }).click();
  await page.getByRole('button', { name: '关闭形象面板' }).click();
  return { ...fixture, posted };
}
async function send({ page, input }, text = '请解释一下') {
  await input.fill(text); await input.press('Enter');
  await page.waitForFunction(() => Object.keys(window.__runs).length > 0);
}
test('device follows live text, finishes only the tail and exposes stop before completion', async t => {
  const f = await prepare(t), { page, errors } = f;
  await send(f);
  await page.evaluate(() => window.__push('delta', { text: '第一句已经生成。' }));
  await page.waitForFunction(() => window.__heard.length === 1);
  await page.getByRole('button', { name: '停止朗读', exact: true }).waitFor();
  await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
  await page.getByRole('button', { name: '继续朗读', exact: true }).click();
  await page.evaluate(() => { window.__heard[0].onend(); window.__push('delta', { text: '这是尾句' }); window.__push('completed'); });
  await page.waitForFunction(() => window.__heard.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__heard.map(u => u.text)), ['第一句已经生成。', '这是尾句']);
  assert.equal(await page.evaluate(() => window.__mic), 0);
  assert.deepEqual(errors, []);
});

test('manual device playback is not cancelled by new text when automatic reading is off', async t => {
  const f = await prepare(t), { page, errors } = f;
  await page.reload(); await f.input.waitFor();
  await send(f, '第二条问题');
  await page.getByRole('button', { name: '查看情绪潮汐与真人形象' }).click();
  await page.getByRole('tab', { name: '声音', exact: true }).click();
  await page.getByRole('button', { name: '试听声音', exact: true }).click();
  await page.waitForFunction(() => window.__heard.length === 1);
  await page.evaluate(() => window.__push('delta', { text: '新文本不应打断手动朗读。' }));
  await page.getByText('新文本不应打断手动朗读。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止试听', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
test('cloud schedules PCM while both reply and TTS are open; stop cancels without a replay', async t => {
  const f = await prepare(t, 'cloud'), { page, errors } = f;
  await send(f);
  await page.evaluate(() => window.__push('delta', { text: '这句话正在生成并播放。' }));
  await page.waitForFunction(() => window.__pcm.length > 0);
  assert.equal(await page.evaluate(() => window.__tts.length), 1);
  await page.getByRole('button', { name: '停止朗读', exact: true }).click();
  await page.waitForFunction(() => window.__tts[0].aborted);
  await page.evaluate(() => { window.__push('delta', { text: '停止后的句子。' }); window.__push('completed'); });
  await page.waitForFunction(() => !document.querySelector('.streaming-caret'));
  assert.equal(await page.evaluate(() => window.__tts.length), 1);
  assert.equal(await page.evaluate(() => window.__mic), 0);
  assert.deepEqual(errors, []);
});
test('parameter sliders reach the next request and reset removes overrides', async t => {
  const f = await prepare(t), { page, posted } = f;
  await page.getByRole('button', { name: '模型参数', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '模型参数', exact: true });
  await panel.getByText('模型默认 · 调节后启用自定义').waitFor();
  const temperature = panel.getByRole('slider', { name: 'temperature（发散度）' });
  await temperature.focus(); await temperature.press('Home'); await temperature.press('ArrowRight');
  await panel.getByText('自定义 · 下次发送生效').waitFor();
  await f.input.click(); await send(f);
  assert.deepEqual(posted[0].params, { temperature: 0.1, top_p: 0.95 });
  await page.evaluate(() => window.__push('completed'));
  await page.waitForFunction(() => !document.querySelector('.streaming-caret'));
  await page.getByRole('button', { name: '模型参数', exact: true }).click();
  await panel.getByRole('button', { name: '恢复默认', exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('pi_params')), null);
  await f.input.click(); await send(f, '使用默认参数');
  await page.waitForFunction(() => Object.keys(window.__runs).length === 2);
  assert.equal(posted[1].params, undefined);
});
