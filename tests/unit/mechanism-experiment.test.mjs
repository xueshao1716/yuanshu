import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { reconcileImageMessages } from '../../frontend/src/lib/image-identity.ts';

const service = await import('../../engine/mechanism-experiment.mjs').catch(() => ({}));
const fixtures = await import('../../engine/mechanism-image-cases.mjs').catch(() => ({}));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-mechanism-'));
const reportPath = ws => path.join(ws, '记忆', '做梦', 'mechanism-image-identity.json');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('图片实验检验实际整理函数，包含正例、反例和输入不变性', () => {
  assert.equal(typeof fixtures.measureImageExperiment, 'function', '缺少可执行实验定义');
  const rows = fixtures.measureImageExperiment(reconcileImageMessages);
  assert.ok(rows.length >= 6);
  assert.ok(rows.every(row => row.passed && row.inputUnchanged));
  const positive = rows.find(row => row.id === 'download-alias');
  assert.equal(positive.beforeCount, 2);
  assert.equal(positive.afterCount, 1);
  assert.ok(rows.filter(row => row.kind === 'counterexample').length >= 4);
});

test('无改动基线与激进去重均不能被标记为支持', () => {
  assert.equal(typeof fixtures.measureImageExperiment, 'function');
  const baseline = fixtures.measureImageExperiment(rows => rows);
  assert.equal(baseline.find(row => row.id === 'download-alias').passed, false);
  const destructive = fixtures.measureImageExperiment(rows => rows.map(row => ({ ...row, images: [] })));
  assert.ok(destructive.some(row => row.kind === 'counterexample' && !row.passed));
  const mutating = fixtures.measureImageExperiment(rows => {
    rows[0].text = 'changed';
    return reconcileImageMessages(rows);
  });
  assert.ok(mutating.every(row => !row.passed && !row.inputUnchanged));
});

test('执行前待验证；实际子进程结果持久化，重复执行不累计真实任务证据', async () => {
  assert.equal(typeof service.runMechanismExperiment, 'function', '缺少实验执行器');
  const ws = temp();
  try {
    assert.equal(service.mechanismStatus(ws).state, 'untested');
    const [first, joined] = await Promise.all([service.runMechanismExperiment(ws), service.runMechanismExperiment(ws)]);
    assert.equal(first.latest.id, joined.latest.id, '同工作区并发请求合并');
    assert.equal(first.state, 'supported');
    assert.equal(first.evidenceKind, 'synthetic-fixtures');
    assert.equal(first.promotionEligible, false);
    const stored = JSON.parse(fs.readFileSync(reportPath(ws), 'utf8')).reports[0];
    assert.equal(stored.definition?.hypothesis, first.definition.hypothesis, '保存当次假设快照，不能事后套用新定义');
    assert.ok(first.latest.cases.every(row => row.passed));
    const second = await service.runMechanismExperiment(ws);
    assert.notEqual(first.latest.id, second.latest.id);
    assert.equal(second.independentTaskCount, 0);
    assert.equal(second.recentRuns.length, 2);
    assert.deepEqual(fs.readdirSync(path.dirname(reportPath(ws))), ['mechanism-image-identity.json']);
    assert.equal(service.mechanismStatus(ws).latest.id, second.latest.id);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('旧代码报告失效，篡改通过标记不被采信，损坏报告可重跑恢复', async () => {
  assert.equal(typeof service.runMechanismExperiment, 'function');
  const ws = temp();
  try {
    await service.runMechanismExperiment(ws);
    const store = JSON.parse(fs.readFileSync(reportPath(ws), 'utf8'));
    const report = store.reports[0];
    const saved = structuredClone(report);
    report.cases[0].actual = [];
    report.cases[0].passed = true;
    const { contentDigest: unused, ...failingMeasurements } = report;
    report.contentDigest = hash(failingMeasurements);
    fs.writeFileSync(reportPath(ws), JSON.stringify(store));
    assert.equal(service.mechanismStatus(ws).state, 'not-supported', '结论来自实测数据，而非 passed 标记');
    assert.equal(service.mechanismStatus(ws).latest.cases[0].passed, false, '页面也须显示实测结论');
    Object.assign(report, saved);
    report.definition = { ...saved.definition, hypothesis: '不属于本次代码的假设' };
    const { contentDigest: ignored, ...changedDefinition } = report;
    report.contentDigest = hash(changedDefinition);
    fs.writeFileSync(reportPath(ws), JSON.stringify(store));
    assert.equal(service.mechanismStatus(ws).state, 'invalid', '当前代码不能套用其他假设');
    Object.assign(report, structuredClone(saved));
    report.sourceFingerprint = 'old-code';
    report.definition.hypothesis = '当次实验的原始假设';
    const { contentDigest, ...payload } = report;
    report.contentDigest = hash(payload);
    fs.writeFileSync(reportPath(ws), JSON.stringify(store));
    assert.equal(service.mechanismStatus(ws).state, 'stale');
    assert.equal(service.mechanismStatus(ws).definition.hypothesis, '当次实验的原始假设');
    report.cases[0].passed = false;
    fs.writeFileSync(reportPath(ws), JSON.stringify(store));
    assert.equal(service.mechanismStatus(ws).state, 'invalid');
    fs.writeFileSync(reportPath(ws), '{"state":"supported"}');
    assert.equal(service.mechanismStatus(ws).state, 'invalid');
    assert.equal((await service.runMechanismExperiment(ws)).state, 'supported');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('进化页展示实验边界；固定接口受既有鉴权保护，状态挂到做梦验收入口', () => {
  const read = rel => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
  const server = read('server.mjs');
  assert.ok(server.includes('["POST", "/api/dream/experiment"'), '缺少固定实验接口');
  assert.ok(read('engine/evolution-cycle.mjs').includes('experiment: mechanismStatus(wsRoot)'));
  const componentPath = new URL('../../frontend/src/components/MechanismExperimentPanel.tsx', import.meta.url);
  assert.ok(fs.existsSync(componentPath), '缺少进化页实验面板');
  const component = fs.readFileSync(componentPath, 'utf8');
  for (const text of ['隔离样例', '反证条件', '真实模型', '人工', 'role="status"']) assert.ok(component.includes(text), text);
  assert.ok(read('frontend/src/pages/Apps.tsx').includes('<MechanismExperimentPanel />'));
});
