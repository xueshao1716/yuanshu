// 远程目录 + 签名 + 回滚 的回归测试（2026-10-29）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateKeypair, signManifest, verifySignature, signaturePayload,
  writeRegistryConfig, readRegistryConfig, fetchRemoteCatalog, remoteCatalogItems, installFromRemote,
  installPlugin, rollbackPlugin, versionHistory, validateManifest,
} from "../../engine/plugin-store.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
const skills = (id, version) => ({
  id, name: "远程技能", version, type: "skill",
  payload: { "SKILL.md": `# 远程技能\n\n版本 ${version}` },
});

test("签名：改了 payload 就验不过", () => {
  const kp = generateKeypair();
  const signed = signManifest(skills("signed-skill", "1.0.0"), { privateKey: kp.privateKey });
  assert.equal(verifySignature(signed, { publicKey: kp.publicKey }).ok, true);
  const tampered = { ...signed, payload: { "SKILL.md": "# 远程技能\n\n篡改" } };
  assert.equal(verifySignature(tampered, { publicKey: kp.publicKey }).ok, false);
});

test("签名：没有公钥时给明确原因", () => {
  const r = verifySignature(skills("x", "1.0.0"), { publicKey: "" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /未签名|公钥/);
});

test("signaturePayload 只认 id/version/type/payload（改描述不影响签名）", () => {
  const a = signaturePayload({ id: "a", version: "1.0.0", type: "skill", payload: { x: 1 }, description: "A" });
  const b = signaturePayload({ id: "a", version: "1.0.0", type: "skill", payload: { x: 1 }, description: "B" });
  assert.equal(a, b);
});

test("远程刷新：拉目录、标记签名、缓存残留", async () => {
  const root = ws();
  const kp = generateKeypair();
  writeRegistryConfig(root, { url: "https://example.com/plugins.json", publicKey: kp.publicKey });
  const signed = signManifest(skills("remote-ok", "1.2.0"), { privateKey: kp.privateKey });
  const unsigned = skills("remote-unsigned", "1.0.0");
  const fakeFetch = async () => ({ ok: true, json: async () => ({ plugins: [signed, unsigned] }) });

  const out = await fetchRemoteCatalog(root, { fetchImpl: fakeFetch });
  assert.equal(out.ok, true);
  assert.equal(out.items.length, 2);
  assert.equal(out.items.find((x) => x.id === "remote-ok").signed, true);
  assert.equal(out.items.find((x) => x.id === "remote-unsigned").signed, false);
  assert.equal(remoteCatalogItems(root).length, 2);
});

test("requireSigned 打开后，未签名的包不能装", async () => {
  const root = ws();
  const kp = generateKeypair();
  writeRegistryConfig(root, { url: "https://example.com/plugins.json", publicKey: kp.publicKey, requireSigned: true });
  const signed = signManifest(skills("ok-pack", "1.0.0"), { privateKey: kp.privateKey });
  const fakeFetch = async () => ({ ok: true, json: async () => ({ plugins: [signed, skills("bad-pack", "1.0.0")] }) });
  const out = await fetchRemoteCatalog(root, { fetchImpl: fakeFetch });
  const bad = out.items.find((x) => x.id === "bad-pack");
  assert.equal(bad.installable, false);
  assert.match(bad.error, /签名/);
  assert.equal(installFromRemote(root, "bad-pack").ok, false);
  const good = installFromRemote(root, "ok-pack");
  assert.equal(good.ok, true);
});

test("远程拉取失败保留上次缓存并记错误", async () => {
  const root = ws();
  writeRegistryConfig(root, { url: "https://example.com/plugins.json" });
  await fetchRemoteCatalog(root, { fetchImpl: async () => ({ ok: true, json: async () => ({ plugins: [skills("keep-me", "1.0.0")] }) }) });
  const out = await fetchRemoteCatalog(root, { fetchImpl: async () => { throw new Error("网络断了") } });
  assert.equal(out.ok, false);
  assert.match(out.error, /网络断了/);
  assert.equal(remoteCatalogItems(root).length, 1, "旧缓存要还在");
  assert.match(readRegistryConfig(root).lastError, /网络断了/);
});

test("升级装新版本会留备份，回滚能拿回旧内容", () => {
  const root = ws();
  assert.equal(installPlugin(root, skills("up-me", "1.0.0")).ok, true);
  const v1 = fs.readFileSync(path.join(root, "插件", "up-me", "SKILL.md"), "utf8");
  assert.equal(installPlugin(root, skills("up-me", "2.0.0")).ok, true);
  const v2 = fs.readFileSync(path.join(root, "插件", "up-me", "SKILL.md"), "utf8");
  assert.notEqual(v1, v2);
  assert.equal(versionHistory(root, "up-me").length, 2);
  const rb = rollbackPlugin(root, "up-me");
  assert.equal(rb.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "插件", "up-me", "SKILL.md"), "utf8"), v1);
});

test("没有上一版时回滚给明确原因", () => {
  const root = ws();
  installPlugin(root, skills("fresh", "1.0.0"));
  const rb = rollbackPlugin(root, "fresh");
  assert.equal(rb.ok, false);
  assert.match(rb.error, /没有可回滚/);
});

test("toolpack 校验：工具名/描述/body 缺一不可", () => {
  const base = { id: "tp-x", name: "工具包", version: "1.0.0", type: "toolpack" };
  assert.match(validateManifest({ ...base, payload: { tools: [] } }).error, /payload\.tools/);
  assert.match(validateManifest({ ...base, payload: { tools: [{ name: "Bad Name", description: "d", body: "return 1" }] } }).error, /工具名/);
  assert.match(validateManifest({ ...base, payload: { tools: [{ name: "ok_name", description: "", body: "return 1" }] } }).error, /description/);
  assert.equal(validateManifest({ ...base, payload: { tools: [{ name: "ok_name", description: "d", body: "return 1" }] } }).ok, true);
});
