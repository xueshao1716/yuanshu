// 2026-09-16 真机故障回归：workbuddy/hy4-preview 报 400 code 11133「请求参数不符合当前模型要求」，
// opencode-go 上同一批历史报 "Messages with role 'tool'"。
//
// 逐字段拆下来定位到：assistant(tool_calls) 的 arguments 是**双重编码**——
// 值本身是 JSON 字符串字面量（parse 出来是 string 而不是 object），上游要求 arguments
// 必须能 parse 成对象，于是整轮请求被拒。
//
// 实测（同一段真实历史，只改 arguments）：
//   原样（双重编码）→ 400；550 个 a（非法 JSON）→ 400；合法 JSON 对象 → 200；{} → 200
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolArgs, normalizeToolCallArguments } from '../../engine/tool-args.mjs';
import { describeHttpError } from '../../engine/http.mjs';

test('双重编码的 arguments 必须被解回对象（真机事故的元凶）', () => {
  const real = JSON.stringify(JSON.stringify({ program: "const fs = require('fs')" }));
  assert.equal(typeof JSON.parse(real), 'string', '前提：原值 parse 出来是字符串（不是对象）');
  const fixed = normalizeToolArgs(real);
  const parsed = JSON.parse(fixed);
  assert.equal(typeof parsed, 'object');
  assert.equal(parsed.program, "const fs = require('fs')", '内容不能丢');
});

test('正常对象/字符串 JSON/空值都各得其所', () => {
  assert.equal(JSON.parse(normalizeToolArgs({ a: 1 })).a, 1, '对象直接序列化');
  assert.equal(JSON.parse(normalizeToolArgs('{"a":1}')).a, 1, '合法对象 JSON 原样');
  assert.deepEqual(JSON.parse(normalizeToolArgs('')), {}, '空 → {}');
  assert.deepEqual(JSON.parse(normalizeToolArgs(null)), {}, 'null → {}');
  assert.deepEqual(JSON.parse(normalizeToolArgs(undefined)), {}, 'undefined → {}');
  // 三层字符串包裹也要解出来
  assert.equal(JSON.parse(normalizeToolArgs(JSON.stringify(JSON.stringify(JSON.stringify({ deep: 1 }))))).deep, 1);
});

test('非法/非对象也要兜成"合法对象"，绝不能把整轮请求打死', () => {
  const junk = normalizeToolArgs('{"program": "const fs = require(');   // 截断的 JSON
  assert.equal(typeof JSON.parse(junk), 'object', '必须是对象');
  assert.ok(String(JSON.parse(junk).raw).startsWith('{"program"'), '原文要留一份备查');
  const arr = normalizeToolArgs('["a","b"]');
  assert.equal(typeof JSON.parse(arr), 'object');
  assert.ok(!Array.isArray(JSON.parse(arr)), '数组不是合法 arguments，要包成对象');
  // 流式分片被拼成数组：能缝回对象就缝
  const chunks = normalizeToolArgs(JSON.stringify(['{"pro', 'gram":', '"x"}']));
  assert.equal(JSON.parse(chunks).program, 'x', '分片数组要缝回对象');
});

test('整段历史的 arguments 都能就地规范化（发送前最后一道闸）', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_code', arguments: JSON.stringify(JSON.stringify({ program: 'x' })) } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: 'done' },
  ];
  normalizeToolCallArguments(messages)
  assert.equal(typeof JSON.parse(messages[1].tool_calls[0].function.arguments), 'object');
  assert.equal(messages.length, 4, '只改参数，不动消息结构（tool 消息的配对不能破坏）');
});

test('上游错误要翻成人能读的一句话（原来 150 字正好截在关键处）', () => {
  const sample = JSON.stringify({
    code: 11133,
    msg: 'the request parameters were rejected by the model provider',
    extError: { code: 'model_param_invalid', message: 'the request parameters were rejected by the model provider' },
    displayMsg: { zh: '请求参数不符合当前模型要求，请调整后重试。' },
  });
  const out = describeHttpError(sample);
  assert.match(out, /model_param_invalid/, '要带上上游的错误码');
  assert.match(out, /请求参数不符合当前模型要求/, '要带中文提示，别让用户看半截 JSON');
  assert.ok(!out.includes('"extError"'), '不要原样糊一坨 JSON 给用户');
  // 非 JSON 的错误体：截断并说明原文长度
  const long = 'x'.repeat(2000);
  const t = describeHttpError(long, { max: 100 });
  assert.match(t, /原文 2000 字，已截断/);
  assert.equal(describeHttpError(''), '(空响应体)');
});
