// 复读守卫的"首轮误判"回归（2026-09-16）。
//
// 真机现象：全新会话第一轮就报「与上一条完整回复完全相同」，接着同模型重写、再失败就**静默换成别的模型**
// （用户原话："静默换成 agnes 3.0"）。根因：pi 通道在本轮中途就把回复写进会话文件，而守卫 miss 内存后
// **读文件**当"上一条"——读到的是它自己刚写的那条，等于拿自己跟自己比。
// 修法：基准必须在**开跑之前**取（取不到就是 null，首轮不可能复读）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRepeatReply, classifyAnomaly, normReply, bindOutputGuardDeps } from '../../engine/output-guard.mjs';

// 让守卫能读会话文件（生产里由 server.mjs 注入同样的两个函数）
bindOutputGuardDeps({
  readEntriesFromFile: (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  extractText: (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('') : String(content || '')),
});

function sessionFileWith(replyText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: replyText }] } }) + '\n');
  return file;
}

test('首轮误判复现与修复：本轮回复已落盘时，基准为空就不能判复读', () => {
  const reply = '这是本轮刚写下的回复，长度足够触发守卫判定，专门用来复现全新会话首轮的误判。';
  const file = sessionFileWith(reply);
  // 复现旧行为：不传基准 → 走文件 → 读到自己的回复 → 误判
  assert.equal(isRepeatReply('sess-old', reply, file), true, '不传基准时会拿自己跟自己比（这就是真机上发生的事）');
  // 修复后：调用方在开跑前取基准，首轮为 null → 不判
  assert.equal(isRepeatReply('sess-new', reply, file, null), false, '首轮基准为 null，不能判复读');
  assert.equal(classifyAnomaly({ sessionKey: 'sess-new', text: reply, sessionFile: file, baseline: null }).type, 'none');
});

test('真复读仍要抓到（别把守卫修成聋子）', () => {
  const reply = '模型把上一条回复原样重复了一遍，长度足够，用来验证真复读不会被放过，还要再加点字。';
  const file = sessionFileWith(reply);
  assert.equal(classifyAnomaly({ sessionKey: 'sess-rep', text: reply, sessionFile: file, baseline: normReply(reply) }).type, 'repeat');
  // 基准与当前不同 → 正常
  assert.equal(classifyAnomaly({ sessionKey: 'sess-ok', text: reply, sessionFile: file, baseline: normReply('完全不同的上一条回复内容，足够长足够长足够长。') }).type, 'none');
});

test('防误伤规则没被我改坏：短回复、身份类固定回答都不判', () => {
  assert.equal(isRepeatReply('s', '好的', null, normReply('好的')), false, '<30 字不判');
  const id = '我叫小语，当前使用模型是 workbuddy/hy4-preview，很高兴见到你——这是一段足够长的身份回答。';
  assert.equal(isRepeatReply('s', id, null, normReply(id)), false, '身份类固定回答不算复读');
});

test('model_switched：服务端三处 + 自研循环都要推，前端要显示（源码契约）', () => {
  const srv = fs.readFileSync('server.mjs', 'utf8');
  assert.ok((srv.match(/writer\.push\("model_switched"/g) || []).length >= 3, '同模型重写 / 换模型重生成 / 空回复兜底三处都要推');
  const uc = fs.readFileSync('engine/unified-chat.mjs', 'utf8');
  assert.ok(uc.split('\n').some(line => line.includes('writer.push(') && line.includes('model_switched')), '自研循环的守卫换模型也要推');
  const chat = fs.readFileSync('frontend/src/components/ChatArea.tsx', 'utf8');
  assert.match(chat, /case 'model_switched'/, '前端要消费这个事件');
  assert.match(chat, /switchedModel: stream\.switchedModel/, '流式期间就带上');
  const msg = fs.readFileSync('frontend/src/components/Message.tsx', 'utf8');
  assert.match(msg, /兜底 \$\{msg\.switchedModel\.id\}/, '要渲染「兜底 <模型>」');
  assert.match(msg, /已重写/, '同模型重写也要标出来');
  const types = fs.readFileSync('frontend/src/types.ts', 'utf8');
  assert.match(types, /switchedModel\?:/, '消息类型要带这个字段');
});

test('基准必须"开跑前"取（源码契约）', () => {
  const srv = fs.readFileSync('server.mjs', 'utf8');
  assert.match(srv, /const replyBaseline = \(\(\) => \{/, 'handleChat 要在动笔前取基准');
  assert.match(srv, /baseline: replyBaseline/, '并传给 classifyAnomaly');
  const uc = fs.readFileSync('engine/unified-chat.mjs', 'utf8');
  assert.match(uc, /baseline: replyBaseline/, '自研循环同样');
  const guard = fs.readFileSync('engine/output-guard.mjs', 'utf8');
  assert.match(guard, /export function lastAssistantReply/, '要有"开跑前取基准"的入口');
  assert.match(guard, /baseline = undefined/, 'isRepeatReply 要接受基准参数');
});
