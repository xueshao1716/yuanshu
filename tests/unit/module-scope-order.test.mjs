// 引擎/服务端也要防"先用后声明"（2026-09-18）。
//
// 为什么单独有这一条：前端那条 tsc 硬线只覆盖 frontend/src。server.mjs 与 engine/*.mjs 是纯 JS，
// 没有类型检查——而**我自己就刚在这里摔了一次**：
//   const UNIFIED_TOOLS = [ ..., FIX_PROBLEM_TOOL ];   // 引用
//   ...
//   const FIX_PROBLEM_TOOL = { ... };                  // 却声明在下面
// 结果是进程起不来：`ReferenceError: Cannot access 'FIX_PROBLEM_TOOL' before initialization`。
// node --check 只查语法，查不出这个；这个模块求值期就炸，只会在启动时才暴露。
//
// 判据刻意收窄，避免误报：只看**顶层多行数组/对象字面量**（`const X = [` 开头、行首 `]`/`}` 收尾）。
// 这类初始化是模块求值时立刻执行的，里面的标识符必须已经声明；函数体不算（它们晚于求值才执行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['server.mjs', ...fs.readdirSync(path.join(ROOT, 'engine')).filter((f) => f.endsWith('.mjs')).map((f) => path.join('engine', f))];

/** 顶层多行字面量的起止行（1-based，含结束行）。 */
function literalSpans(lines) {
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*[\[{]/);
    if (!m) continue;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[\]}];?\s*$/.test(lines[j])) { end = j; break; }
      if (/^const\s/.test(lines[j])) break; // 兜底：没找到收尾就不判（宁可漏，不可误报）
    }
    if (end > i) spans.push({ name: m[1], start: i, end, text: lines.slice(i, end + 1).join('\n') });
  }
  return spans;
}

test('engine/server 顶层字面量不得引用更靠后声明的常量（模块求值期就会炸）', () => {
  const bad = [];
  for (const rel of FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const declLine = new Map();
    lines.forEach((line, i) => {
      const m = line.match(/^const\s+([A-Za-z_$][\w$]*)\s*=/);
      if (m && !declLine.has(m[1])) declLine.set(m[1], i);
    });
    for (const span of literalSpans(lines)) {
      for (const id of new Set(span.text.match(/[A-Za-z_$][\w$]*/g) || [])) {
        const at = declLine.get(id);
        if (at !== undefined && at > span.start) {
          bad.push(`${rel}: ${span.name}（第 ${span.start + 1} 行）引用了第 ${at + 1} 行才声明的 ${id}`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], `先用后声明（模块求值即 ReferenceError）：\n  ${bad.join('\n  ')}`);
});
