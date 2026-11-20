import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPhoneHub } from '../../engine/phone/hub.mjs';
import { phoneTool, validate, pickArgs, PHONE_TOOL_SCHEMA } from '../../engine/phone/tools.mjs';
import { parseUiXml } from '../../engine/phone/adb.mjs';

function fakeConn() {
  const req = new EventEmitter();
  const res = { writes: [], writableEnded: false, writeHead() {}, write(s) { this.writes.push(s); }, end() { this.writableEnded = true; } };
  return { req, res, cmds: () => res.writes.filter(w => w.startsWith('event: cmd')).map(w => JSON.parse(w.split('data: ')[1])) };
}

test('手机上线后指令经 SSE 下发，结果按 id 回传', async () => {
  const hub = createPhoneHub();
  const c = fakeConn();
  hub.connect(c.res, c.req, { deviceId: 'p1', name: 'Pixel', caps: 'apps,clipboard' });
  assert.deepEqual(hub.status().devices[0].caps, ['apps', 'clipboard']);
  const job = phoneTool(hub, { action: 'clipboard_get' }, { sessionId: 's1' });
  await new Promise(r => setImmediate(r));
  const [cmd] = c.cmds();
  assert.equal(cmd.cmd, 'clipboard_get');
  assert.equal(cmd.args.sessionId, 's1');
  assert.equal(hub.result({ deviceId: 'p1', id: cmd.id, ok: true, data: { text: 'hi' } }).ok, true);
  assert.equal((await job).text, '{"text":"hi"}');
  assert.equal(hub.result({ deviceId: 'p1', id: cmd.id, ok: true }).ok, false, '同一结果不能回传两次');
});

test('没开的能力不下发，提示去 App 打开', async () => {
  const hub = createPhoneHub();
  const c = fakeConn();
  hub.connect(c.res, c.req, { deviceId: 'p1', caps: 'apps' });
  const r = await phoneTool(hub, { action: 'sms', number: '10086', text: 'x' }, {});
  assert.equal(r.isError, true);
  assert.match(r.text, /发短信/);
  assert.equal(c.cmds().length, 0);
  hub.hello({ deviceId: 'p1', caps: ['apps', 'sms'] });
  const job = phoneTool(hub, { action: 'sms', number: '10086', text: 'x' }, {});
  await new Promise(r => setImmediate(r));
  assert.equal(c.cmds().length, 1);
  hub.result({ id: c.cmds()[0].id, ok: false, error: '用户在手机上拒绝了' });
  assert.match((await job).text, /拒绝/);
});

test('断线让未完成指令立即失败；没有手机时明确报错', async () => {
  const hub = createPhoneHub();
  assert.match((await phoneTool(hub, { action: 'open_url', url: 'https://a.com' })).text, /没有在线的手机/);
  const c = fakeConn();
  hub.connect(c.res, c.req, { deviceId: 'p1', caps: 'apps' });
  const job = phoneTool(hub, { action: 'open_url', url: 'https://a.com' });
  await new Promise(r => setImmediate(r));
  c.req.emit('close');
  assert.match((await job).text, /断开/);
  assert.equal(hub.online, 0);
});

test('参数校验与过滤', () => {
  assert.match(validate('open_url', { url: 'a.com' }), /协议/);
  assert.match(validate('tap', {}), /elementId/);
  assert.equal(validate('tap', { x: 1, y: 2 }), '');
  assert.match(validate('alarm_set', { time: '7点' }), /HH:MM/);
  assert.deepEqual(pickArgs({ action: 'x', device: 'd', url: 'u', bogus: 1, x: NaN }), { url: 'u' });
  assert.equal(PHONE_TOOL_SCHEMA.function.name, 'phone');
});

test('USB 调试回落：App 不在线时用 adb 设备', async () => {
  const calls = [];
  const adb = { refresh: async () => ['SER1'], act: async (serial, cmd, a) => { calls.push([serial, cmd, a.url]); return { ok: true }; }, status: () => ({ enabled: true, devices: ['SER1'] }) };
  const hub = createPhoneHub({ adb });
  const r = await phoneTool(hub, { action: 'open_url', url: 'https://a.com' });
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls, [['SER1', 'open_url', 'https://a.com']]);
  assert.match((await phoneTool(hub, { action: 'sms', number: '1', text: 'x' })).text, /发短信/);
});

test('uiautomator XML 解析：编号、跳过密码框与无用节点', () => {
  const xml = '<hierarchy><node text="" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1080,2400]"/>'
    + '<node text="登录" class="android.widget.Button" clickable="true" bounds="[100,200][300,260]"/>'
    + '<node text="" class="android.widget.EditText" password="true" clickable="true" bounds="[0,0][10,10]"/>'
    + '<node text="" content-desc="搜索" class="android.widget.ImageView" clickable="true" bounds="[0,0][50,50]"/></hierarchy>';
  const els = parseUiXml(xml);
  assert.deepEqual(els.map(e => [e.id, e.text]), [['1', '登录'], ['2', '搜索']]);
  assert.equal(els[0].cx, 200);
});
