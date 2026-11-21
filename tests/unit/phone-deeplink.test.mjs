import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneTool, validate, navigateUrls, PHONE_TOOL_SCHEMA } from '../../engine/phone/tools.mjs';

// 2026-11-21：能不碰屏幕就不碰——通知里直接回复、系统设置直达、地图导航。
function fakeHub(handler) {
  const sent = [];
  return { sent, target: async () => ({ id: 'p1', caps: ['apps', 'notifications'] }), send: async (action, args) => { sent.push({ action, args }); return handler(action, args); } };
}

test('open_settings 翻译成 intent: 链接，手机端不用新增动作', async () => {
  const hub = fakeHub(() => ({ ok: true }));
  await phoneTool(hub, { action: 'open_settings', page: 'wifi' });
  assert.deepEqual(hub.sent[0], { action: 'open_url', args: { url: 'intent:#Intent;action=android.settings.WIFI_SETTINGS;end', sessionId: '' } });
  assert.match(validate('open_settings', { page: 'xx' }), /page 只能是/);
});

test('navigate 依次试高德、百度、系统地图；只有「没装」才换下一个', async () => {
  const hub = fakeHub((_a, args) => { if (args.url.startsWith('amapuri')) throw new Error('手机上没有能打开这个链接的应用'); return { ok: true }; });
  const r = JSON.parse((await phoneTool(hub, { action: 'navigate', destination: '兰州大学', mode: 'walk' })).text);
  assert.equal(r.via, 'baidumap');
  assert.match(hub.sent[1].args.url, /destination=%E5%85%B0.*mode=walking/);
  assert.match(navigateUrls('x')[0], /t=0/);
  assert.equal(navigateUrls('x').at(-1), 'geo:0,0?q=x');

  const busy = fakeHub(() => { throw new Error('手机 30 秒内没有回应'); });
  assert.match((await phoneTool(busy, { action: 'navigate', destination: 'x' })).text, /没有回应/);
  assert.equal(busy.sent.length, 1, '别的错误不该继续试下一个');
});

test('notif_reply 需要 key 和 text，原样下发给手机', async () => {
  assert.match(validate('notif_reply', { key: 'k' }), /text/);
  const hub = fakeHub(() => ({ ok: true }));
  await phoneTool(hub, { action: 'notif_reply', key: '0|com.tencent.mm|1', text: '大家好' });
  assert.deepEqual(hub.sent[0], { action: 'notif_reply', args: { key: '0|com.tencent.mm|1', text: '大家好', sessionId: '' } });
  assert.match(validate('key', { key: 'power' }), /key 只能是/);
  assert.match(PHONE_TOOL_SCHEMA.function.description, /notif_reply/);
});
