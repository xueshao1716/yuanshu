// 补 edit 的规范区闸门测试：改 skills/** 必须先落草案区，规范区文件一个字都不许动。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUnifiedToolExecutor } from '../../engine/tools/unified-tools.mjs';
import { listStaged } from '../../engine/memory-stages.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-edit-gate-'));

test('edit 改 skills/** → 进草案区；规范区文件保持原样', async () => {
  const root = tmp();
  const skillDir = path.join(root, 'skills', 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(file, '---\nname: demo\ndescription: 旧\n---\n旧正文\n', 'utf8');

  const exec = createUnifiedToolExecutor({ cwd: () => root, safePath: (p) => path.resolve(root, String(p || '')) });
  const r = await exec('edit', { path: 'skills/demo/SKILL.md', oldText: '旧正文', newText: '新正文（经验沉淀）' });

  assert.equal(r.isError, false, '不该报错，而是"已进草案区"');
  assert.match(r.text, /草案区/, '要明确告诉它这是草案，不是写成功了');
  assert.equal(fs.readFileSync(file, 'utf8').includes('旧正文'), true, '规范区文件必须一字未改');
  const staged = listStaged(root);
  assert.equal(staged.length, 1);
  assert.equal(staged[0].target, file);
  assert.equal(fs.readFileSync(staged[0] ? path.join(root, '记忆', '草案区', staged[0].id, 'content') : '', 'utf8').includes('新正文（经验沉淀）'), true, '草案里是改完之后的内容');
});

test('edit 改普通文件 → 照旧直接写（闸只拦规范区，不拦正常干活）', async () => {
  const root = tmp();
  const file = path.join(root, '普通.txt');
  fs.writeFileSync(file, 'abc', 'utf8');
  const exec = createUnifiedToolExecutor({ cwd: () => root, safePath: (p) => path.resolve(root, String(p || '')) });
  const r = await exec('edit', { path: '普通.txt', oldText: 'abc', newText: 'abd' });
  assert.equal(r.isError, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'abd', '普通文件应当真的被改了');
  assert.equal(listStaged(root).length, 0, '不该产生草案');
});
