// 语音入站：解析 voice_item / 找本地模型（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceItemsOf } from "../../engine/wechat/media.mjs";
import { resolveModelDir } from "../../engine/wechat/stt.mjs";

test("voiceItemsOf：从 item_list 里挑出 type=3 的语音", () => {
  const msg = {
    item_list: [
      { type: 1, text_item: { text: "文字" } },
      { type: 3, voice_item: { media: { encrypt_query_param: "abc", aes_key: "k" }, playtime: 1200 } },
      { type: 3, voice_item: { media: {} } }, // 没参数，跳过
    ],
  };
  const v = voiceItemsOf(msg);
  assert.equal(v.length, 1);
  assert.equal(v[0].encryptedQueryParam, "abc");
  assert.equal(v[0].aesKey, "k");
  assert.equal(v[0].playtime, 1200);
});

test("voiceItemsOf：message 没有 item_list 也不炸", () => {
  assert.deepEqual(voiceItemsOf({}), []);
  assert.deepEqual(voiceItemsOf(null), []);
});

test("resolveModelDir：能定位到本地 base 快照（含 model.bin）", () => {
  const dir = resolveModelDir("base");
  if (!dir) return; // 没下过模型的环境跳过
  assert.match(dir, /faster-whisper-base/);
  assert.ok(dir.length > 10);
});

test("resolveModelDir：不存在的模型返回空串", () => {
  assert.equal(resolveModelDir("nonexistent-model-xyz"), "");
});
