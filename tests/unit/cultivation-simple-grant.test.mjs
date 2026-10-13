import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = f => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

test('授权中心的培养区只有状态与收回，细节折进高级设置', () => {
  const grants = src('frontend/src/pages/Grants.tsx');
  assert.ok(grants.includes('<GrantStatus') && grants.includes('高级设置'));
  assert.ok(grants.indexOf('<GrantStatus') < grants.indexOf('<Resources'), '状态在前，资源细节在后');
  const status = src('frontend/src/soul/cultivation/GrantStatus.tsx');
  for (const t of ['收回培养授权', '今日已用', '不含电脑、文件、密码、工具或私人记忆']) assert.ok(status.includes(t), t);
});

test('灵魂培养页以结果为先：最近成果在个体摘要里，不再有「等你点头」', () => {
  const panel = src('frontend/src/soul/cultivation/Panel.tsx');
  assert.ok(panel.includes('最近一次成果') && panel.includes('已出结果'));
  assert.ok(!panel.includes('等你点头'));
  assert.ok(!src('frontend/src/soul/Overview.tsx').includes('进入培养授权'));
});

test('母亲可自行暂停/恢复/归档/回滚自己的个体，红线（工具/电脑/凭据）不变', () => {
  const tr = src('engine/cultivation/control-transition.mjs');
  assert.ok(tr.includes("['agent.pause', 'agent.resume', 'agent.archive', 'agent.rollback'].includes(c.action)) return ['mother', 'human']"));
  const preset = src('engine/cultivation/grant-preset.mjs');
  assert.ok(preset.includes('policy.tools.length) return false') && preset.includes('motherLearning !== false'));
});
