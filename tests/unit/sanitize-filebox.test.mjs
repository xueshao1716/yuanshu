// sanitize.mjs + filebox.mjs 单元测试
// 运行：node --test tests/unit/sanitize-filebox.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeText, sanitizeContent } from "../../engine/sanitize.mjs";
import { signedUrl, verifySigned, findFiles } from "../../engine/filebox.mjs";

describe("sanitize.mjs 脱敏", () => {
  test("API key（sk-）被脱敏", () => {
    assert.ok(sanitizeText("key: sk-abcdefghijklmnop123456").includes("脱敏"));
  });
  test("token 长串被脱敏", () => {
    assert.ok(sanitizeText("token: tp-cb27cn7yg3x5jkvqez4xkm7b1ifroacc28vi74iepa3tq9lb").includes("脱敏"));
  });
  test("访问令牌 love# 被脱敏", () => {
    assert.ok(sanitizeText("love#testtoken").includes("脱敏"));
  });
  test("普通文本不被误伤", () => {
    assert.equal(sanitizeText("这是一段普通的中文内容"), "这是一段普通的中文内容");
  });
  test("HTML 内容脱敏", () => {
    assert.ok(sanitizeContent("key: sk-abcdefghijklmnop123456", "html").includes("脱敏"));
  });
});

describe("filebox.mjs 文件服务", () => {
  test("signedUrl 生成带签名参数", () => {
    const url = signedUrl("工程/test.txt");
    assert.ok(url.startsWith("/api/ws/file?"));
    assert.ok(url.includes("sig="), "应包含签名");
    assert.ok(url.includes("exp="), "应包含过期时间");
  });
  test("verifySigned 同进程验证通过", () => {
    const url = signedUrl("工程/test.txt");
    const v = verifySigned({ url, headers: {} });
    assert.equal(v.ok, true);
    assert.equal(v.rel, "工程/test.txt");
  });
  test("verifySigned 篡改签名被拒", () => {
    const v = verifySigned({ url: "/api/ws/file?path=%E5%B7%A5%E7%A8%8B%2Ftest.txt&exp=9999999999999&sig=deadbeef", headers: {} });
    assert.equal(v.ok, false, "篡改签名应被拒绝");
  });
  test("findFiles 按关键词找到文件", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-file-test-"));
    fs.writeFileSync(path.join(tmp, "酒店报告.md"), "test");
    fs.mkdirSync(path.join(tmp, "工程"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "工程", "麻辣烫方案.md"), "test");
    const r = findFiles(tmp, { query: "酒店报告", max: 5 });
    assert.ok(r.some(f => f.name.includes("酒店报告")), "应找到酒店报告");
    const r2 = findFiles(tmp, { query: "麻辣烫", max: 5 });
    assert.ok(r2.some(f => f.name.includes("麻辣烫方案")), "应找到麻辣烫方案");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });
});
