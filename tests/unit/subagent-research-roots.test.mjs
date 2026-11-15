import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchExecutor } from '../../engine/subagent-research.mjs';

// 2026-11-15：同名相对路径在多个根下都存在时（工作区 engine/ 与代码仓 engine/），
// 以前只给第一个根的内容、不说明路径，模型会以为"目录里只有这些"并据此下错结论。
// 现在必须告出实际路径，并在另一处也有同名路径时提示可以换绝对路径再查。

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-research-roots-'));
  const a = path.join(dir, 'ws'), b = path.join(dir, 'repo');
  fs.mkdirSync(path.join(a, 'engine'), { recursive: true });
  fs.mkdirSync(path.join(b, 'engine'), { recursive: true });
  fs.writeFileSync(path.join(a, 'engine', 'only-ws.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(b, 'engine', 'team-board.mjs'), '// team-board 真身\nexport const ok = true;\n');
  return { dir, a, b };
}

test('相对路径命中多个根时，输出说明实际路径并提示另一处同名路径', async () => {
  const { dir, a, b } = sandbox();
  try {
    const ex = createResearchExecutor({ roots: [a, b] });
    const r = await ex('list', { path: 'engine' });
    const head = String(r.text).split('\n')[0];
    assert.match(head, /实际路径/);
    assert.ok(head.includes(path.join(a, 'engine')), '应标出用的是第一个根');
    assert.ok(head.includes(path.join(b, 'engine')), '应提示另一处同名路径');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('只有一个根命中时不啰嗦，只标实际路径', async () => {
  const { dir, a, b } = sandbox();
  fs.mkdirSync(path.join(a, 'only-in-ws'), { recursive: true });
  try {
    const ex = createResearchExecutor({ roots: [a, b] });
    const r = await ex('list', { path: 'only-in-ws' });
    const head = String(r.text).split('\n')[0];
    assert.match(head, /实际路径/);
    assert.equal(/另一处也有同名路径/.test(head), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('用绝对路径能读到第二个根里的真实文件', async () => {
  const { dir, a, b } = sandbox();
  try {
    const ex = createResearchExecutor({ roots: [a, b] });
    const r = await ex('read', { path: path.join(b, 'engine', 'team-board.mjs'), limit: 5 });
    assert.match(String(r.text), /team-board 真身/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grep 输出带范围与实际路径，便于判断查错了根', async () => {
  const { dir, a, b } = sandbox();
  try {
    const ex = createResearchExecutor({ roots: [a, b] });
    const r = await ex('grep', { pattern: 'team-board', path: 'engine' });
    assert.match(String(r.text), /范围：/);
    assert.match(String(r.text), /实际路径/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
