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
//
// 2026-09-20 修一次误报：上面的"函数体不算"原来只是注释，代码却在整段字面量文本上抓标识符，
// 于是 `["GET", "/api/pending", (res) => pendingApi.list(res)]` 里的 `pendingApi`（3081 行声明）
// 被误报成"先用后声明"。那种写法求值期只创建一个闭包、根本不读 pendingApi，服务实测也正常。
// 现在按注释的本意解析：箭头/函数体、字符串、注释里的名字都不算引用；裸标识符照旧要抓。
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

/** 跳过从 i 开始的字符串/模板串，返回结束后的下标。 */
function skipString(text, i) {
  const q = text[i];
  i++;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === q) return i + 1;
    i++;
  }
  return text.length;
}

/** 跳过从 open（'{'）开始的花括号块，返回结束后的下标。 */
function skipBlock(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i) - 1; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return text.length;
}

/**
 * 取字面量里**求值期真的会被读到**的标识符。
 * 函数体（`=> …` 与 `function …`）晚于求值才执行，字符串与注释里的名字也不是引用。
 */
function valueIdents(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '=' && text[i + 1] === '>') { // 箭头函数：整个函数体不是求值期代码
      i += 2;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === '{') i = skipBlock(text, i);
      else while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text.startsWith('function', i) && !/[\w$]/.test(text[i - 1] || '')) {
      const b = text.indexOf('{', i);
      i = b === -1 ? text.length : skipBlock(text, b);
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j++;
      out.push(text.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

// 判据自身的门：先证明它抓得住真事故、又不会被闭包/字符串带偏——否则"修误报"可能修成"没保护"。
test('判据本身：裸标识符要抓，函数体/字符串里的名字不抓', () => {
  const literal = [
    'const A = [',
    '  FIX_PROBLEM_TOOL,',
    '  (res) => pendingApi.list(res),',
    '  () => laterApi.go(),',
    '  { h: () => nestedLater },',
    '  "laterInString",',
    "  'laterInSingle',",
    ']',
  ].join('\n');
  const ids = valueIdents(literal);
  assert.ok(ids.includes('FIX_PROBLEM_TOOL'), '裸标识符必须被抓住（否则真事故会漏）');
  for (const name of ['pendingApi', 'laterApi', 'nestedLater', 'laterInString', 'laterInSingle']) {
    assert.ok(!ids.includes(name), `${name} 在函数体/字符串里，不该被判为求值期引用`);
  }
});

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
      for (const id of new Set(valueIdents(span.text))) {
        const at = declLine.get(id);
        if (at !== undefined && at > span.start) {
          bad.push(`${rel}: ${span.name}（第 ${span.start + 1} 行）引用了第 ${at + 1} 行才声明的 ${id}`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], `先用后声明（模块求值即 ReferenceError）：\n  ${bad.join('\n  ')}`);
});
