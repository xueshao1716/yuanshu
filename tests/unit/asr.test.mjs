// asr-api.test.mjs —— 语音转文字 API 单测（mock 上游，不真调网关）
import { test } from "node:test";
import assert from "node:assert";
import { initAsrApi, handleAsr } from "../../engine/asr-api.mjs";

// mock res：捕获 json() 输出
function mockRes() {
  const r = { statusCode: 0, body: null, writeHead(c) { r.statusCode = c }, end(b) { r.body = JSON.parse(b) } };
  return r;
}
const okFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: " 你好，世界 " } }] }), text: async () => "" });
const failFetch = async () => ({ ok: false, status: 401, text: async () => "Unauthorized" });

test('备用 ASR 必须按 JSON 解码转义字符，不得把诊断 text 当识别结果', async () => {
  let calls = 0;
  init(async () => ++calls === 1 ? failFetch() : {
    ok: true,
    text: async () => 'event: transcript\r\ndata: {"text":"他说：\\\"你好\\\"\\n路径 C:\\\\音频"}\r\n\r\n: {"text":"心跳不是正文"}\r\n\r\ndata: [DONE]\r\n\r\n',
  });
  const res = mockRes();
  await handleAsr(res, { data: 'aGk=', format: 'wav' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.text, '他说："你好"\n路径 C:\\音频');
});

test('主通道只返回空白时必须尝试备用 ASR', async () => {
  let calls = 0;
  init(async () => ++calls === 1
    ? { ok: true, json: async () => ({ choices: [{ message: { content: '   ' } }] }) }
    : { ok: true, text: async () => 'data: {"text":"备用结果"}\n\n' });
  const res = mockRes();
  await handleAsr(res, { data: 'aGk=', format: 'wav' });
  assert.equal(res.body.text, '备用结果');
  assert.equal(res.body.fallback, true);
});

test('只有备用通道配置了 key 时仍可以识别语音', async () => {
  initAsrApi({
    resolveAuth: p => p === 'stepfun-plan' ? { key: 'test-only' } : null,
    httpJsonFetch: async () => ({ ok: true, text: async () => 'data: {"text":"备用识别"}\n\n' }),
  });
  const res = mockRes();
  await handleAsr(res, { data: 'aGk=', format: 'wav' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.text, '备用识别');
});

function init(fetchImpl) {
  initAsrApi({
    resolveAuth: (p) => ({ key: "tp-test", baseUrl: "" }),
    readJsonFile: () => ({ "xiaomi-token-plan-cn": { models: [{ id: "mimo-v2.5-asr", baseUrl: "https://gw.test/v1" }] } }),
    modelsPath: "",
    httpJsonFetch: fetchImpl,
  });
}

test("asr-01 缺少音频数据 → 400", async () => {
  init(okFetch);
  const res = mockRes();
  await handleAsr(res, {});
  assert.equal(res.statusCode, 400);
});

test("asr-02 不支持的格式 → 400（上游只认 wav/mp3）", async () => {
  init(okFetch);
  for (const fmt of ["exe", "webm", "m4a"]) {
    const res = mockRes();
    await handleAsr(res, { data: "aGk=", format: fmt });
    assert.equal(res.statusCode, 400, fmt);
  }
});

test("asr-03 成功：返回去空格文本 + 网关 payload 只含 audio 不含 text（网关硬约定）", async () => {
  let captured = null;
  init(async (url, opts) => { captured = { url, body: JSON.parse(opts.body) }; return okFetch(); });
  const res = mockRes();
  await handleAsr(res, { data: "aGk=", format: "wav" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.text, "你好，世界");
  assert.equal(res.body.model, "mimo-v2.5-asr");
  assert.equal(captured.url, "https://gw.test/v1/chat/completions");
  const content = captured.body.messages[0].content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "input_audio");
  assert.ok(!content.some(c => c.type === "text"), "网关要求不带 text part");
});

test("asr-04 上游 401 → 502 带原因", async () => {
  init(failFetch);
  const res = mockRes();
  await handleAsr(res, { data: "aGk=", format: "wav" });
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /401/);
});

test("asr-05 未配置 key → 503", async () => {
  initAsrApi({ resolveAuth: () => null, readJsonFile: () => ({}), modelsPath: "", httpJsonFetch: okFetch });
  const res = mockRes();
  await handleAsr(res, { data: "aGk=", format: "wav" });
  assert.equal(res.statusCode, 503);
});
