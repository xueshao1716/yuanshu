// 一次性数据修复：把**历史会话**里 assistant 消息 content 中的附件块改写成 markdown 文本。
//
// 为什么必须有它：修复 engine/yuanshu-session.mjs 只能拦住"以后不再写脏数据"，
// 而已经写下的那条脏消息会一直让整段会话不可重放——
// pi SDK 的 token 估算器（pi-ai/dist/utils/estimate.js:42）把非 text/thinking 的块
// 当工具调用读 block.name.length，于是 {type:"image",url} 会在发请求前抛
//   TypeError: Cannot read properties of undefined (reading 'length')
// 真机上表现为"切到 deepseek 之后一句话都不回"。
//
// 安全约定：默认 dry-run；--apply 才写盘；每个被改的文件先留 .bak-<时间戳> 备份；
// 只改 assistant 消息里**确实需要改写**的行，其它内容一个字节都不动。
//
// 用法：
//   node scripts/fix-session-image-blocks.mjs                 # 只报告
//   node scripts/fix-session-image-blocks.mjs --apply         # 真改（带备份）
//   node scripts/fix-session-image-blocks.mjs --dir <目录>    # 换会话目录（默认 ~/.pi/agent/sessions）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sdkSafeAssistantBlocks } from '../engine/yuanshu-session.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dirArg = args[args.indexOf('--dir') + 1];
const ROOT = dirArg && !dirArg.startsWith('--') ? dirArg : path.join(os.homedir(), '.pi', 'agent', 'sessions');

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.trash') walk(p, out); }
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export function needsRewrite(content) {
  if (!Array.isArray(content)) return false;
  return content.some(b => b && typeof b === 'object' && !['text', 'thinking', 'redacted_thinking', 'toolCall', 'tool_call', 'toolResult', 'tool_result', 'toolUse', 'tool_use'].includes(String(b.type || '')));
}

export function rewriteFile(file, { apply = false } = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  let touched = 0;
  const next = lines.map(line => {
    if (!line.trim()) return line;
    let obj;
    try { obj = JSON.parse(line); } catch { return line; }
    const msg = obj?.message;
    if (obj?.type !== 'message' || msg?.role !== 'assistant' || !needsRewrite(msg.content)) return line;
    touched++;
    return JSON.stringify({ ...obj, message: { ...msg, content: sdkSafeAssistantBlocks(msg.content) } });
  });
  if (!touched) return { touched: 0, backup: null };
  if (!apply) return { touched, backup: null, pending: true };
  const backup = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, next.join('\n'));
  return { touched, backup };
}

const files = walk(ROOT);
let filesTouched = 0;
let linesTouched = 0;
const details = [];
for (const f of files) {
  const r = rewriteFile(f, { apply: APPLY });
  if (r.touched) {
    filesTouched++;
    linesTouched += r.touched;
    details.push({ file: f, lines: r.touched, backup: r.backup });
  }
}

console.log(`会话目录: ${ROOT}`);
console.log(`扫描 ${files.length} 个会话文件；需要改写的有 ${filesTouched} 个，共 ${linesTouched} 条 assistant 消息`);
for (const d of details.slice(0, 40)) console.log(`  ${d.lines} 条  ${path.basename(d.file)}${d.backup ? `  → 备份 ${path.basename(d.backup)}` : ''}`);
if (!APPLY && filesTouched) console.log('\n（这是 dry-run。加 --apply 真改，改前会自动备份 .bak-<时间戳>）');
if (APPLY) console.log('\n✅ 已改写（原文件已备份）');
