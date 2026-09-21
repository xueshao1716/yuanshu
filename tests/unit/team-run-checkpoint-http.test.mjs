import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('real runner resumes from durable stages without repeating model or submission requests', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0, submissions = 0;
  const final = { title: '测试', aspect: '9:16', total_sec: 10, consistencyKey: '同一人物', negative: ['变形'], text_handling: '不添加文字',
    shots: [1, 2, 3].map(no => ({ no, sec: no === 3 ? 4 : 3, shot_size: '近景', camera: '推进', angle: '平视', desc: '人物行走', prompt: '人物在阳光下行走' })) };
  const reply = { ...final, final, unresolved: [], complexity: 'MED', deliverables: ['脚本'],
    rulings: [{ issue: '镜头选择', winner: 'VIDEO', reason: '符合时长' }], issues: [], conflicts: [],
    items: Array.from({ length: 12 }, (_, i) => ({ id: `V-${String(i + 1).padStart(2, '0')}`, pass: true, note: '模拟检查' })) };
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain request */ }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/models') return res.end(JSON.stringify({ models: [{ provider: 'fixture', id: 'fixture-model' }] }));
    if (req.url === '/api/team/complete') { calls++; return res.end(JSON.stringify({ text: JSON.stringify(reply) })); }
    if (req.url === '/api/pending') { submissions++; return res.end(JSON.stringify({ ok: true, id: 'pfixture' })); }
    res.writeHead(404); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  async function run(id, resume = '') {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/team-run-live.mjs', import.meta.url)), '测试任务'], {
      cwd: root, windowsHide: true, env: { ...process.env, YUANSHU_CWD: root, YUANSHU_TOKEN: 'fixture',
        YUANSHU_TEAM_BASE_URL: `http://127.0.0.1:${server.address().port}`, YUANSHU_TEAM_LAUNCH_ID: id, YUANSHU_TEAM_RESUME_ID: resume },
    });
    let errors = ''; child.stdout.resume(); child.stderr.on('data', b => { errors += b; });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const [code] = await once(child, 'exit'); assert.equal(code, 0, errors);
  }
  await run('first-run');
  assert.ok(calls >= 7); assert.equal(submissions, 1);
  const firstCalls = calls;
  await run('second-run', 'first-run');
  assert.equal(calls, firstCalls); assert.equal(submissions, 1);
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, '工程/多AI角色扮演系统/team-run.json'), 'utf8'));
  assert.equal(snapshot.launchId, 'second-run');
  assert.equal(snapshot.runId, 'live-VIDEO-first-run');
});
