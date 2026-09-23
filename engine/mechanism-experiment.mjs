import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteJson } from './atomic-io.mjs';
import { IMAGE_EXPERIMENT, imageMeasurementsSupported, checkedImageMeasurements } from './mechanism-image-cases.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const running = new Map();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reportFile = ws => path.join(ws, '记忆', '做梦', 'mechanism-image-identity.json');
const sources = ['engine/mechanism-experiment.mjs', 'engine/mechanism-image-cases.mjs',
  'scripts/run-image-mechanism.mjs', 'frontend/src/lib/image-identity.ts', 'frontend/src/lib/media-embed.ts'];
function fingerprint() { return hash(sources.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')])); }
function readStore(ws) {
  try {
    const file = reportFile(ws);
    if (fs.statSync(file).size > 512 * 1024) return { invalid: true, reports: [] };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.schema !== 1 || !Array.isArray(value.reports) || !value.reports.length) throw new Error('schema');
    return value;
  } catch (e) { return { invalid: e.code !== 'ENOENT', reports: [] }; }
}
function validReport(report) {
  if (!report || typeof report !== 'object') return false;
  const { contentDigest, ...payload } = report;
  return contentDigest === hash(payload) && report.experimentId === IMAGE_EXPERIMENT.id
    && report.definition?.id === report.experimentId
    && Object.keys(IMAGE_EXPERIMENT).every(key => typeof report.definition[key] === 'string')
    && typeof report.id === 'string' && typeof report.at === 'string' && Array.isArray(report.cases);
}

export function mechanismStatus(wsRoot) {
  const store = readStore(wsRoot);
  const latest = store.reports.at(-1);
  let state = store.invalid ? 'invalid' : 'untested';
  if (latest) {
    if (!validReport(latest)) state = 'invalid';
    else {
      let current;
      try { current = fingerprint(); } catch { /* Missing source also invalidates old evidence. */ }
      state = latest.sourceFingerprint !== current ? 'stale'
        : hash(latest.definition) !== hash(IMAGE_EXPERIMENT) ? 'invalid' : latest.error ? 'error'
        : imageMeasurementsSupported(latest.cases) ? 'supported' : 'not-supported';
    }
  }
  const usable = validReport(latest) && state !== 'invalid';
  return { definition: usable ? latest.definition : IMAGE_EXPERIMENT, state, running: running.has(path.resolve(wsRoot)),
    evidenceKind: 'synthetic-fixtures', promotionEligible: false, independentTaskCount: 0,
    latest: usable ? { ...latest, cases: state === 'stale' ? latest.cases
      : latest.cases.length ? checkedImageMeasurements(latest.cases) : [] } : null,
    recentRuns: store.reports.filter(validReport).slice(-10).map(r => ({ id: r.id, at: r.at })),
    governance: '实验仅记录观察结果，不写回策略；真实任务验收、人工审批与回滚仍按原有流程执行。' };
}

export function runMechanismExperiment(wsRoot) {
  const ws = path.resolve(wsRoot);
  if (running.has(ws)) return running.get(ws);
  const pending = run(ws).finally(() => running.delete(ws));
  running.set(ws, pending);
  return pending;
}
async function run(ws) {
  const sourceFingerprint = fingerprint();
  const report = { id: randomUUID(), experimentId: IMAGE_EXPERIMENT.id, at: new Date().toISOString(),
    definition: structuredClone(IMAGE_EXPERIMENT),
    sourceFingerprint, sourceVersion: JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8')).version,
    cases: [], error: null };
  try {
    const { stdout } = await execute(process.execPath, ['--experimental-strip-types', path.join(root, 'scripts/run-image-mechanism.mjs')],
      { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 });
    report.cases = JSON.parse(stdout).cases;
    if (!Array.isArray(report.cases)) throw new Error('实验结果格式不正确');
    if (fingerprint() !== sourceFingerprint) throw new Error('执行期间代码发生变化，请重新实验');
  } catch (e) {
    report.cases = [];
    // Do not persist raw stderr, command text or local environment values.
    report.error = e.killed ? '实验超过 15 秒，已终止' : '实验执行失败或代码变动，请检查运行环境后重试';
  }
  report.contentDigest = hash(report);
  const previous = readStore(ws).reports.filter(validReport).slice(-9);
  atomicWriteJson(reportFile(ws), { schema: 1, reports: [...previous, report] });
  return { ...mechanismStatus(ws), running: false };
}
