// 只读研究员（2026-10-05）：子智能体能自己 read/list/grep/web_search，但写不了、跑不了、看不到凭据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createResearchExecutor, resolveInRoots, RESEARCH_TOOL_NAMES, RESEARCH_MAX_STEPS } from '../../engine/subagent-research.mjs';
import { initSubagent, spawnSubagent } from '../../engine/subagent.mjs';
import { execDelegateTask } from '../../engine/yuanshu-delegate.mjs';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-research-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.mjs'), 'export const alpha = 1\n// TODO find-me\nconst k = "sk-abcdefghijklmnopqrstuvwxyz0123456789"\n');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'x.js'), '// TODO find-me in deps\n');
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=should-never-be-read\n');
  await fs.writeFile(path.join(root, 'big.txt'), Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n'));
  return root;
}

test('toolset is read-only: exactly read/list/grep/web_search, no write/bash/delegate', () => {
  assert.deepEqual(RESEARCH_TOOL_NAMES.sort(), ['grep', 'list', 'read', 'web_search']);
  assert.ok(RESEARCH_MAX_STEPS > 0 && RESEARCH_MAX_STEPS <= 12);
});

test('read/list/grep stay inside roots, skip deps and credentials, redact secrets', async t => {
  const root = await workspace(t);
  const exec = createResearchExecutor({ roots: () => [root] });
  const read = await exec('read', { path: 'src/a.mjs' });
  assert.equal(read.isError, undefined);
  assert.match(read.text, /1: export const alpha = 1/);
  assert.doesNotMatch(read.text, /sk-abcdefghijklmnopqrstuvwxyz0123456789/, 'secret must be redacted');

  assert.equal((await exec('read', { path: '.env' })).isError, true, 'credential files are invisible');
  assert.equal((await exec('read', { path: '../outside.txt' })).isError, true, 'no escaping roots');
  assert.equal((await exec('read', { path: path.join(os.homedir(), '.ssh', 'id_rsa') })).isError, true);

  const listing = await exec('list', { path: '.' });
  assert.match(listing.text, /src\//);
  assert.doesNotMatch(listing.text, /\.env/);

  const grep = await exec('grep', { pattern: 'find-me' });
  assert.match(grep.text, /src\/a\.mjs:2:/);
  assert.doesNotMatch(grep.text, /node_modules/);

  const paged = await exec('read', { path: 'big.txt', offset: 100, limit: 5000 });
  assert.match(paged.text, /^100: line 100/);
  assert.match(paged.text, /offset=500/, 'reads are capped at 400 lines with a continuation hint');

  assert.equal((await exec('write', { path: 'x', content: 'y' })).isError, true);
  assert.equal((await exec('bash', { command: 'echo' })).isError, true);
  assert.equal((await exec('web_search', { query: 'q' })).isError, true, 'web search reports missing wiring instead of pretending');
  assert.equal(resolveInRoots([root], 'src/a.mjs'), path.join(root, 'src', 'a.mjs'));
});

function chatResponse(message, finish = 'stop') {
  return { ok: true, status: 200, json: async () => ({ model: 'served', choices: [{ finish_reason: finish, message }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) };
}

test('research profile runs a bounded tool loop and returns evidence; events show each lookup', async t => {
  const root = await workspace(t);
  const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-research-trace-'));
  t.after(() => fs.rm(traceDir, { recursive: true, force: true }));
  const model = { provider: 'fixture', id: 'm', api: 'openai-completions', maxTokens: 4000, contextWindow: 64000, baseUrl: 'https://fixture.invalid/v1' };
  const requests = [];
  initSubagent({ traceDir, getFlashModel: () => model, getDefaultModel: () => model,
    authReader: () => ({ fixture: { key: 'k' } }), modelReader: () => ({ fixture: { models: [model] } }),
    researchRoots: () => [root],
    httpFetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      requests.push(body);
      if (requests.length === 1) return chatResponse({ content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'find-me' }) } },
        { id: 'c2', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'src/a.mjs' }) } },
      ] }, 'tool_calls');
      return chatResponse({ content: JSON.stringify({ result: 'alpha 定义在 src/a.mjs', evidence: ['src/a.mjs:1'], confidence: 0.9 }) });
    },
  });
  const events = [];
  const r = await execDelegateTask({ task: '找 alpha 在哪定义' }, { onEvent: (type, data) => events.push([type, data]) });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /src\/a\.mjs:1/);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools.map(x => x.function.name).sort(), ['grep', 'list', 'read', 'web_search']);
  const toolMsgs = requests[1].messages.filter(m => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.match(toolMsgs.find(m => m.tool_call_id === 'c1').content, /src\/a\.mjs:2/);
  const lookups = events.filter(([type]) => type === 'subagent_tool').map(([, d]) => d.tool).sort();
  assert.deepEqual(lookups, ['grep', 'read']);
  assert.ok(events.some(([type]) => type === 'subagent_started') && events.some(([type]) => type === 'subagent_finished'));
});

test('a model that never stops calling tools is forced to conclude after the step cap', async t => {
  const root = await workspace(t);
  const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-research-trace-'));
  t.after(() => fs.rm(traceDir, { recursive: true, force: true }));
  const model = { provider: 'fixture', id: 'm', api: 'openai-completions', maxTokens: 4000, contextWindow: 64000, baseUrl: 'https://fixture.invalid/v1' };
  const requests = [];
  initSubagent({ traceDir, getFlashModel: () => model, getDefaultModel: () => model,
    authReader: () => ({ fixture: { key: 'k' } }), modelReader: () => ({ fixture: { models: [model] } }),
    researchRoots: () => [root],
    httpFetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      requests.push(body);
      if (body.tools) return chatResponse({ content: '', tool_calls: [{ id: `c${requests.length}`, type: 'function', function: { name: 'list', arguments: '{}' } }] }, 'tool_calls');
      return chatResponse({ content: JSON.stringify({ result: '轮次用完，基于已有证据收尾', evidence: [], confidence: 0.4 }) });
    },
  });
  const r = await spawnSubagent({ task: '无限查', profile: 'research' });
  assert.equal(r.done, true, r.error);
  assert.equal(requests.length, RESEARCH_MAX_STEPS + 1);
  assert.equal(requests.at(-1).tools, undefined, 'final step has no tools');
});

test('analysis profile (team / plain spawn) still makes one tool-free call', async t => {
  const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-research-trace-'));
  t.after(() => fs.rm(traceDir, { recursive: true, force: true }));
  const model = { provider: 'fixture', id: 'm', api: 'openai-completions', maxTokens: 4000, contextWindow: 64000, baseUrl: 'https://fixture.invalid/v1' };
  const requests = [];
  initSubagent({ traceDir, getFlashModel: () => model, getDefaultModel: () => model,
    authReader: () => ({ fixture: { key: 'k' } }), modelReader: () => ({ fixture: { models: [model] } }),
    researchRoots: () => [os.tmpdir()],
    httpFetch: async (url, opts) => { requests.push(JSON.parse(opts.body)); return chatResponse({ content: JSON.stringify({ result: 'ok', evidence: [], confidence: 1 }) }); },
  });
  const r = await spawnSubagent({ task: '纯分析' });
  assert.equal(r.done, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools, undefined);
});
