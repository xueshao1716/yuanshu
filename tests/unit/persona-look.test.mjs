// 自画像提示词：来自人设文件、每次不同、含附加要求（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSelfPortraitPrompt, isSelfPortraitAsk, personaFacts, lookNotes, seedLookFile, FALLBACK_LOOK } from "../../engine/persona-look.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "look-"));

function withPersona(root) {
  fs.mkdirSync(path.join(root, "记忆"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆", "人格定义.json"), JSON.stringify({ name: "小语", age: 20, gender: "female" }), "utf8");
}

test("没有外观文件时：回落到默认外观，但带上人设身份", () => {
  const root = ws(); withPersona(root);
  const p = buildSelfPortraitPrompt({ wsRoot: root, seed: 1 });
  assert.match(p, /小语/);
  assert.match(p, /20岁/);
  assert.match(p, /女性/);
  assert.ok(p.includes(FALLBACK_LOOK.slice(0, 20)));
});

test("有外观文件：以文件为准（不是代码里那句）", () => {
  const root = ws(); withPersona(root);
  seedLookFile(root);
  const p = buildSelfPortraitPrompt({ wsRoot: root, seed: 1 });
  assert.match(p, /及肩深色短发/);
  assert.ok(!p.includes(FALLBACK_LOOK.slice(0, 20)), "不该再用代码里的写死外观");
});

test("同一个 seed 一样，不同 seed 不一样（画面会变，人不变）", () => {
  const root = ws(); withPersona(root);
  const a = buildSelfPortraitPrompt({ wsRoot: root, seed: 5 });
  const b = buildSelfPortraitPrompt({ wsRoot: root, seed: 5 });
  const c = buildSelfPortraitPrompt({ wsRoot: root, seed: 99 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("用户当次附加要求会拼进去（穿汉服/成人版…）", () => {
  const root = ws(); withPersona(root);
  const p = buildSelfPortraitPrompt({ wsRoot: root, seed: 1, extra: "穿白色汉服，站在雪里" });
  assert.match(p, /穿白色汉服，站在雪里/);
});

test("形象 wiki 的仲裁规则会被带进去（同系列锁脸）", () => {
  const root = ws(); withPersona(root);
  fs.mkdirSync(path.join(root, "记忆", "Wiki"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆", "Wiki", "小语形象.md"),
    "<!-- generated -->\n# 小语形象\n\n- **身份与视觉仲裁**：最新人类确认优先；认可的同系列图锁定脸与画风，不得改身份。\n", "utf8");
  const p = buildSelfPortraitPrompt({ wsRoot: root, seed: 3 });
  assert.match(p, /形象一致性/);
  assert.match(p, /锁定脸与画风|最新人类确认优先/);
});

test("识别「画个你」的多种说法", () => {
  for (const m of ["画个你", "给我画一下你", "你长什么样", "来个自画像", "画个小语"]) {
    assert.equal(isSelfPortraitAsk(m), true, m);
  }
  assert.equal(isSelfPortraitAsk("画一只猫"), false);
});

test("personaFacts / lookNotes 对空工作区不炸", () => {
  const root = ws();
  const f = personaFacts(root);
  assert.equal(f.name, "小语");
  assert.equal(lookNotes(root), "");
});
