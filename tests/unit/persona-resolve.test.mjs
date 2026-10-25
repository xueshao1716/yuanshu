// 人格段唯一解析点：注入与界面同源；语气档两级（工作区长期 / 会话临时覆盖）。
// 2026-10-25 调整：产品是"一个人格在长"，语气档不该在输入框当"换人格"用，
// 主档位放工作区（灵魂培育里调），会话档只作临时覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolvePersona, personaMeta, personaPartText, personaParts,
  setSessionStyle, setWorkspaceStyle, readSessionStyles, sessionStyleFor, workspaceStyleFor,
  SESSION_STYLE_FILE, SESSION_STYLE_TTL_MS, MAX_STYLE_CHARS, STYLE_PRESETS, WORKSPACE_STYLE_KEY,
} from "../../engine/persona-resolve.mjs";

function tmpWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-"));
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  return root;
}

test("解析顺序：定义在最前，语气档在最后（离指令越近越管用）", () => {
  const ws = tmpWs();
  setWorkspaceStyle(ws, "concise");
  const { parts } = personaParts({ wsRoot: ws, sessionId: "s1" });
  const ids = parts.map((p) => p.id);
  assert.equal(ids[0], "definition", `第一段应是人格定义，实际 ${ids.join(",")}`);
  assert.equal(ids.at(-1), "style", "语气档应在最后");
  assert.equal(ids.filter((x) => x === "style").length, 1, "会话档与工作区档不能叠加成两段");
});

test("工作区档：没有会话覆盖时生效，且不会过期", () => {
  const ws = tmpWs();
  const out = setWorkspaceStyle(ws, "companion");
  assert.equal(out.ok, true);
  const r = resolvePersona({ wsRoot: ws });
  assert.equal(r.mode, "workspace");
  assert.equal(r.workspaceStyle.id, "companion");
  assert.ok(r.section.endsWith(STYLE_PRESETS.companion.text));
  // 一年后仍然在（工作区档是长期设定）
  const later = resolvePersona({ wsRoot: ws, now: Date.now() + 365 * 24 * 3600 * 1000 });
  assert.equal(later.mode, "workspace", "工作区档不该被会话档的 TTL 一起清掉");
});

test("会话档优先于工作区档；清掉会话档就回落到工作区档", () => {
  const ws = tmpWs();
  setWorkspaceStyle(ws, "companion");
  setSessionStyle(ws, "s1", "deep");

  const session = resolvePersona({ wsRoot: ws, sessionId: "s1" });
  assert.equal(session.mode, "session");
  assert.equal(session.sessionStyle.id, "deep");
  assert.equal(session.workspaceStyle.id, "companion", "工作区档仍要如实报出来");
  assert.ok(session.section.endsWith(STYLE_PRESETS.deep.text), "会话档在最后生效");
  assert.ok(!session.section.endsWith(STYLE_PRESETS.companion.text));

  const other = resolvePersona({ wsRoot: ws, sessionId: "s2" });
  assert.equal(other.mode, "workspace", "别的会话只受工作区档影响");

  setSessionStyle(ws, "s1", null);
  assert.equal(resolvePersona({ wsRoot: ws, sessionId: "s1" }).mode, "workspace");
});

test("都没有设档时 mode=none，段里只有定义/灵魂/自我", () => {
  const ws = tmpWs();
  const r = resolvePersona({ wsRoot: ws, sessionId: "s1" });
  assert.equal(r.mode, "none");
  assert.equal(r.sessionStyle, null);
  assert.equal(r.workspaceStyle, null);
  assert.ok(!r.parts.some((p) => p.id === "style"));
});

test("会话档会过期，工作区档不会", () => {
  const ws = tmpWs();
  const old = Date.now() - SESSION_STYLE_TTL_MS - 1000;
  fs.writeFileSync(path.join(ws, SESSION_STYLE_FILE), JSON.stringify({
    s1: { id: "deep", label: "深度", text: STYLE_PRESETS.deep.text, at: old },
    [WORKSPACE_STYLE_KEY]: { id: "concise", label: "简洁", text: STYLE_PRESETS.concise.text, at: old },
  }), "utf8");
  assert.equal(sessionStyleFor(ws, "s1"), null, "会话档 7 天后失效");
  assert.ok(workspaceStyleFor(ws), "工作区档不失效");
  assert.equal(resolvePersona({ wsRoot: ws, sessionId: "s1" }).mode, "workspace");
});

test("语气档太长直接拒绝（不静默截断，截断会变形）", () => {
  const ws = tmpWs();
  const tooLong = "长".repeat(MAX_STYLE_CHARS + 1);
  assert.equal(setWorkspaceStyle(ws, tooLong).ok, false);
  assert.equal(setSessionStyle(ws, "s1", tooLong).ok, false);
  assert.deepEqual(readSessionStyles(ws), {});
});

test("自定义文本也能当档，标签记成「自定义」", () => {
  const ws = tmpWs();
  const out = setWorkspaceStyle(ws, "本会话尽量用列表回答，每条不超过一行。");
  assert.equal(out.ok, true);
  assert.equal(out.style.label, "自定义");
  assert.equal(resolvePersona({ wsRoot: ws }).workspaceStyle.id, "custom");
});

test("元数据与正文分离：parts 不带 text，正文按需取", () => {
  const ws = tmpWs();
  setWorkspaceStyle(ws, "concise");
  const res = resolvePersona({ wsRoot: ws });
  const meta = personaMeta(res);
  assert.ok(meta.parts.every((p) => !("text" in p)), "元数据里不许带正文");
  assert.equal(meta.chars, res.section.length);
  assert.equal(meta.mode, "workspace");

  const part = personaPartText({ wsRoot: ws, id: "style" });
  assert.ok(part && part.text === STYLE_PRESETS.concise.text);
  assert.equal(personaPartText({ wsRoot: ws, id: "nope" }), null);
});

test("同源：section 就是各段按序 join（不会出现两套渲染）", () => {
  const ws = tmpWs();
  setWorkspaceStyle(ws, "deep");
  const res = resolvePersona({ wsRoot: ws, sessionId: "s9" });
  assert.equal(res.section, res.parts.map((p) => p.text).join("\n\n"));
  for (const p of res.parts) assert.ok(p.text.length > 0, `${p.id} 不该是空段`);
});
