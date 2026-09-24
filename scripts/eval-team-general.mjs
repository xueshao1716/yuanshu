// Explicit paid acceptance exercise. All run/evidence/history writes are isolated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadLiveEvalModel } from './live-eval-model.mjs';

if (!process.argv.includes('--live')) throw new Error('真实模型会产生费用；显式传入 --live 执行');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-live-'));
process.env.YUANSHU_CWD = wsRoot;
process.env.PI_WEB_CWD = wsRoot;
// Engine modules may capture workspace paths at import time. Isolate first.
const { defaultFallbackAgentDir } = await import('../engine/pi-compat-fallback.mjs');
const { httpJsonFetch } = await import('../engine/http.mjs');
const { initSubagent, getSubagentHistory } = await import('../engine/subagent.mjs');
const { createGeneralTeamChat } = await import('../engine/team-general-chat.mjs');
const { createRunStore } = await import('../engine/run-store.mjs');
const { createRunEventLog } = await import('../engine/run-event-log.mjs');
const { createRunManager } = await import('../engine/run-manager.mjs');
const { createAIBodyRuntime } = await import('../engine/aibody-runtime.mjs');
const { createAIBodyHost } = await import('../engine/aibody-host.mjs');
const { createTaskEvidence } = await import('../engine/task-evidence.mjs');
const model = await loadLiveEvalModel({
  tokenFile: process.env.YUANSHU_EVAL_TOKEN_FILE || path.join(repo, '.token'),
  requestedModel: process.env.YUANSHU_TEAM_EVAL_MODEL,
});
const agentDir = defaultFallbackAgentDir();
const read = name => JSON.parse(fs.readFileSync(path.join(agentDir, name), 'utf8'));
const rootDir = path.join(wsRoot, 'runtime');
const modelResponses = [];
const observedFetch = async (...args) => {
  const request = JSON.parse(args[1].body);
  const response = await httpJsonFetch(...args);
  return { ...response, json: async () => {
    const data = await response.json();
    const fact = { event: 'model_response', requestedModel: request.model, upstreamModel: data.model || null, requestedEffort: request.reasoning_effort,
      maxTokens: request.max_tokens ?? request.max_completion_tokens, finishReason: data.choices?.[0]?.finish_reason,
      completionTokens: data.usage?.completion_tokens, reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
      contentChars: data.choices?.[0]?.message?.content?.length || 0 };
    modelResponses.push(fact);
    console.log(JSON.stringify(fact));
    return data;
  } };
};
initSubagent({ httpFetch: observedFetch, authReader: () => read('auth.json'), modelReader: () => read('models-store.json'),
  resolveAuth: p => ({ baseUrl: read('auth.json')[p]?.baseUrl }), getDefaultModel: () => model, traceDir: path.join(wsRoot, 'children') });
const runtime = createAIBodyRuntime({ rootDir: path.join(wsRoot, 'aibody'), readState: () => ({}) });
const entry = { busy: false, sm: { fileEntries: [], appendMessage(message) { this.fileEntries.push({ message }); } } };
const store = createRunStore({ rootDir }), eventLog = createRunEventLog({ rootDir });
const manager = createRunManager({ store, eventLog, instanceId: 'real-model-acceptance', executeChat: createGeneralTeamChat({ wsRoot,
  getModel: () => model, openSession: async () => entry, readMessages: e => e.sm.fileEntries.map(x => x.message), aibodyHost: createAIBodyHost(runtime) }) });
const task = '我要做一个探店账号，之前给我的“地铁线吃到底、带我妈探店、50块吃垮一条街”太空泛。请天团做一份能直接拍的低成本试播方案，直接给前3期脚本、标题和开头3秒钩子、逐镜时间与口播、拍摄清单、预算上限和验证办法。已知：新账号、一个人用手机拍、不请家人出镜、每期餐费不超过50元、剪辑不超过2小时；城市店名和实际价格未知，不要编造。别做角色表演，别让我选完再问要不要继续。总稿控制在3000汉字以内。';
const started = Date.now();
const run = manager.create({ sessionId: 'isolated-restaurant', clientRequestId: 'restaurant-acceptance', workflow: 'team-general', message: task });
console.log(JSON.stringify({ wsRoot, runId: run.id, model: `${model.provider}/${model.id}` }));
manager.subscribe(run.id, e => { if (['subagent_started', 'subagent_finished', 'failed', 'completed'].includes(e.type))
  console.log(JSON.stringify({ event: e.type, child: e.data?.id, role: e.data?.role, stage: e.data?.task?.split('：')[0], status: e.data?.status, error: e.data?.error })); });
let result;
while (Date.now() - started < 19 * 60_000) {
  result = manager.get(run.id);
  if (['completed', 'failed', 'stopped'].includes(result.status)) break;
  await delay(500);
}
if (!['completed', 'failed', 'stopped'].includes(result.status)) { manager.stop(run.id); throw new Error('验收超时，已请求停止'); }
const evidence = createTaskEvidence({ wsRoot, rootDir }).get(run.id);
const children = await getSubagentHistory({ runId: run.id });
const report = { model: `${model.provider}/${model.id}`, wsRoot, runId: run.id, status: result.status,
  modelResponses,
  error: result.error, elapsedMs: Date.now() - started, children: children.map(c => ({ id: c.runId, role: c.role, status: c.status, model: c.model,
    elapsedMs: Date.parse(c.endedAt) - Date.parse(c.startedAt) })),
  artifact: evidence.artifacts[0]?.path, reviewable: evidence.reviewable, issues: evidence.issues,
  assistantMessages: entry.sm.fileEntries.filter(e => e.message.role === 'assistant').length,
  aibody: { status: runtime.getRun(run.id)?.status, children: runtime.getRun(run.id)?.evidence?.subagents }, humanAccepted: false };
fs.mkdirSync(path.join(repo, 'tmp'), { recursive: true });
report.reportFile = `tmp/team-general-live-${run.id}.json`;
fs.writeFileSync(path.join(repo, report.reportFile), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(repo, 'tmp/team-general-live-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
eventLog.close();
process.exitCode = result.status === 'completed' && evidence.reviewable && report.assistantMessages === 1 ? 0 : 1;
