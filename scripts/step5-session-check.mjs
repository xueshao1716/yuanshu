// Opt-in live acceptance through the same sessions/runs endpoints as the frontend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const base = 'http://127.0.0.1:8787';
const headers = { Authorization: `Bearer ${fs.readFileSync(new URL('../.token', import.meta.url), 'utf8').trim()}`, 'Content-Type': 'application/json' };
const out = fs.mkdtempSync('D:/pi-workspace/tmp/yuanshu-step5-session-');
const marker = `青竹-${randomUUID().slice(0, 8)}`;
const fixture = path.join(out, 'invoice.json');
fs.writeFileSync(fixture, JSON.stringify({ marker, prices: [19, 27, 34], discount: 12, budget: 90 }));
const model = { provider: 'stepfun-plan', id: 'step-5-preview' };
const rounds = [];
let session, activeRun;
async function api(route, body) {
  const response = await fetch(base + route, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `${route}: HTTP ${response.status}`);
  return response.json();
}
async function turn(message) {
  const start = Date.now();
  const created = await api('/api/runs', { sessionId: session.id, clientRequestId: randomUUID(), message, model: `${model.provider}/${model.id}` });
  activeRun = created.runId;
  let run;
  do {
    if (Date.now() - start > 180000) throw new Error('Live round timeout');
    await new Promise(resolve => setTimeout(resolve, 1500));
    run = await api(`/api/runs/${activeRun}`);
  } while (['queued', 'running', 'waiting'].includes(run.status));
  const response = await fetch(`${base}/api/runs/${activeRun}/events`, { headers, signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  let text = '';
  for (const event of events) {
    if (event.type === 'delta') text += event.data.text || '';
    if (event.type === 'response_replace') text = event.data.text || '';
  }
  const done = events.findLast(event => event.type === 'done')?.data;
  const round = { runId: activeRun, status: run.status, elapsedMs: Date.now() - start, text,
    tools: events.filter(event => event.type === 'tool').map(event => event.data.name),
    errors: events.filter(event => event.type === 'error').map(event => event.data.message),
    models: events.filter(event => ['model_used', 'model_switched', 'engine_selected'].includes(event.type)).map(event => ({ type: event.type, ...event.data })),
    done, observability: run.observability };
  rounds.push(round);
  console.log(JSON.stringify(round));
  assert.equal(run.status, 'completed');
  assert.deepEqual(done?.model, model);
  assert.deepEqual(done?.requestedModel, model);
  activeRun = null;
  return round;
}
let passed = false, error;
try {
  session = await api('/api/sessions', { name: `Step5 协议验收 ${marker}` });
  await turn('这是一次独立验收，不写长期记忆，不用天团。本次项目名为青竹，预算90元。请简短复述这两个约束，下一轮继续处理账单。');
  const bill = await turn(`先用read工具读取 ${fixture.replaceAll('\\', '/')}，然后用bash运行只读计算命令，计算三项价格合计减优惠以及预算余额。只允许读取该验收文件和做算术，不修改文件、不联网。用实际工具结果告诉我项目名、账单暗号、实付金额和余额。`);
  assert.ok(bill.tools.includes('read') && bill.tools.includes('bash'), 'Both real tools executed');
  assert.ok(bill.text.includes(marker) && bill.text.includes('68') && bill.text.includes('22'), 'Invoice facts and arithmetic');
  const recall = await turn('不要再调用任何工具。只用上文告诉我项目名、账单暗号、实付金额和预算余额。');
  assert.ok(recall.text.includes(marker) && recall.text.includes('68') && recall.text.includes('22'), 'Multi-turn recall');
  assert.equal(recall.tools.length, 0);
  const saved = await api(`/api/sessions/${session.id}/messages?tail=0`);
  const last = saved.messages.findLast(message => message.role === 'assistant' && message.text);
  assert.deepEqual(last.model, model, 'Persisted actual model');
  assert.deepEqual(last.requestedModel, model, 'Persisted requested model');
  assert.equal(last.engine, 'yuanshu');
  passed = true;
} catch (failure) {
  error = failure.message;
  if (activeRun) await api(`/api/runs/${activeRun}/stop`, {}).catch(() => {});
} finally {
  const report = { at: new Date().toISOString(), passed, error, sessionId: session?.id, fixture, marker, rounds };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed, error, sessionId: session?.id, report: path.join(out, 'report.json') }));
  process.exitCode = passed ? 0 : 1;
}
