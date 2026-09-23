// Opt-in live acceptance: synthetic context, bounded calls, no production tools/files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultFallbackAgentDir } from '../engine/pi-compat-fallback.mjs';
import { initDshKeys } from '../engine/dsh-keys.mjs';
import { initUnifiedChat, unifiedChat } from '../engine/unified-chat.mjs';

const dir = defaultFallbackAgentDir();
const authPath = path.join(dir, 'auth.json'), modelsPath = path.join(dir, 'models-store.json');
const readJsonFile = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const store = readJsonFile(modelsPath);
const definition = store['stepfun-plan']?.models?.find(m => m.id === 'step-5-preview');
if (!definition) throw new Error('step-5-preview configuration missing');
const model = { ...definition, provider: 'stepfun-plan' };
const fixture = { token: `验收-${randomUUID().slice(0, 8)}`, prices: [19, 27, 34], discount: 12 };
const toolsRun = [];
const tools = [
  { name: 'read_fixture', description: 'Read the private test invoice. No other way to know its token.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'verify_total', description: 'Verify a computed total and token from read_fixture.', parameters: { type: 'object', properties: { total: { type: 'number' }, token: { type: 'string' } }, required: ['total', 'token'], additionalProperties: false } },
];
initDshKeys({ authPath, modelsPath, readJsonFile });
initUnifiedChat({ authPath, modelsPath, readJsonFile, getModelList: () => [model], UNIFIED_TOOLS: tools, executeUnifiedTool: async (name, args) => {
  toolsRun.push({ name, args });
  if (name === 'read_fixture') return { text: JSON.stringify(fixture) };
  if (name === 'verify_total') return { text: JSON.stringify({ verified: args.total === 68 && args.token === fixture.token }), isError: !(args.total === 68 && args.token === fixture.token) };
  return { text: 'Unknown test tool', isError: true };
} });
const rounds = [], history = [{ role: 'system', content: '你是元枢。只使用本次提供的信息和工具。不要虚构工具结果。用中文简短回答。' }];
async function turn(prompt, opts = {}) {
  history.push({ role: 'user', content: prompt });
  const started = Date.now(); const deltas = [], thinks = [];
  const result = await unifiedChat(model, history, { maxTurns: 5, ...opts, signal: AbortSignal.timeout(90000), onDelta: t => deltas.push(t), onThink: t => thinks.push(t) });
  rounds.push({ elapsedMs: Date.now() - started, error: result.error, aborted: result.aborted, model: result.usedModel, text: result.text, streamedChars: deltas.join('').length, thinkingChars: thinks.join('').length });
  if (result.error || result.aborted) return false;
  if (result.history) { history.length = 0; history.push(...result.history); }
  history.push({ role: 'assistant', content: result.text });
  return true;
}
let completed = false;
try {
  if (await turn('我们把这次项目叫青竹，预算上限是90元。请复述这两个约束。', { tools: false })) {
    if (await turn('先用read_fixture读取账单，再自己计算三项价格之和减优惠，调用verify_total核对金额和暗号。完成后告诉我实际金额、离预算还剩多少，以及项目名称。')) {
      completed = await turn('不要再调用工具。告诉我上轮账单的暗号、项目名称和核对后的金额。', { tools: false });
    }
  }
} catch (error) { rounds.push({ error: error.message }); }
const passed = completed && toolsRun.some(t => t.name === 'read_fixture') && toolsRun.some(t => t.name === 'verify_total' && t.args.total === 68 && t.args.token === fixture.token)
  && rounds[1]?.text?.includes('青竹') && rounds[1]?.text?.includes('22') && rounds[2]?.text?.includes(fixture.token) && rounds[2]?.text?.includes('68');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-step5-'));
const report = { at: new Date().toISOString(), passed, requestedModel: { provider: model.provider, id: model.id }, protocol: model.api, endpoint: `${model.baseUrl}/messages`, rounds, toolsRun };
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, reportPath: path.join(output, 'report.json') }, null, 2));
process.exitCode = passed ? 0 : 1;
