// 记忆现行事实：同 topic 只留一条 current，写时作废旧条
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "./atomic-io.mjs";
import { syncMemoryToTui } from "./memory-sync.mjs";

const HEADING_RE = /^#{2,4}\s+\d{4}-\d{2}-\d{2}/;

export function factKey(section, topic) {
  const s = String(section || "").trim();
  const t = String(topic || "").trim();
  if (!s) return "";
  return t ? `${s} / ${t}` : s;
}

export function splitLogBlocks(raw) {
  const lines = String(raw || "").split("\n");
  const blocks = [];
  const prefix = [];
  let cur = [];
  for (const ln of lines) {
    if (HEADING_RE.test(ln)) {
      if (cur.length) blocks.push(cur.join("\n"));
      cur = [ln];
    } else if (cur.length) cur.push(ln);
    else prefix.push(ln);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return { prefix: prefix.join("\n"), blocks };
}

export function isSupersededBlock(block) {
  return /^- status:\s*superseded\b/m.test(String(block || ""));
}

export function blockTopic(block) {
  const m = String(block || "").match(/^- topic:\s*(.+)$/m);
  return m ? m[1].trim() : "";
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function paths(wsRoot) {
  return {
    fixed: path.join(wsRoot, "记忆.md"),
    log: path.join(wsRoot, "记忆", "记忆日志.md"),
  };
}

function stampNow() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}`;
}

function setBlockStatus(block, status) {
  if (/^- status:\s*/m.test(block)) return block.replace(/^- status:\s*.*$/m, `- status: ${status}`);
  const lines = block.split("\n");
  lines.splice(1, 0, `- status: ${status}`);
  return lines.join("\n");
}

function joinLog(prefix, blocks) {
  const head = prefix.replace(/\n*$/, "");
  const body = blocks.join("\n").replace(/^\n+/, "");
  if (!head && !body) return "";
  if (!head) return body.endsWith("\n") ? body : body + "\n";
  if (!body) return head.endsWith("\n") ? head : head + "\n";
  return (head.endsWith("\n") ? head : head + "\n") + body + (body.endsWith("\n") ? "" : "\n");
}

function upsertFixedLine(fixed, section, topic, text) {
  const key = topic || "现行";
  const line = `- **${key}**：${text}`;
  const headingRe = new RegExp(`^##\\s+.*${escapeRe(section)}.*$`, "m");
  const bulletRe = new RegExp(`^- \\*\\*${escapeRe(key)}\\*\\*[：:].*$`, "m");
  const m = headingRe.exec(fixed);
  if (!m) return (fixed.replace(/\n*$/, "") + `\n\n## ${section}\n${line}\n`);
  const afterHead = m.index + m[0].length;
  const rest = fixed.slice(afterHead);
  const next = rest.search(/\n## /);
  const end = next >= 0 ? afterHead + next : fixed.length;
  let body = fixed.slice(afterHead, end);
  if (bulletRe.test(body)) body = body.replace(bulletRe, line);
  else body = "\n" + line + (body.startsWith("\n") ? body : "\n" + body);
  return fixed.slice(0, afterHead) + body + fixed.slice(end);
}

function supersedeSameTopic(raw, key) {
  const { prefix, blocks } = splitLogBlocks(raw);
  let n = 0;
  const next = blocks.map((b) => {
    if (blockTopic(b) !== key) return b;
    if (isSupersededBlock(b)) return b;
    n++;
    return setBlockStatus(b, "superseded");
  });
  return { raw: joinLog(prefix, next), count: n };
}

export function upsertMemoryFact(wsRoot, { section = "", topic = "", text = "", reason = "" } = {}) {
  const sec = String(section || "").trim();
  const body = String(text || "").trim();
  if (!sec || !body) return { ok: false, reason: "缺少 section 或 text" };
  const key = factKey(sec, topic);
  const p = paths(wsRoot);
  try {
    fs.mkdirSync(path.dirname(p.log), { recursive: true });
    let fixed = "";
    try { fixed = fs.readFileSync(p.fixed, "utf8"); } catch {}
    atomicWriteText(p.fixed, upsertFixedLine(fixed, sec, String(topic || "").trim(), body));

    let log = "";
    try { log = fs.readFileSync(p.log, "utf8"); } catch {}
    const marked = supersedeSameTopic(log, key);
    const entry = `### ${stampNow()}\n- topic: ${key}\n- status: current\n- 要点：${body}${reason ? `\n- 原因：${String(reason).trim()}` : ""}\n`;
    atomicWriteText(p.log, marked.raw.replace(/\n*$/, "\n") + entry + "\n");
    try {
      const live = process.env.PI_WEB_CWD || "D:/pi-workspace";
      if (path.resolve(wsRoot) === path.resolve(live)) syncMemoryToTui();
    } catch {}
    return { ok: true, key, superseded: marked.count };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 80) };
  }
}
