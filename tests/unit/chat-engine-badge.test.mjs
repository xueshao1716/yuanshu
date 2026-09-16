// ② 主驾引擎角标的源码契约测试。
// 服务端一直在推 engine_selected（engine + reason）和 leadNote，但前端以前把它丢了——
// 于是"换了个模型，怎么连干活方式和脾气都变了"这件事全靠用户猜。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');

test('② engine_selected 要被消费，并随消息存下来', () => {
  const chat = read('frontend/src/components/ChatArea.tsx');
  assert.match(chat, /case 'engine_selected'/, 'engine_selected 不能再被丢掉');
  assert.match(chat, /engineReason: String\(d\.reason/, '原因（为什么是它主驾）也要带进来');
  assert.match(chat, /engine: stream\.engine/, '流式期间就带上，别等回复完才知道');
  assert.match(chat, /\.\.\.\(s\.engine \? \{ engine: s\.engine/, '落库时要存引擎，刷新后还能回看');
  const srv = read('server.mjs');
  assert.match(srv, /"engine_selected"/, '服务端要一直有这个事件');
  assert.match(srv, /resolveLead\(/, '引擎决策来自 engine-pair 的 resolveLead');
});

test('② 界面用中文名渲染角标，不把 yuanshu/pi 直接甩给用户', () => {
  const msg = read('frontend/src/components/Message.tsx');
  assert.match(msg, /ENGINE_LABEL/, '要给引擎 id 一张中文名表');
  assert.match(msg, /yuanshu: '元枢自制循环'/, '名字与 engine-pair.mjs 保持一致');
  assert.match(msg, /pi: '兼容适配器\(pi\)'/);
  assert.match(msg, /dsh: '外部执行引擎\(dsh\)'/);
  assert.match(msg, /主驾 \{ENGINE_LABEL\[msg\.engine\]/, '要真的渲染成角标');
  assert.match(msg, /title=\{msg\.engineReason/, '原因挂在 title 上，看一眼就知道为什么');
  const types = read('frontend/src/types.ts');
  assert.match(types, /engine\?: string/, '消息类型要带引擎字段');
  const db = read('frontend/src/lib/local-db.ts');
  assert.match(db, /engineReason\?: string/, '本地库也要存原因');
});
