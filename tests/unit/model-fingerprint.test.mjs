// 指纹记录：变化检测 / 首次 / 不变 / 面板行（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { noteFingerprint, listFingerprints, fingerprintLine } from "../../engine/model/fingerprint.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));

test("第一次记录：不报警，但记下了服务端标识", () => {
  const root = ws();
  const r = noteFingerprint({ wsRoot: root, provider: "deepseek", requested: "deepseek-flash", served: "deepseek-v4-flash-20261026" });
  assert.equal(r.changed, false);
  assert.equal(r.first, true);
  const m = listFingerprints(root).models;
  assert.equal(m.length, 1);
  assert.match(m[0].served, /20261026/);
});

test("同一个标识不重复记历史", () => {
  const root = ws();
  const args = { wsRoot: root, provider: "deepseek", requested: "deepseek-flash", served: "v1" };
  noteFingerprint(args);
  noteFingerprint(args);
  noteFingerprint(args);
  assert.equal(listFingerprints(root).history.length, 0);
});

test("换了快照：changed=true，留一条 from→to 历史", () => {
  const root = ws();
  noteFingerprint({ wsRoot: root, provider: "deepseek", requested: "deepseek-flash", served: "e72d3c7f663d3e13" });
  const r = noteFingerprint({ wsRoot: root, provider: "deepseek", requested: "deepseek-flash", served: "bc19ba97cbe01647" });
  assert.equal(r.changed, true);
  assert.equal(r.from, "e72d3c7f663d3e13");
  const h = listFingerprints(root).history;
  assert.equal(h.length, 1);
  assert.match(h[0].to, /^bc19ba97/);
});

test("不同 provider 各自独立", () => {
  const root = ws();
  noteFingerprint({ wsRoot: root, provider: "a", requested: "m", served: "v1" });
  const r = noteFingerprint({ wsRoot: root, provider: "b", requested: "m", served: "v2" });
  assert.equal(r.first, true, "另一个 provider 的首记不该算变化");
});

test("缺字段直接忽略（不写脏数据）", () => {
  const root = ws();
  assert.equal(noteFingerprint({ wsRoot: root, provider: "x", requested: "", served: "v" }).changed, false);
  assert.equal(noteFingerprint({ wsRoot: root, provider: "x", requested: "m", served: "" }).changed, false);
  assert.equal(listFingerprints(root).models.length, 0);
});

test("指纹行：7 天内变化才出现", () => {
  const root = ws();
  const now = Date.now();
  noteFingerprint({ wsRoot: root, provider: "d", requested: "m", served: "old", at: now - 1000 });
  noteFingerprint({ wsRoot: root, provider: "d", requested: "m", served: "new", at: now });
  assert.match(fingerprintLine(root, { now }), /【模型指纹】/);
  assert.equal(fingerprintLine(root, { now: now + 8 * 86400_000 }), "");
});
