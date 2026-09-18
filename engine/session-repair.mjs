// ══ 会话文件修复（2026-09-18）══════════════════════════════════════════
// 为什么需要它：历史会话里已经躺着**会让整段会话永久 400** 的块，而它们在盘上，
// 光修写入路径救不回用户手里那条会话（真机事故：上传文件后该会话每一轮都是
// "You have uploaded an unsupported image"）。
//
// 两类病灶（都在 pi-ai 的 provider 适配层炸，元枢自己的组装层看不到）：
//   1) user 消息里的非 text 块（{type:"file"} / 没有 data 的 {type:"image"}）
//      → openai-completions 无脑写成 image_url: data:;base64,undefined → 上游 400；
//   2) assistant 消息里的附件块（{type:"image",url} 等）
//      → pi-ai 的 token 估算器读 block.name.length → TypeError，发请求前就崩。
// 修复方式：就地过一遍 sdkSafeUserBlocks / sdkSafeAssistantBlocks，把块改写成纯文本形态。
// 只动 user / assistant 两类消息；toolResult 里的图是 SDK 支持的形态，不碰。
import fs from "node:fs";
import path from "node:path";
import { sdkSafeUserBlocks, sdkSafeAssistantBlocks } from "./yuanshu-session.mjs";

const INTERESTING = /"type":"(file|image|video|audio)"/;

function sanitizeBlocks(role, content) {
  if (!Array.isArray(content)) return null;
  if (role === "user") return sdkSafeUserBlocks(content);
  if (role === "assistant") return sdkSafeAssistantBlocks(content);
  return null;
}

function sameBlocks(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!x || !y || typeof x !== "object" || typeof y !== "object") return false;
    const kx = Object.keys(x), ky = Object.keys(y);
    if (kx.length !== ky.length) return false;
    for (const k of kx) if (x[k] !== y[k]) return false;
  }
  return true;
}

// 修复一行 JSONL；返回 { line, changed }。解析不了的行原样返回（不毁用户数据）。
export function repairSessionLine(line) {
  const s = String(line ?? "");
  if (!s || s.indexOf('"type":"message"') < 0 || !INTERESTING.test(s)) return { line: s, changed: false };
  let entry;
  try { entry = JSON.parse(s); } catch { return { line: s, changed: false }; }
  const msg = entry?.message;
  const fixed = sanitizeBlocks(msg?.role, msg?.content);
  if (!fixed || sameBlocks(msg.content, fixed)) return { line: s, changed: false };
  const next = { ...entry, message: { ...msg, content: fixed } };
  return { line: JSON.stringify(next), changed: true };
}

// 修复整个文件内容（纯函数，便于单测）
export function repairSessionText(text) {
  const src = String(text ?? "");
  if (!src || !INTERESTING.test(src)) return { text: src, changed: false, repaired: 0 };
  let changed = false, repaired = 0;
  const out = [];
  for (const line of src.split("\n")) {
    if (!line) { out.push(line); continue; }
    const r = repairSessionLine(line);
    if (r.changed) { changed = true; repaired++; }
    out.push(r.line);
  }
  return { text: out.join("\n"), changed, repaired };
}

// 就地修复一个会话文件；改前留一份 .bak-sdk-safe（只留一次，不覆盖最早的备份）
export function repairSessionFile(file, { backup = true } = {}) {
  const res = { file, changed: false, repaired: 0, backup: "", error: "" };
  try {
    if (!file || !fs.existsSync(file)) return { ...res, error: "文件不存在" };
    const src = fs.readFileSync(file, "utf8");
    const fixed = repairSessionText(src);
    res.repaired = fixed.repaired;
    if (!fixed.changed) return res;
    if (backup) {
      const bak = `${file}.bak-sdk-safe`;
      try { if (!fs.existsSync(bak)) { fs.copyFileSync(file, bak); res.backup = bak; } } catch {}
    }
    // 原子写：先写临时文件再替换，避免半截文件把会话毁掉
    const tmp = `${file}.repair-tmp`;
    fs.writeFileSync(tmp, fixed.text);
    fs.renameSync(tmp, file);
    res.changed = true;
  } catch (e) {
    return { ...res, error: String(e?.message || e).slice(0, 160) };
  }
  return res;
}

// 批量修复一个会话目录（只读一遍就判断：没有可疑块的文件直接跳过）
export function repairSessionDir(dir, { backup = true, maxFiles = 2000, onFile = null } = {}) {
  const summary = { dir: String(dir || ""), scanned: 0, repaired: 0, lines: 0, files: [] };
  let names = [];
  try { names = fs.readdirSync(summary.dir).filter(n => n.endsWith(".jsonl")); } catch { return summary; }
  for (const n of names.slice(0, maxFiles)) {
    const file = path.join(summary.dir, n);
    let src = "";
    try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
    summary.scanned++;
    if (!INTERESTING.test(src) || !src.includes('"type":"message"')) continue;
    const r = repairSessionFile(file, { backup });
    if (r.error) { summary.files.push({ file: n, error: r.error }); continue; }
    if (r.changed) {
      summary.repaired++;
      summary.lines += r.repaired;
      summary.files.push({ file: n, lines: r.repaired, backup: r.backup });
      if (typeof onFile === "function") { try { onFile(r); } catch {} }
    }
  }
  return summary;
}
