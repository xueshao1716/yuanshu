// 微信图片收发：解析/路径提取/加解密（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { imageItemsOf, parseAesKey, downloadImage, extractImagePaths } from "../../engine/wechat/media.mjs";
import { normalizeMessage } from "../../engine/wechat/ilink.mjs";

test("normalizeMessage 会带出入站图片（以前直接丢）", () => {
  const msg = {
    from_user_id: "u1",
    item_list: [
      { type: 1, text_item: { text: "看这个" } },
      { type: 2, image_item: { media: { encrypt_query_param: "P", aes_key: "K" }, mid_size: 1234 } },
    ],
    context_token: "c1",
  };
  const m = normalizeMessage(msg, "bot");
  assert.equal(m.text, "看这个");
  assert.equal(m.images.length, 1);
  assert.equal(m.images[0].encryptedQueryParam, "P");
  assert.equal(m.images[0].aesKey, "K");
});

test("imageItemsOf 只挑图片项，没有就返回空", () => {
  assert.deepEqual(imageItemsOf({ item_list: [{ type: 1, text_item: { text: "x" } }] }), []);
  const one = imageItemsOf({ item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "Q" } } }] });
  assert.equal(one.length, 1);
});

test("aes_key 解析：base64(hex 文本) → 16 字节", () => {
  const hex = "0123456789abcdef0123456789abcdef";
  const b64 = Buffer.from(hex).toString("base64");
  const key = parseAesKey(b64);
  assert.equal(key.length, 16);
  assert.throws(() => parseAesKey("too-short"), /格式不对/);
});

test("下载解密：AES-128-ECB + PKCS#7 去填充", async () => {
  const plain = Buffer.from("fake-jpeg-bytes-1234567890");
  const key = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-128-ecb", key, null);
  const cipherText = Buffer.concat([c.update(plain), c.final()]);
  const aesKeyB64 = Buffer.from(key.toString("hex")).toString("base64");

  const fakeFetch = async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => cipherText.buffer.slice(cipherText.byteOffset, cipherText.byteOffset + cipherText.length),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-img-"));
  const r = await downloadImage({ item: { encryptedQueryParam: "P", aesKey: aesKeyB64 }, outDir: dir, fetch: fakeFetch, cdnBase: "http://x/c2c" });
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readFileSync(r.file), plain);
});

test("出站：回复里的本地图片路径会被识别并剥离", () => {
  const dir = mkdtemp();
  const img = path.join(dir, "a.png");
  fs.writeFileSync(img, "x");
  const ex = extractImagePaths(`这是图：\n![截图](${img})\n后面还有话`);
  assert.equal(ex.images.length, 1);
  assert.ok(!ex.text.includes(img), "文本里不该留路径");
  assert.match(ex.text, /后面还有话/);
});

test("出站：不存在的路径不误发", () => {
  const ex = extractImagePaths("![]（D:\\no\\such.png）\n以及 D:\\also\\missing.jpg");
  assert.equal(ex.images.length, 0);
});

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wx-path-"));
}

// 2026-11-20：文件 / 视频入站（以前只发文件的消息被当空白丢掉）
test("fileItemsOf 认文件(4)和视频(5)，按原名解密落盘，重名不覆盖", async () => {
  const { fileItemsOf, downloadFile, safeFileName } = await import("../../engine/wechat/media.mjs");
  const hex = "0123456789abcdef0123456789abcdef";
  const items = fileItemsOf({ item_list: [
    { type: 1, text_item: { text: "x" } },
    { type: 4, file_item: { media: { encrypt_query_param: "F", aes_key: Buffer.from(hex).toString("base64") }, file_name: "报告.docx", len: "10" } },
    { type: 5, video_item: { media: { encrypt_query_param: "V" }, aeskey: hex } },
    { type: 4, file_item: { media: {} } },
  ] });
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].kind, items[0].fileName, items[0].size], ["file", "报告.docx", 10]);
  assert.equal(items[1].kind, "video");
  assert.equal(parseAesKey(items[1].aesKey).toString("hex"), hex);
  assert.equal(safeFileName("../a:b?.txt", "z"), "a_b_.txt");
  assert.equal(safeFileName("", "z"), "z");

  const plain = Buffer.from("hello 文件");
  const c = crypto.createCipheriv("aes-128-ecb", Buffer.from(hex, "hex"), null);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  const fakeFetch = async () => ({ ok: true, arrayBuffer: async () => enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.length) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxfile-"));
  const a = await downloadFile({ item: items[0], outDir: dir, fetch: fakeFetch });
  const b = await downloadFile({ item: items[0], outDir: dir, fetch: fakeFetch });
  assert.equal(path.basename(a.file), "报告.docx");
  assert.equal(path.basename(b.file), "报告(1).docx");
  assert.equal(fs.readFileSync(a.file, "utf8"), "hello 文件");
});
