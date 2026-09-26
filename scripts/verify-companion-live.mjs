// Explicit opt-in: three bounded paid text calls, fictional context, temporary store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { initModelClient, directChat } from '../engine/model-client.mjs';
import { createCompanionDecision } from '../engine/companion-decision.mjs';
import { createCompanionStore } from '../engine/companion-store.mjs';
if (!process.argv.includes('--allow-live')) throw new Error('Live calls require --allow-live');
const modelKey = process.argv.find(v => v.startsWith('--model='))?.slice(8) || 'stepfun-plan/step-3.7-flash';
const slash = modelKey.indexOf('/');
const provider = modelKey.slice(0, slash), id = modelKey.slice(slash + 1);
const config = path.join(os.homedir(), '.pi', 'agent');
const modelsPath = path.join(config, 'models-store.json'), authPath = path.join(config, 'auth.json');
const readJsonFile = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const definition = readJsonFile(modelsPath)[provider]?.models?.find(m => m.id === id);
assert.ok(definition, 'Explicit model must already be configured');
const model = { ...definition, provider, id };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-companion-live-'));
initModelClient({ modelsPath, authPath, readJsonFile, getModelList: () => [model] });
let clock = Date.now();
const facts = { sessionId: 'isolated-companion-eval', serverEpoch: 'eval', revision: 'busy-1',
  known: true, currentBusy: true, reading: false, otherBusy: 0, evidenceIds: ['test-run-1'] };
const calls = [];
const service = createCompanionDecision({ store: createCompanionStore({ root, now: () => clock }), now: () => clock,
  facts: { read: () => ({ ...facts }) }, emotion: { read: () => ({ state: null }) },
  readSession: () => ({ model, revision: facts.revision, messages: [{ role: 'user', content: '这是隔离验收会话，请依据运行事实回应。' }] }),
  callModel: async (...args) => {
    const began = Date.now();
    try { const result = await directChat(...args); calls.push({ elapsedMs: Date.now() - began, actualModel: result?.usedModel,
      truncated: !!result?.truncated, textLength: result?.text?.length || 0, reasoningLength: result?.think?.length || 0,
      finishReason: result?.finishReason, outputBudget: result?.outputBudget,
      // This script uses only fictional context, and this diagnostic is explicitly opt-in.
      ...(process.argv.includes('--inspect-output') ? { output: result?.text } : {}) }); return result; }
    catch { calls.push({ elapsedMs: Date.now() - began, transportFailed: true }); throw new Error('transport_failed'); }
  },
});
const results = [];
try {
  for (const [index, busy] of [true, false, true].entries()) {
    clock += 3000; facts.currentBusy = busy; facts.revision = `phase-${index}`;
    facts.evidenceIds = busy ? [`test-run-${index}`] : [];
    const response = await service.decide({ sessionId: facts.sessionId, contextEpoch: 'eval-view',
      interactionId: `eval-${index}`, trigger: 'rest', text: '现在休息一下好吗？', visible: true });
    const passed = response.status === 'ok' && (busy ? response.decision.action === 'working' : response.decision.action === 'resting');
    results.push({ phase: index, busy, status: response.status, action: response.decision?.action,
      actualModel: response.decision?.actualModel, passed });
  }
  const report = { requestedModel: modelKey, isolated: true, realSessionAccess: false, calls, results,
    passed: results.every(r => r.passed), recordedAt: new Date().toISOString() };
  fs.mkdirSync(new URL('../tmp/', import.meta.url), { recursive: true });
  const reportName = `companion-live-${modelKey.replace(/[^a-z0-9-]/gi, '_')}.json`;
  fs.writeFileSync(new URL('../tmp/' + reportName, import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  // Only this invocation's freshly created temp directory is removed.
  fs.rmSync(root, { recursive: true, force: true });
}
