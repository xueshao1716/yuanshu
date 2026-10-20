import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readComponent, systemPrompt, guardrailsText, guardrailAudit, harnessManifest, componentPath,
} from '../../engine/harness-components.mjs';
import { YUANSHU_PROTOCOL } from '../../engine/yuanshu-protocol.mjs';
import { USER_DENY_PATTERNS } from '../../engine/tools/security.mjs';

function tempWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
  fs.mkdirSync(path.join(dir, '记忆', 'harness'), { recursive: true });
  return dir;
}

test('组件：文件优先，缺失回退内置', () => {
  const ws = tempWs();
  // ① 无文件 → 内置
  const builtin = readComponent(ws, 'system', YUANSHU_PROTOCOL);
  assert.equal(builtin.source, 'builtin');
  assert.equal(builtin.text, YUANSHU_PROTOCOL);

  // ② 有文件 → 用文件
  fs.writeFileSync(componentPath(ws, 'system'), '自定义协议正文\n', 'utf8');
  const fromFile = readComponent(ws, 'system', YUANSHU_PROTOCOL);
  assert.equal(fromFile.source, 'file');
  assert.equal(fromFile.text.trim(), '自定义协议正文');

  // ③ 空文件 → 仍回退内置（不能因为一个空文件把协议清空）
  fs.writeFileSync(componentPath(ws, 'system'), '   \n', 'utf8');
  assert.equal(readComponent(ws, 'system', YUANSHU_PROTOCOL).source, 'builtin');
});

test('护栏：文字来自宪法，代码硬拦单独标注', () => {
  const ws = tempWs();
  fs.writeFileSync(path.join(ws, '宪法.json'), JSON.stringify({
    schema_version: 1,
    clauses: [
      { id: 'no-money', text: '不碰钱', status: 'accepted', origin: 'human' },
      { id: 'draft-only', text: '未批准条款', status: 'suggested', origin: 'model' },
    ],
  }), 'utf8');
  const text = guardrailsText(ws);
  assert.match(text, /no-money/);
  assert.doesNotMatch(text, /draft-only/); // 未批准的不进提示词
  assert.match(text, /代码级硬拦/);
});

test('护栏审计：能看出「代码没人认领」和「条款悬空」', () => {
  const ws = tempWs();
  fs.writeFileSync(path.join(ws, '宪法.json'), JSON.stringify({
    schema_version: 2,
    clauses: [{ id: 'no-money', text: '不碰钱', status: 'accepted', origin: 'human' }],
  }), 'utf8');
  const audit = guardrailAudit(ws);
  assert.ok(audit.uncoveredCode.includes('no-tunnel'), '代码在拦但没条款认领 → 要列出来');
  assert.ok(audit.unenforcedClauses.includes('no-money'), '条款没写落地方式 → 要列出来');
});

test('护栏审计：全部覆盖时不留缺口（host 条款也能认领）', () => {
  const ws = tempWs();
  fs.writeFileSync(path.join(ws, '宪法.json'), JSON.stringify({
    schema_version: 2,
    clauses: [{
      id: 'no-tunnel', text: '不碰隧道', status: 'accepted', origin: 'host',
      enforcement: 'code', enforced_by: USER_DENY_PATTERNS.map(r => r.id),
    }],
  }), 'utf8');
  const audit = guardrailAudit(ws);
  assert.deepEqual(audit.uncoveredCode, []);
  assert.deepEqual(audit.unenforcedClauses, []);
});

test('manifest：八个组件，来源可追溯', () => {
  const ws = tempWs();
  const man = harnessManifest(ws);
  assert.equal(man.components.length, 8);
  const ids = man.components.map(c => c.id);
  for (const id of ['system', 'guardrails', 'memory', 'skills', 'tools', 'scripts', 'subagents', 'plugin']) {
    assert.ok(ids.includes(id), `缺组件 ${id}`);
  }
  const builtin = man.components.find(c => c.id === 'system');
  assert.equal(builtin.writable, 'owner-only');
  assert.equal(builtin.source, 'builtin', '没有文件时来源要如实写 builtin');
  assert.equal(builtin.path, '');

  // 放一份文件后，manifest 要指到那份文件
  fs.writeFileSync(componentPath(ws, 'system'), '文件版协议\n', 'utf8');
  const fromFile = harnessManifest(ws).components.find(c => c.id === 'system');
  assert.equal(fromFile.source, 'file');
  assert.ok(fromFile.path.endsWith('system.md'));
});

test('协议文本：编号 1–13 连续（重构后不应再出现两个 5）', () => {
  const nums = [...YUANSHU_PROTOCOL.matchAll(/^(\d+)\./gm)].map(m => Number(m[1]));
  assert.deepEqual(nums, Array.from({ length: 13 }, (_, i) => i + 1));
});
