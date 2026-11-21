import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phoneTool } from '../../engine/phone/tools.mjs';
import { ocrElements, ocrCenter } from '../../engine/phone/ocr.mjs';

// 2026-11-21：微信里 screen_read 控件表一直是空的，快模型又看不了截图，只好猜坐标盲点，点开了打车小程序。
// 控件树为空时自动截图识字，给出 o 编号的文字列表，tap 编号点文字中心。
const PNG = Buffer.from('fake').toString('base64');
function fakeHub(screens) {
  const sent = [];
  const dev = { id: 'p1', caps: ['screen'] };
  return {
    sent,
    target: async () => dev,
    send: async (action, args) => { sent.push({ action, args }); return screens[action] ?? { ok: true }; },
  };
}
const OCR = { width: 1080, height: 2400, lines: [
  { text: '元枢正在操作手机停止×', bounds: [228, 97, 507, 119] },
  { text: '精英汇', bounds: [200, 600, 300, 640] },
  { text: '搜索', bounds: [100, 200, 160, 240] },
] };

test('识字结果按阅读顺序编号，去掉元枢浮条，按截图缩放换回屏幕坐标', () => {
  const els = ocrElements(OCR, 0.5);
  assert.deepEqual(els.map(e => e.text), ['搜索', '精英汇']);
  assert.deepEqual(els[1], { id: 'o2', text: '精英汇', bounds: [400, 1200, 600, 1280] });
  assert.deepEqual(ocrCenter(els, 'o2'), { x: 500, y: 1240 });
  assert.equal(ocrCenter(els, 'o9'), null);
});

test('控件表为空时自动截图识字；tap o 编号换成坐标下发', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-ocr-'));
  const hub = fakeHub({ screen_read: { package: 'com.tencent.mm', elements: [] }, screenshot: { png: PNG, scale: 1 } });
  const ocr = async (file) => { assert.ok(fs.existsSync(file)); return OCR; };
  const r = JSON.parse((await phoneTool(hub, { action: 'screen_read' }, {}, { wsRoot: ws, ocr })).text);
  assert.equal(r.source, 'ocr');
  assert.equal(r.package, 'com.tencent.mm');
  assert.deepEqual(r.elements.map(e => e.id + e.text), ['o1搜索', 'o2精英汇']);
  assert.deepEqual(hub.sent.map(s => s.action), ['screen_read', 'screenshot']);

  await phoneTool(hub, { action: 'tap', elementId: 'o2' }, {}, { wsRoot: ws, ocr });
  const tap = hub.sent.at(-1);
  assert.equal(tap.action, 'tap');
  assert.equal(tap.args.elementId, undefined);
  assert.deepEqual([tap.args.x, tap.args.y], [250, 620]);

  const stale = await phoneTool(hub, { action: 'tap', elementId: 'o7' }, {}, { wsRoot: ws, ocr });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /识字编号已失效/);
});

test('有控件就不截图；screenshot 也附带识字；识别不了时说明原因', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-ocr-'));
  const hub = fakeHub({ screen_read: { elements: [{ id: '1', text: '发送' }] }, screenshot: { png: PNG } });
  await phoneTool(hub, { action: 'screen_read' }, {}, { wsRoot: ws, ocr: async () => OCR });
  assert.deepEqual(hub.sent.map(s => s.action), ['screen_read']);
  const shot = JSON.parse((await phoneTool(hub, { action: 'screenshot' }, {}, { wsRoot: ws, ocr: async () => OCR })).text);
  assert.ok(shot.file && shot.elements.length === 2);
  const none = JSON.parse((await phoneTool(hub, { action: 'screen_ocr' }, {}, { wsRoot: ws, ocr: async () => null })).text);
  assert.deepEqual(none.elements, []);
  assert.match(none.ocrError, /OCR/);
});
