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

test('断线后宽限期内没连回来才失败；没有手机时明确报错', async () => {
  const hub = createPhoneHub({ graceMs: 20 });
  assert.match((await phoneTool(hub, { action: 'open_url', url: 'https://a.com' })).text, /没有在线的手机/);
  const c = fakeConn();
  hub.connect(c.res, c.req, { deviceId: 'p1', caps: 'apps' });
  const job = phoneTool(hub, { action: 'open_url', url: 'https://a.com' });
  await new Promise(r => setImmediate(r));
  c.req.emit('close');
  assert.match((await job).text, /断开.*没有连回来/);
  assert.equal(hub.online, 0);
});

test('切后台掉线：手机连回来后补发没拿到结果的指令，下一步也会等它连回来', async () => {
  const hub = createPhoneHub({ graceMs: 2000 });
  const c1 = fakeConn();
  hub.connect(c1.res, c1.req, { deviceId: 'p1', caps: 'apps,screen' });
  const job = phoneTool(hub, { action: 'screen_read' }, { sessionId: 's1' });
  await new Promise(r => setImmediate(r));
  const [sent] = c1.cmds();
  c1.req.emit('close');
  const c2 = fakeConn();
  hub.connect(c2.res, c2.req, { deviceId: 'p1', caps: 'apps,screen' });
  const [again] = c2.cmds();
  assert.equal(again.id, sent.id, '同一个 id 补发，手机端据此去重');
  hub.result({ deviceId: 'p1', id: sent.id, ok: true, data: { elements: [] } });
  assert.equal((await job).text, '{"elements":[]}');

  // 下一步发出时手机正好不在线：等它连回来再发
  c2.req.emit('close');
  const next = phoneTool(hub, { action: 'screen_read' }, { sessionId: 's1' });
  await new Promise(r => setTimeout(r, 10));
  const c3 = fakeConn();
  hub.connect(c3.res, c3.req, { deviceId: 'p1', caps: 'apps,screen' });
  await new Promise(r => setImmediate(r));
  const [third] = c3.cmds();
  hub.result({ deviceId: 'p1', id: third.id, ok: true, data: { ok: 1 } });
  assert.equal((await next).text, '{"ok":1}');
  assert.ok(hub.status().events.some(e => e.type === 'close'));
});

test('旧连接被同一台手机的新连接顶替时，不影响在等的指令', async () => {
  const hub = createPhoneHub({ graceMs: 20 });
  const c1 = fakeConn();
  hub.connect(c1.res, c1.req, { deviceId: 'p1', caps: 'apps' });
  const c2 = fakeConn();
  hub.connect(c2.res, c2.req, { deviceId: 'p1', caps: 'apps' });
  const job = phoneTool(hub, { action: 'list_apps' });
  await new Promise(r => setImmediate(r));
  c1.req.emit('close'); // 旧连接晚到的 close
  await new Promise(r => setTimeout(r, 40));
  hub.result({ deviceId: 'p1', id: c2.cmds()[0].id, ok: true, data: { apps: [] } });
  assert.equal((await job).text, '{"apps":[]}');
  assert.equal(hub.online, 1);
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

test('直连握手：只有拿着令牌的一方能验证，未知 kid 不回证明', async () => {
  const crypto = await import('node:crypto');
  const { routeProof } = await import('../../engine/pairing.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'route-'));
  const token = 'master-token-for-test-1234567890';
  const h = crypto.createHash('sha256').update(token).digest('hex');
  const nonce = 'n'.repeat(20);
  assert.equal(routeProof(ws, token, h.slice(0, 16), nonce), crypto.createHmac('sha256', h).update(nonce).digest('hex'));
  assert.equal(routeProof(ws, token, '0'.repeat(16), nonce), null);
  assert.equal(routeProof(ws, token, h.slice(0, 16), 'short'), null);
});

test('电量/设备信息不需要开关，读短信要「读短信」', async () => {
  const hub = createPhoneHub();
  const c = fakeConn();
  hub.connect(c.res, c.req, { deviceId: 'p1', caps: '' });
  const job = phoneTool(hub, { action: 'battery' });
  await new Promise(r => setImmediate(r));
  assert.equal(c.cmds()[0].cmd, 'battery');
  hub.result({ id: c.cmds()[0].id, ok: true, data: { percent: 80 } });
  assert.match((await job).text, /80/);
  assert.match((await phoneTool(hub, { action: 'sms_list' })).text, /读短信/);
});
