// 引擎对照实验暴露的两个自研循环缺陷（2026-09-16）：
//   ① baseUrl 取值顺序错了：auth.json 那份（账号级）压过模型定义那份 → 401 "Model … is not supported"
//   ② 不发"会话亲和头"：opencode-go 缺 x-opencode-session → 400 MissingSessionID
// 这两条合起来 = 自研循环**打不动原生强模型**；而它正是 pi 失败后的降级通道，所以"元枢引擎不行"有实打实的一半。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sessionAffinityHeaders } from '../../engine/http.mjs';

test('会话亲和头：opencode-go 必须带 x-opencode-session（没有会话号也要发）', () => {
  const withSid = sessionAffinityHeaders({ provider: 'opencode-go', sessionId: 'sess-1' });
  assert.equal(withSid['x-opencode-session'], 'sess-1');
  const noSid = sessionAffinityHeaders({ provider: 'opencode-go' });
  assert.ok(noSid['x-opencode-session'], '缺会话号也要给一个（缺这条头是 400，硬失败）');
  const again = sessionAffinityHeaders({ provider: 'opencode-go' });
  assert.equal(again['x-opencode-session'], noSid['x-opencode-session'], '同进程内保持稳定，便于上游缓存');
});

test('会话亲和头：别家不能乱发（openrouter 用 x-session-id，deepseek 一个都不发）', () => {
  assert.equal(sessionAffinityHeaders({ provider: 'openrouter', sessionId: 's' })['x-session-id'], 's');
  assert.deepEqual(sessionAffinityHeaders({ provider: 'deepseek', sessionId: 's' }), {});
  assert.deepEqual(sessionAffinityHeaders({ provider: 'zai', sessionId: 's' }), {});
  // 模型声明了才发（compat 驱动）
  assert.equal(sessionAffinityHeaders({ provider: 'whatever', compat: { sendSessionAffinityHeaders: true }, sessionId: 's' })['x-opencode-session'], 's');
  assert.equal(sessionAffinityHeaders({ provider: 'whatever', compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' }, sessionId: 's' })['x-session-id'], 's');
});

test('baseUrl 必须"模型定义优先"（auth 那份是账号级的，端点可能不同）', () => {
  for (const f of ['engine/unified-chat.mjs', 'engine/model-adapter.mjs']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /mdef\?\.baseUrl \|\| resolved\?\.baseUrl/, `${f} 要用模型定义的 baseUrl`);
    assert.ok(!/resolved\?\.baseUrl \|\| mdef\?\.baseUrl/.test(src), `${f} 不能再用 auth 的 baseUrl 压过模型定义`);
  }
});

test('两条请求路径都要发亲和头（unifiedChat 的内联请求 + adapter）', () => {
  const uc = fs.readFileSync('engine/unified-chat.mjs', 'utf8');
  assert.match(uc, /sessionAffinityHeaders\(\{ provider: model\.provider/, 'unifiedChat 的 mkReq 要发');
  const ma = fs.readFileSync('engine/model-adapter.mjs', 'utf8');
  assert.match(ma, /sessionAffinityHeaders\(\{ provider: model\.provider/, 'adapter 的 mkReq 也要发');
  // 循环要把会话号传进来（否则退化成进程级稳定值，虽然能用但不是最优）
  assert.match(uc, /opts\.executionContext\?\.sessionId \|\| opts\.sessionId/, '循环要把真实会话号传下去');
});
