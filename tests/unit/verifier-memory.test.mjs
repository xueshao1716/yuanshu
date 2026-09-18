// 独立验证者 + canonical/working 记忆分离 —— 抄 RSIAgent 最值钱的两条设计。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVerifyPrompt, parseVerdict, artifactDigest, verifyArtifacts } from '../../engine/verifier.mjs';
import { isCanonicalTarget, stageWrite, listStaged, commitStaged, dropStaged, stagingDir } from '../../engine/memory-stages.mjs';
import { openTrace, loadTrace } from '../../engine/trace.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-verify-'));

test('验证提示词只给"声明 + 产物路径"，不给执行者的自述（信息边界）', () => {
  const p = buildVerifyPrompt({ claim: '已修复登录超时', artifacts: ['/tmp/a.txt'] });
  assert.match(p, /独立验证者/);
  assert.match(p, /已修复登录超时/);
  assert.match(p, /\/tmp\/a\.txt/);
  assert.match(p, /只读不写/);
  assert.match(p, /"verdict":"PASS\|FAIL\|UNVERIFIED"/);
  // 入参里根本没有 evidence 这个口子：想塞自述也塞不进来
  const withEvidence = buildVerifyPrompt({ claim: 'x', artifacts: [], evidence: '我自己确认过了，肯定没问题' });
  assert.doesNotMatch(withEvidence, /我自己确认过/, '执行者的自述绝不能进验证轮');
});

test('结论解析：只认三种 verdict，取最后一个 json 块', () => {
  assert.equal(parseVerdict('```json\n{"verdict":"PASS","evidence":"ls 看到文件"}\n```').verdict, 'PASS');
  assert.equal(parseVerdict('```json\n{"verdict":"fail"}\n```').verdict, 'FAIL');
  assert.equal(parseVerdict('```json\n{"verdict":"UNVERIFIED"}\n```').verdict, 'UNVERIFIED');
  assert.equal(parseVerdict('```json\n{"verdict":"大概成了"}\n```'), null, '不认识的结论不猜');
  assert.equal(parseVerdict('我查了，没问题（但没给 JSON）'), null);
  const two = parseVerdict('```json\n{"verdict":"FAIL"}\n```\n改口：\n```json\n{"verdict":"PASS","evidence":"e"}\n```');
  assert.equal(two.verdict, 'PASS', '取最后一个');
});

test('裁判不许改标的：验证前后产物变了，直接判 FAIL（tampered）', async () => {
  const root = tmp();
  const f = path.join(root, 'artifact.txt');
  fs.writeFileSync(f, '原始内容', 'utf8');
  const before = artifactDigest([f]);
  assert.match(before[f], /^file:/);

  const clean = await verifyArtifacts({
    claim: '文件内容正确', artifacts: [f],
    runTurn: async () => '```json\n{"verdict":"PASS","evidence":"cat 看到原始内容"}\n```',
  });
  assert.equal(clean.verdict, 'PASS');
  assert.equal(clean.tampered, false);

  const dirty = await verifyArtifacts({
    claim: '文件内容正确', artifacts: [f],
    runTurn: async () => { fs.writeFileSync(f, '被裁判改了', 'utf8'); return '```json\n{"verdict":"PASS","evidence":"我顺手修了一下"}\n```' },
  });
  assert.equal(dirty.verdict, 'FAIL', '改过标的的 PASS 一律作废');
  assert.equal(dirty.tampered, true);
  assert.match(dirty.evidence, /裁判不许改标的/);
});

test('验证轮不给结论 / 异常 → UNVERIFIED（不猜成功、也不冤枉成失败）', async () => {
  const root = tmp();
  const f = path.join(root, 'a.txt');
  fs.writeFileSync(f, 'x', 'utf8');
  const none = await verifyArtifacts({ claim: 'c', artifacts: [f], runTurn: async () => '我觉得没问题' });
  assert.equal(none.verdict, 'UNVERIFIED');
  const boom = await verifyArtifacts({ claim: 'c', artifacts: [f], runTurn: async () => { throw new Error('模型挂了') } });
  assert.equal(boom.verdict, 'UNVERIFIED');
  assert.match(boom.evidence, /异常/);
});

test('验证落轨迹节点：验证也算一次探索尝试（可回放）', async () => {
  const root = tmp();
  const { trace } = openTrace(root, { kind: 'fix-attempt', goal: '修 X' });
  const f = path.join(root, 'a.txt');
  fs.writeFileSync(f, 'x', 'utf8');
  await verifyArtifacts({ wsRoot: root, traceId: trace.id, claim: 'c', artifacts: [f], runTurn: async () => '```json\n{"verdict":"PASS","evidence":"ok"}\n```' });
  const t = loadTrace(root, trace.id);
  assert.equal(t.nodes.length, 1);
  assert.equal(t.nodes[0].action, '独立验证');
  assert.equal(t.nodes[0].outcome, 'PASS');
  assert.equal(t.nodes[0].score, 1);
});

test('规范区判据：skills/ 与授权状/现役策略算规范区，普通文件不算', () => {
  const root = 'D:\\pi-workspace';
  assert.equal(isCanonicalTarget(path.join(root, 'skills', 'x', 'SKILL.md'), { wsRoot: root }), true);
  assert.equal(isCanonicalTarget(path.join(root, '记忆', '做梦', '授权状.json'), { wsRoot: root }), true);
  assert.equal(isCanonicalTarget(path.join(root, '记忆', '做梦', '现役探索策略.json'), { wsRoot: root }), true);
  assert.equal(isCanonicalTarget(path.join(root, '生成物', 'a.png'), { wsRoot: root }), false);
  assert.equal(isCanonicalTarget(path.join(root, '记忆', '记忆.md'), { wsRoot: root }), false);
});

test('记忆分离：写规范区先进草案区；没验证过不许 commit；PASS 或人批准才落地', () => {
  const root = tmp();
  const target = path.join(root, 'skills', 'demo', 'SKILL.md');
  const st = stageWrite(root, { target, content: '---\nname: demo\n---\n正文', reason: '任务成功后自沉淀' });
  assert.equal(st.ok, true);
  assert.equal(fs.existsSync(target), false, '草案阶段绝不能碰规范区');
  assert.ok(st.stagedPath.startsWith(stagingDir(root)));
  assert.equal(listStaged(root).length, 1);

  const denied = commitStaged(root, st.id, { verdict: 'UNVERIFIED' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /未通过独立验证/);
  assert.equal(fs.existsSync(target), false);

  const ok = commitStaged(root, st.id, { verdict: 'PASS' });
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8').includes('name: demo'), true);
  assert.equal(listStaged(root)[0].state, 'committed');

  // 人可以直接批准（人不需要向验证者证明）
  const t2 = path.join(root, 'skills', 'demo2', 'SKILL.md');
  const st2 = stageWrite(root, { target: t2, content: 'x' });
  assert.equal(commitStaged(root, st2.id, { by: 'human' }).ok, true);
  assert.equal(fs.existsSync(t2), true);

  // 丢掉草案
  const st3 = stageWrite(root, { target: path.join(root, 'skills', 'demo3', 'SKILL.md'), content: 'y' });
  assert.equal(dropStaged(root, st3.id).ok, true);
  assert.equal(listStaged(root).some((m) => m.id === st3.id), false);
});
