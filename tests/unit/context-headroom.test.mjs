// 真机事故回归（2026-09-18）：用户问"单次输出的模型上限是多少，怎么一直被打断"。
//
// 证据（本机会话记录，zhipu-paid/glm-5.3-flash，contextWindow=200000）：
//   14:43:59  in=108   cacheRead=195200  out=180   total=195488  stop=toolUse
//   14:44:27  in=275   cacheRead=195264  out=387   total=195926  stop=length   ← 只剩 ~400 token 可写
//   14:44:32  in=350   cacheRead=195520  out=1     total=195871  stop=length   ← 恢复重试，吐出 1 token
//   14:45:50  compaction → 上下文从 195k 掉到 57k
//
// 机制：单次输出上限 = min(模型声明的 maxTokens, 上下文窗口 − 已占用 − 安全余量)。
//   逼近窗口时第二项会掉到几百 token；模型 length 停住后 SDK 判定 isRecoverableLength
//   （输出 < 声明上限）→ 删掉半截答案、压缩、重试 —— 用户看到的就是"说到一半被打断"。
//
// 这个测试锁：数学算得对、该压缩时说得清、界面/历史里不许再静默半句话。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  outputRoomTokens, headroomCheck, usedPercent, headroomNote, lengthStopNote,
  estimateTokensFromText, estimateHistoryTokens, budgetWithinWindow,
  CONTEXT_SAFETY_TOKENS, MIN_OUTPUT_TOKENS,
} from '../../engine/context-headroom.mjs';
import { extractMessages } from '../../engine/session-utils.mjs';

test('单次输出上限 = min(模型声明, 窗口 − 已占用 − 安全余量)；不知道窗口就不瞎砍', () => {
  // 真机那一轮：195,264 已占 / 200,000 窗口 → 只剩 ~400
  const real = headroomCheck({ contextWindow: 200000, usedTokens: 195264, declaredMaxTokens: 32768 });
  assert.equal(real.room, 200000 - 195264 - CONTEXT_SAFETY_TOKENS);
  assert.ok(real.room < 1000, `真机余量就该是几百 token，实际 ${real.room}`);
  assert.equal(real.effectiveMax, real.room, '声明 32k 也没用，窗口不允许');
  assert.equal(real.tight, true);
  assert.equal(real.shouldCompact, true, '这种余量必须先压缩再跑');
  assert.equal(usedPercent(195264, 200000), 98);

  // 宽窗口的 opencode-go 模型：声明 384k、窗口 1M、才用 60k → 就该按声明的来
  const opencode = headroomCheck({ contextWindow: 1000000, usedTokens: 60000, declaredMaxTokens: 384000 });
  assert.equal(opencode.room, 1000000 - 60000 - CONTEXT_SAFETY_TOKENS);
  assert.equal(opencode.effectiveMax, 384000, '窗口够大时按模型声明');
  assert.equal(opencode.tight, false);

  // 不知道窗口 → 不限（宁可不动手，也别拿假数乱砍）
  assert.equal(outputRoomTokens({ contextWindow: 0, usedTokens: 12345 }), Infinity);
  assert.equal(headroomCheck({ contextWindow: 0, usedTokens: 12345, declaredMaxTokens: 8192 }).effectiveMax, 8192);
  // 边界：已占用超过窗口 → 余量 0，不许出现负数
  assert.equal(outputRoomTokens({ contextWindow: 1000, usedTokens: 5000 }), 0);
});

test('人话说明：压缩前后都说清"占了多少、还能写多少"，截断说明含用量与续写办法', () => {
  const tight = headroomNote({ contextWindow: 200000, usedTokens: 195264, model: 'zhipu-paid/glm-5.3-flash' });
  assert.match(tight, /上下文已占 98%/);
  assert.match(tight, /zhipu-paid\/glm-5\.3-flash/);
  assert.match(tight, /剩约 \d+ token/);
  assert.match(tight, /压缩上下文|新开一个会话/, '要告诉用户怎么办，不能只说"被截断"');

  const compressed = headroomNote({ contextWindow: 200000, usedTokens: 60000, compressed: true, model: 'm' });
  assert.match(compressed, /🧹/);
  assert.match(compressed, /压缩后本轮可输出约 \d+ token/);

  const note = lengthStopNote({ outputTokens: 387, usedTokens: 195926, contextWindow: 200000, declaredMaxTokens: 32768 });
  assert.match(note, /387 token/, '要有实际用量');
  assert.match(note, /98%/, '要说清上下文占比');
  assert.match(note, /32768/, '要说清模型声明的上限');
  assert.match(note, /接着写|压缩上下文/, '要给用户下一步');
});

test('自己的循环：输出预算不许超过窗口装得下的量（别向窗口要 32k）', () => {
  assert.equal(budgetWithinWindow({ declaredMaxTokens: 32768, contextWindow: 200000, usedTokens: 195264 }), 200000 - 195264 - CONTEXT_SAFETY_TOKENS);
  assert.equal(budgetWithinWindow({ declaredMaxTokens: 32768, contextWindow: 200000, usedTokens: 100000 }), 32768);
  assert.equal(budgetWithinWindow({ declaredMaxTokens: 0, contextWindow: 0, usedTokens: 1, fallback: 8192 }), 8192);
  // 再挤也不许给 0（给 0 等于"别说话"）：底线 512
  assert.equal(budgetWithinWindow({ declaredMaxTokens: 32768, contextWindow: 10000, usedTokens: 9999 }), 512);

  // 估算：中文≈1.5/字，其他≈0.35/字符（与 session-manager 的压缩阈值同一套系数）
  assert.equal(estimateTokensFromText('你好世界'), 6);
  assert.equal(estimateTokensFromText('abcd'), 1);
  assert.equal(estimateTokensFromText(''), 0);
  const hist = [
    { role: 'user', content: '你好世界' },
    { role: 'assistant', content: [{ type: 'text', text: 'abcd' }] },
  ];
  assert.equal(estimateHistoryTokens(hist), 7);
});

test('源码闸门：余量闸门必须真的接进主循环（别只定义不调用、也别调用却没 import）', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  // 这一条是真踩过的坑：调用写了、import 忘了，异常又被 catch 吞掉 → 闸门等于不存在（核对时才露馅）
  assert.match(server, /import \{[^}]*ensureContextHeadroom[^}]*\} from "\.\/engine\/session-manager\.mjs"/,
    'server.mjs 必须从 session-manager 导入 ensureContextHeadroom');
  assert.match(server, /await ensureContextHeadroom\(sessionId, entry, effModel\)/, '开跑前必须真的调用余量闸门');
  const mgr = fs.readFileSync(path.join(root, 'engine', 'session-manager.mjs'), 'utf8');
  assert.match(mgr, /export async function ensureContextHeadroom/, '闸门本体要在 session-manager 里');
  assert.match(mgr, /_activeSessions\.delete\(id\)/, '压缩后必须重开会话（内存里的旧树不会自己刷新）');
  // 界面侧：截断提示要能渲染出来（字段一路从后端映射到组件）
  const msg = fs.readFileSync(path.join(root, 'frontend', 'src', 'components', 'Message.tsx'), 'utf8');
  assert.match(msg, /msg\.truncated/, '截断提示必须在消息组件里渲染');
  const types = fs.readFileSync(path.join(root, 'frontend', 'src', 'types.ts'), 'utf8');
  assert.match(types, /truncated\?: string/, 'ChatMessage 要有 truncated 字段');
});

test('压缩后的占用要按"摘要 + 保留消息"重估，不许拿老 usage 冒充（否则会报出"可输出 0 token"）', async () => {
  const { estimateCompactedTokens } = await import('../../engine/session-manager.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-headroom-'));
  try {
    const file = path.join(dir, 's.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ type: 'compaction', id: 'c1', parentId: null, summary: '摘要：前面对话已完成。', firstKeptEntryId: 'u9', tokensBefore: 199200 }),
      JSON.stringify({ type: 'message', id: 'u9', parentId: 'c1', message: { role: 'user', content: [{ type: 'text', text: '最后一问' }] } }),
      JSON.stringify({ type: 'message', id: 'a9', parentId: 'u9', message: { role: 'assistant', model: 'x', usage: { totalTokens: 199200 }, content: [{ type: 'text', text: '最后一答' }] } }),
    ].join('\n') + '\n';
    fs.writeFileSync(file, lines, 'utf8');
    const est = estimateCompactedTokens(file);
    assert.ok(est > 0 && est < 200, `重估要按压缩后的内容来（几十 token 量级），实际 ${est}`);
    // 没压缩过的会话：从头估
    fs.writeFileSync(file, JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '你好世界' }] } }) + '\n', 'utf8');
    assert.equal(estimateCompactedTokens(file), 6);
    assert.equal(estimateCompactedTokens(path.join(dir, '不存在.jsonl')), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('历史里的 length 截断不许再静默：界面要拿到一段人话', () => {
  const entries = [{
    type: 'message', id: 'a1', timestamp: '2026-09-16T14:44:27.665Z',
    message: {
      role: 'assistant', stopReason: 'length', model: 'glm-5.3-flash',
      content: [{ type: 'text', text: '**三模型全绿**（glm-5.3 / kimi-k3 / grok-4.6，三' }],
      usage: { input: 275, cacheRead: 195264, output: 387, totalTokens: 195926 },
    },
  }];
  const msgs = extractMessages(entries, 'a1', { resolveWindow: (id) => (id === 'glm-5.3-flash' ? { contextWindow: 200000, maxOutputTokens: 32768 } : null) });
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].text.startsWith('**三模型全绿**'), '半截正文要留着（用户能看到写到哪）');
  assert.match(msgs[0].truncated, /387 token/);
  assert.match(msgs[0].truncated, /195926/, '要说清当时上下文多大');
  assert.match(msgs[0].truncated, /200000|200k|98%/, '查得到模型窗口就要说清占比');
  assert.equal(msgs[0].error, '', '截断不是失败，别渲染成红色错误条');
  // 查不到窗口也不许崩：只说用量
  const noWin = extractMessages(entries, 'a1')[0];
  assert.match(noWin.truncated, /387 token/);
  assert.doesNotMatch(noWin.truncated, /上下文已占/);

  // 正常结束的回复不许被标成截断
  const ok = extractMessages([{ type: 'message', id: 'a2', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '做完了' }], usage: { totalTokens: 100 } } }], 'a2');
  assert.equal(ok[0].truncated, '');
});
