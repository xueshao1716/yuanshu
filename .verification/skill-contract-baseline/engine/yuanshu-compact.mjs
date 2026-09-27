// 元枢非破坏压缩：模型面摘要，原文留 archive / *.archive.jsonl
import fs from "node:fs";
import path from "node:path";

export function compactViewFromSummary(history = [], summaryText = "", { keep = 10 } = {}) {
  const keepN = Math.max(0, Number(keep) || 0);
  const keepMsgs = history.slice(-keepN);
  const hiddenCount = Math.max(0, history.length - keepMsgs.length);
  const view = [
    { role: "system", content: "【早前对话摘要】\n" + String(summaryText || ""), _section: "compaction" },
    ...keepMsgs,
  ];
  return { view, archive: history, hiddenCount };
}

export async function compactKeepArchive(history, compactFn) {
  if (!Array.isArray(history) || typeof compactFn !== "function") {
    return { view: history, archive: history, compacted: false };
  }
  const archive = history.slice();
  const next = await compactFn(history);
  if (!next || next === history) return { view: history, archive: history, compacted: false };
  return { view: next, archive, compacted: true };
}

export function archivePathFor(livePath) {
  return String(livePath || "").replace(/\.jsonl$/i, "") + ".archive.jsonl";
}

export function appendArchiveJsonl(archivePath, entries = []) {
  if (!archivePath || !entries.length) return;
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.appendFileSync(archivePath, body);
}

function messageText(entry) {
  const m = entry?.message || {};
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join(" ");
  }
  return "";
}

export function projectMessagesForModel(entries = []) {
  const out = [];
  for (const e of entries) {
    if (e?.type === "compaction" && e.summary) {
      out.push({ role: "system", content: "【早前对话摘要】\n" + String(e.summary) });
      continue;
    }
    if (e?.type !== "message" || e.surfaceHidden) continue;
    const m = e.message || {};
    out.push({ role: m.role || "user", content: messageText(e) });
  }
  return out;
}
