// 人格段唯一解析点：注入与界面同源 + 会话语气档（抄 dsh-persona-dafeiyu 的机制，不抄它的数据模型）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolvePersona, personaMeta, personaPartText, personaParts,
  setSessionStyle, readSessionStyles, sessionStyleFor,
  SESSION_STYLE_FILE, SESSION_STYLE_TTL_MS, MAX_STYLE_CHARS, STYLE_PRESETS,
} from "../../engine/persona-resolve.mjs";

function tmpWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-"));
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  return root;
}

test("解析顺序：定义在最前，会话语气在最后（离指令越近越管用）", () => {
  const ws = tmpWs();
  setSessionStyle(ws, "s1", "concise");
  const { parts } = personaParts({ wsRoot: ws, sessionId: "s1" });
  const ids = parts.map((p) => p.id);
  assert.equal(ids[0], "definition", `第一段应是人格定义，实际 ${ids.join(",")}`);
  assert.equal(ids.at(-1), "session", "会话语气应在最后");
  assert.deepEqual(ids.filter((x) => x === "session").length, 1);
});

test("会话档：设了就是 session 模式，段尾就是那句话；清掉就回工作区默认", () => {
  const ws = tmpWs();
  const before = resolvePersona({ wsRoot: ws, sessionId: "s1" });
  assert.equal(before.mode, "workspace");
  assert.equal(before.sessionStyle, null);

  const out = setSessionStyle(ws, "s1", "companion");
  assert.equal(out.ok, true);
  const after = resolvePersona({ wsRoot: ws, sessionId: "s1" });
  assert.equal(after.mode, "session");
  assert.equal(after.sessionStyle.id, "companion");
  assert.ok(after.section.endsWith(STYLE_PRESETS.companion.text), "会话语气要落在段落末尾");

  // 别的会话不受影响
  const other = resolvePersona({ wsRoot: ws, sessionId: "s2" });
  assert.equal(other.mode, "workspace");

  setSessionStyle(ws, "s1", null);
  assert.equal(resolvePersona({ wsRoot: ws, sessionId: "s1" }).mode, "workspace");
});

test("会话档会过期：超过 TTL 的不再生效，也不再写回", () => {
  const ws = tmpWs();
  const old = Date.now() - SESSION_STYLE_TTL_MS - 1000;
  fs.writeFileSync(path.join(ws, SESSION_STYLE_FILE), JSON.stringify({
    s1: { id: "deep", label: "深度", text: STYLE_PRESETS.deep.text, at: old },
  }), "utf8");
  assert.deepEqual(readSessionStyles(ws), {});
  assert.equal(sessionStyleFor(ws, "s1"), null);
  assert.equal(resolvePersona({ wsRoot: ws, sessionId: "s1" }).mode, "workspace");
});

test("语气档太长直接拒绝（不静默截断，截断会变形）", () => {
  const ws = tmpWs();
  const out = setSessionStyle(ws, "s1", "长".repeat(MAX_STYLE_CHARS + 1));
  assert.equal(out.ok, false);
  assert.match(out.error, /上限/);
  assert.equal(readSessionStyles(ws).s1, undefined);
});

test("自定义文本也能当档，标签记成「自定义」", () => {
  const ws = tmpWs();
  const out = setSessionStyle(ws, "s1", "本会话尽量用列表回答，每条不超过一行。");
  assert.equal(out.ok, true);
  assert.equal(out.style.label, "自定义");
  assert.equal(resolvePersona({ wsRoot: ws, sessionId: "s1" }).sessionStyle.id, "custom");
});

test("元数据与正文分离：parts 不带 text，正文按需取", () => {
  const ws = tmpWs();
  setSessionStyle(ws, "s1", "concise");
  const res = resolvePersona({ wsRoot: ws, sessionId: "s1" });
  const meta = personaMeta(res);
  assert.equal(meta.parts.length, res.parts.length);
  assert.ok(meta.parts.every((p) => !("text" in p)), "元数据里不许带正文");
  assert.ok(meta.parts.every((p) => typeof p.chars === "number"));
  assert.equal(meta.chars, res.section.length);

  const part = personaPartText({ wsRoot: ws, sessionId: "s1", id: "session" });
  assert.ok(part && part.text === STYLE_PRESETS.concise.text);
  assert.equal(part.chars, part.text.length);
  assert.equal(personaPartText({ wsRoot: ws, sessionId: "s1", id: "nope" }), null);
});

test("同源：section 就是各段按序 join，字数对得上（不会出现两套渲染）", () => {
  const ws = tmpWs();
  setSessionStyle(ws, "s1", "deep");
  const res = resolvePersona({ wsRoot: ws, sessionId: "s1" });
  assert.equal(res.section, res.parts.map((p) => p.text).join("\n\n"));
  for (const p of res.parts) assert.equal(p.text.length > 0, true, `${p.id} 不该是空段`);
});
