// 单次输出预算（2026-09-16）。
//
// 真机现象：「经常报任务太长，让拆分」。
// 根因：模型声明 32k~384k 输出，而 unified-chat 与 model-adapter 都写死
//   max_tokens = Math.min(mdef?.maxTokens || 8192, 8192)
// 于是"一次写完一个大文件/长脚本"必然在 8192 处被砍断，工具调用参数成了半个 JSON，
// 守卫判定 truncated，重试两次后回一句「请把任务拆小再试」——把锅甩给用户。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  clampOutputTokens, escalateOutputTokens, maxTokensFieldOf,
  OUTPUT_TOKEN_FALLBACK, OUTPUT_TOKEN_CEILING,
} from '../../engine/output-budget.mjs';

test('起步预算：按模型声明给，但有保险丝；没声明才用 8192', () => {
  assert.equal(clampOutputTokens({ maxTokens: 384000 }), OUTPUT_TOKEN_CEILING, '384k 的声明不能原样发出去');
  assert.equal(clampOutputTokens({ maxTokens: 32768 }), 32768);
  assert.equal(clampOutputTokens({ maxTokens: 4096 }), 4096, '声明比保险丝小就用声明的');
  assert.equal(clampOutputTokens({}), OUTPUT_TOKEN_FALLBACK);
  assert.equal(clampOutputTokens({ maxTokens: 0 }), OUTPUT_TOKEN_FALLBACK);
  assert.equal(clampOutputTokens(null), OUTPUT_TOKEN_FALLBACK);
});

test('命中截断就抬预算：翻倍但不超模型声明', () => {
  assert.equal(escalateOutputTokens(8192, { maxTokens: 384000 }), 16384);
  assert.equal(escalateOutputTokens(32768, { maxTokens: 384000 }), 65536, '还能继续抬（离 384k 远着）');
  assert.equal(escalateOutputTokens(65536, { maxTokens: 100000 }), 100000, '抬到模型声明的上限为止');
  assert.equal(escalateOutputTokens(32768, { maxTokens: 32768 }), 32768, '已经到顶就不动');
  assert.equal(escalateOutputTokens(8192, {}), 16384, '没声明就按硬上限走');
  // 单调不减，且永远 >= 当前值
  let v = 8192
  for (let i = 0; i < 6; i++) { const n = escalateOutputTokens(v, { maxTokens: 384000 }); assert.ok(n >= v); v = n }
  assert.ok(v >= 8192);
});

test('字段名走 compat：有的通道要 max_completion_tokens', () => {
  assert.equal(maxTokensFieldOf({}), 'max_tokens');
  assert.equal(maxTokensFieldOf({ maxTokensField: 'max_tokens' }), 'max_tokens');
  assert.equal(maxTokensFieldOf({ maxTokensField: 'max_completion_tokens' }), 'max_completion_tokens');
  assert.equal(maxTokensFieldOf(null), 'max_tokens');
});

test('两条请求路径都必须用预算模块，不能再用写死的 8192（源码契约）', () => {
  for (const f of ['engine/unified-chat.mjs', 'engine/model-adapter.mjs']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /clampOutputTokens/, `${f} 要用预算模块`);
    assert.ok(!/Math\.min\(mdef\?\.maxTokens \|\| (opts\.maxTokens \|\| )?8192, 8192\)/.test(src), `${f} 不许再写死 8192`);
  }
  const uc = fs.readFileSync('engine/unified-chat.mjs', 'utf8');
  assert.match(uc, /escalateOutputTokens\(outputBudget, mdef\)/, '截断时要自动抬预算再重试');
  assert.match(uc, /maxTokensFieldOf\(compat\)/, '字段名要走 compat');
  const st = fs.readFileSync('engine/yuanshu-stability.mjs', 'utf8');
  assert.ok(!/请把任务拆小再试/.test(st), '不再把锅甩给用户');
  assert.match(st, /已自动把输出上限抬到模型允许的最大值重试过/, '新文案要说清"系统已经试过什么"');
});
