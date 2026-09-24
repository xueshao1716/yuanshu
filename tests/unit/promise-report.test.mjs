import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../../scripts/check-promises.mjs', import.meta.url));
test('承诺扫描仅计 pending，沿用运行时宽限及无日期规则，不写账本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-promises-'));
  const ago = days => new Date(Date.now()-days*86400000).toISOString();
  const rows = [
    {id:'kept',text:'兑现',status:'kept',at:ago(10),due:ago(8)},
    {id:'due',text:'逾期',status:'pending',at:ago(10),due:ago(2)},
    {id:'grace',text:'宽限',status:'pending',at:ago(3),due:ago(0.5)},
    {id:'undated',text:'积压',status:'pending',at:ago(8),due:null},
  ];
  try {
    fs.mkdirSync(path.join(dir,'记忆'));
    const file=path.join(dir,'记忆/承诺兑现.json');
    fs.writeFileSync(file,JSON.stringify(rows));
    const cli=spawnSync(process.execPath,[script,'--json'],{cwd:dir,encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr);
    const report=JSON.parse(cli.stdout);
    assert.equal(report.pending,3);
    assert.equal(report.overdue,2);
    assert.deepEqual(new Set(report.items.map(x=>x.id)),new Set(['due','undated']));
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),rows);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('缺失或损坏账本明确失败，不伪报零逾期', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-promises-invalid-'));
  try {
    fs.mkdirSync(path.join(dir, '记忆'));
    for (const data of [null, '{bad', '{}']) {
      if (data !== null) fs.writeFileSync(path.join(dir, '记忆/承诺兑现.json'), data);
      const cli = spawnSync(process.execPath, [script, '--workspace', dir, '--json'], { encoding: 'utf8' });
      assert.equal(cli.status, 1);
      assert.equal(cli.stdout, '');
      assert.match(cli.stderr, /承诺扫描失败/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
