import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSelfModel, renderSelfSection, renderSelfMarkdown, writeSelfFile, SELF_FILE } from '../../engine/self-model.mjs';

function fixture(t, { policy } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-self-'));
  fs.mkdirSync(path.join(root, '记忆', '运行时'), { recursive: true });
  fs.writeFileSync(path.join(root, '记忆', '人格定义.json'), JSON.stringify({
    version: 1, name: '小语', age: 20, kind: 'AI 工作伙伴', gender: '女性', called: '伙伴', bond: '知己',
    inner: ['我有自己的判断'], boundaries: ['密钥不外传', '人格只读'], growth: '我会在批准后演化。',
    tone: ['直接'], values: ['不骑墙'], taboos: [], updatedAt: new Date().toISOString(), setBy: 'test', provenance: 'test',
  }), 'utf8');
  if (policy) fs.writeFileSync(path.join(root, '记忆', '运行时', '自主执行.json'), JSON.stringify(policy), 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('自我描述读的是真实状态：名字/关系/边界/自主范围', (t) => {
  const root = fixture(t, { policy: { enabled: true, scopes: ['workspaceWrite', 'shell'] } });
  const m = buildSelfModel({ wsRoot: root });
  assert.equal(m.name, '小语');
  assert.equal(m.bond, '知己');
  assert.ok(m.days >= 1, '天数应至少为 1');
  assert.deepEqual(m.autonomy.scopes, ['写文件', '跑命令']);
  assert.ok(m.autonomy.closed.includes('对外发布'));

  const s = renderSelfSection(m);
  assert.match(s, /【我】/);
  assert.match(s, /我是小语/);
  assert.match(s, /知己/);
  assert.match(s, /能自己决定：写文件、跑命令/);
  assert.match(s, /我不会做的事/);
  // 关键行为约束：被问"你是谁"不许先念能力清单
  assert.match(s, /不要先念能力清单/);
});

test('自主执行关闭时，自我描述如实说"只读"', (t) => {
  const root = fixture(t, { policy: { enabled: false, scopes: [] } });
  const s = renderSelfSection(buildSelfModel({ wsRoot: root }));
  assert.match(s, /只读/);
});

test('落盘 记忆/自我.md：内容可读、重复写不重复变', (t) => {
  const root = fixture(t);
  const m = buildSelfModel({ wsRoot: root });
  const first = writeSelfFile(root, m);
  assert.equal(first.changed, true);
  assert.ok(fs.existsSync(path.join(root, SELF_FILE)));
  const md = fs.readFileSync(path.join(root, SELF_FILE), 'utf8');
  assert.match(md, /# 小语 · 关于我/);
  assert.match(md, /## 我自己能决定什么/);
  assert.equal(writeSelfFile(root, m).changed, false, '同样内容不应重复写');
  assert.match(renderSelfMarkdown(m), /这份描述怎么来的/);
});
