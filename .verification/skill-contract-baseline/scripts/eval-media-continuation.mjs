// Explicit, paid, isolated acceptance: real model -> image -> write -> read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadLiveEvalModel } from './live-eval-model.mjs';
import { createLiveMediaTools } from './live-eval-media-tools.mjs';

if (!process.argv.includes('--live')) throw new Error('真实模型会产生费用；必须显式传入 --live');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-media-live-'));
process.env.YUANSHU_CWD = wsRoot;
process.env.PI_WEB_CWD = wsRoot;
// Engine modules may capture workspace paths at import time. Initialize only after isolation.
const { defaultFallbackAgentDir } = await import('../engine/pi-compat-fallback.mjs');
const { initDshKeys, resolveAuth } = await import('../engine/dsh-keys.mjs');
const { unifiedChat, initUnifiedChat } = await import('../engine/unified-chat.mjs');
const { createUnifiedToolExecutorGuarded, BASE_TOOL_SCHEMAS } = await import('../engine/tools/unified-tools.mjs');
const { initMediaApi, generateMediaAsync } = await import('../engine/media-api.mjs');
const { MEDIA_TOOL_SCHEMAS, createMediaToolExecutor } = await import('../engine/media-channels.mjs');
const { initWorkspaceApi, saveArtifact } = await import('../engine/workspace-api.mjs');
const { readImageDimensions } = await import('../engine/image-dimensions.mjs');
const { createRunManager } = await import('../engine/run-manager.mjs');
const { createRunStore } = await import('../engine/run-store.mjs');
const { createRunEffects } = await import('../engine/run-effects.mjs');
const { createRunEventLog } = await import('../engine/run-event-log.mjs');
const { createRunApi } = await import('../engine/run-api.mjs');

const tokenFile = process.env.YUANSHU_EVAL_TOKEN_FILE || path.join(repo, '.token');
const model = await loadLiveEvalModel({ tokenFile, requestedModel: process.env.YUANSHU_MEDIA_EVAL_TEXT_MODEL });
const mediaModel = await loadLiveEvalModel({ tokenFile, requestedModel: 'agnes/agnes-image-2.5-flash' });
const agentDir = defaultFallbackAgentDir(), authPath = path.join(agentDir, 'auth.json');
const modelsPath = path.join(agentDir, 'models-store.json');
const readJsonFile = file => JSON.parse(fs.readFileSync(file, 'utf8'));
initDshKeys({ authPath, modelsPath, readJsonFile });
if (!resolveAuth(model.provider)?.key || !resolveAuth(mediaModel.provider)?.key)
  throw new Error('指定模型缺少凭据，未调用付费模型');
initMediaApi({ resolveAuth, readJsonFile, authPath, modelsPath, getModelList: () => [mediaModel] });
initWorkspaceApi({ wsRoot });
const imageDispatches = [];
let returnedImageVerification = null;
const mediaExecutor = createMediaToolExecutor({ getModelList: () => [mediaModel], generateMediaAsync: (intent, prompt) =>
  generateMediaAsync(intent, prompt, { onImageRequest: fact => imageDispatches.push(fact) }) });
const fileExecutor = createUnifiedToolExecutorGuarded({ cwd: () => wsRoot,
  safePath: value => path.resolve(wsRoot, value || '') === path.join(wsRoot, 'delivery.md') ? path.join(wsRoot, 'delivery.md') : null });
const marker = randomUUID();
const guard = createLiveMediaTools({ wsRoot, marker, executeFile: fileExecutor, readDimensions: readImageDimensions,
  generate: async args => {
    const result = await mediaExecutor('generate_image', args);
    if (result.isError || !result.media?.url) throw new Error('媒体生成失败，未自动重试');
    returnedImageVerification = result.media.verification || null;
    const saved = await saveArtifact({ ...result.media, prompt: args.prompt });
    if (!saved.local) throw new Error('媒体落盘失败');
    const artifactPath = new URL(saved.url, 'http://local').searchParams.get('path');
    if (!artifactPath) throw new Error('本地媒体路径无法解析');
    return { artifactPath: path.resolve(wsRoot, artifactPath) };
  } });
const tools = [...BASE_TOOL_SCHEMAS.filter(t => ['read', 'write'].includes(t.function.name)),
  ...MEDIA_TOOL_SCHEMAS.filter(t => t.function.name === 'generate_image')];
initUnifiedChat({ authPath, modelsPath, readJsonFile, cwd: wsRoot, getModelList: () => [model],
  UNIFIED_TOOLS: tools, executeUnifiedTool: guard.execute });
const rootDir = path.join(wsRoot, 'runtime');
const store = createRunStore({ rootDir }), effects = createRunEffects({ rootDir }), eventLog = createRunEventLog({ rootDir });
const observations = [], output = [], LF = String.fromCharCode(10);
const emit = (res, type, data) => res.write('event: ' + type + LF + 'data: ' + JSON.stringify(data) + LF + LF);
let detached = false, detach, executionFinished = false, timedOut = false;
const manager = createRunManager({ store, effects, eventLog, instanceId: 'isolated-live-media', workspaceScope: () => wsRoot,
  executeChat: async (req, res, body) => {
    const ctx = body.__runContext, controller = new AbortController();
    req.once('close', () => controller.abort());
    try {
      const result = await unifiedChat(model, [
        { role: 'system', content: '这是有界真实工具验收。逐个调用工具并读返回值，不模拟工具，不访问其他文件。只能生成一次图片；不能裁剪、不能重复购买。正文简短。' },
        { role: 'user', content: body.message },
      ], { signal: controller.signal, tools, maxTurns: 12, effects: ctx.effects, sandboxWsRoot: wsRoot,
        executionBudgetMs: 8 * 60_000, executionDeadlineAt: Date.now() + 8 * 60_000,
        executionContext: { runId: ctx.runId, sessionId: body.sessionId, attempt: ctx.attempt },
        onCheckpoint: cp => emit(res, 'checkpoint', cp),
        onModel: observed => observations.push({ provider: observed.provider, id: observed.id, source: 'engine_observed_not_independent_upstream_proof' }),
        onDelta: text => { output.push(text); emit(res, 'text', { text }); },
        onTool: (id, name) => {
          console.log(JSON.stringify({ event: 'tool_start', name }));
          if (name === 'generate_image' && detach) { detach(); detached = true; }
        },
        onToolEnd: (id, name, args, result) => console.log(JSON.stringify({ event: 'tool_end', name, isError: !!result?.isError })),
      });
      if (result.paused) emit(res, 'interrupted', { reason: result.pauseReason, message: result.message });
      else if (result.error) emit(res, 'error', { message: result.error });
      res.end();
    } finally { executionFinished = true; }
  } });
const task = `请先用generate_image生一张“雨后苔绿玻璃温室，植物和柔和天光，无文字”的竖版海报。工具参数size=1024x1536，aspect_ratio=2:3。只允许一次生图。收到真实结果后，再write delivery.md，包含标记${marker}、工具返回的相对图片路径、真实像素尺寸（WIDTHxHEIGHT）及图片sha256；不编造比例达标。最后read delivery.md核对完整内容，再简短汇报。不用询问，不调用其他工具，不读写其他文件。`;
const started = Date.now(), run = manager.create({ sessionId: 'isolated-media-' + marker, clientRequestId: marker,
  message: task, backgroundRecovery: false });
console.log(JSON.stringify({ runId: run.id, wsRoot, textModel: `${model.provider}/${model.id}`, mediaConfiguredModel: `${mediaModel.provider}/${mediaModel.id}` }));
const subscriber = new EventEmitter(); subscriber.headers = {};
const response = { writableEnded: false, writeHead() {}, write() { return true; }, end() { this.writableEnded = true; } };
createRunApi({ manager, json: () => { throw new Error('SSE subscribe failed'); } })
  .events(response, subscriber, new URL('http://local/events?after=0'), run.id);
detach = () => subscriber.emit('close');
try {
  while (!executionFinished && Date.now() - started < 8 * 60_000) await delay(250);
  if (!executionFinished) { timedOut = true; manager.stop(run.id); }
  const state = manager.get(run.id), checks = guard.report();
  const continuationPassed = checks.continuationPassed && state.status === 'completed' && detached && !timedOut;
  const report = { runId: run.id, wsRoot, status: state.status, error: state.error, elapsedMs: Date.now() - started,
    requestedTextModel: `${model.provider}/${model.id}`, engineObservedTextModels: observations,
    mediaConfiguredModel: `${mediaModel.provider}/${mediaModel.id}`, executionEngine: 'yuanshu/unifiedChat',
    imageDispatches, returnedImageVerification,
    scope: 'real_model_restricted_tool_loop_not_full_online_http_or_tauri',
    subscriberDetachedDuringGeneration: detached, timedOut,
    upstreamCancellationConfirmed: false, effectCount: effects.list(run.id).length,
    ...checks, continuationPassed, passed: continuationPassed && checks.dimensionsPassed,
    assistantText: output.join('') };
  fs.writeFileSync(path.join(wsRoot, 'acceptance-report.json'), JSON.stringify(report, null, 2));
  fs.mkdirSync(path.join(repo, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(repo, `tmp/media-continuation-live-${run.id}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = report.passed ? 0 : 1;
} finally { detach(); manager.dispose(); eventLog.close(); }
