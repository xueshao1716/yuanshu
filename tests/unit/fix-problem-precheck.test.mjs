// fix_problem 的前置判断（2026-11-08）。
//
// 真事故：伙伴让"核实截图里微信搜索是否搜到某人"，模型把它包装成 fix_problem 调用。
// 这个工具不是"看一眼图"，而是派一个完整执行轮（带工具、进工作目录）。
// 那个目录里的探测脚本本身 import 就崩 → 命令连续失败 → 交付门一直 RED → 一轮轮重试。
//
// 这组测试钉住三件事：
//   ① 观察类问题在派轮之前就拒绝，并说清替代做法（直接读图/截图后回答）
//   ② 同一会话、同一问题 10 分钟内两次 RED 后不再重试，并把上次卡点说出来
//   ③ RED 不是一句"不能交付"，而要带失败命令数与未覆盖文件
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  runOnTheSpotFix, classifyObservationTask, takeOnTheSpotBudget, ON_THE_SPOT_WINDOW_MS,
} from '../../engine/reflection-exec.mjs';

const fakeTurn = (reply) => async (prompt = '') =>
  (/独立验证者/.test(prompt)
    ? '```json\n{"verdict":"PASS","evidence":"ls -l 看到文件存在，cat 内容与声明一致","checks":["ls -l","cat"]}\n```'
    : reply);
const doneReply = `修好了\n\`\`\`json\n{"status":"done","evidence":"node --test tests/unit/x.test.mjs → pass 12/12","files":["tests/unit/x.test.mjs"],"summary":"补了守卫"}\n\`\`\``;
const failedReply = '```json\n{"status":"failed","evidence":"npm test 崩在 import","files":[],"summary":"没修成"}\n```';

const redGate = {
  verdict: 'RED',
  failedChecks: [{}, {}, {}],
  failedCommands: [
    { command: 'node _e2e2.mjs', output: 'SyntaxError: Cannot use import statement outside a module' },
    { command: 'node _listwins.mjs', output: 'Error: spawn ENOENT' },
    { command: 'pwsh test-window.ps1', output: '无法加载文件：没有数字签名' },
  ],
  failedCount: 3,
  uncovered: ['D:/pi-workspace/工程/桌面代理/_e2e2.mjs', 'D:/pi-workspace/工程/桌面代理/test-window.ps1'],
  uncoveredTotal: 2,
  summary: '不能交付：3 次命令执行失败；2 个改动文件没被验证覆盖\n失败命令（共 3 次，前 3 条）：\n1. node _e2e2.mjs → SyntaxError: Cannot use import statement outside a module\n未覆盖文件（共 2 个，前 2 个）：D:/pi-workspace/工程/桌面代理/_e2e2.mjs、D:/pi-workspace/工程/桌面代理/test-window.ps1',
};

test('观察类文本被认出来（看看/核实/确认 + 是否/截图里/图里）', () => {
  for (const text of [
    '核实截图里微信搜索是否搜到某人',
    '看看这张图里写的是什么',
    '确认一下截图里那个按钮是不是可点',
    '检查图里有没有那个人的头像',
    '这张截图里是什么界面',
  ]) {
    const c = classifyObservationTask(text);
    assert.equal(c.observational, true, `${text} 应判为观察类`);
    assert.ok(c.matched, '要能说出命中了哪种模式，便于解释为什么拒');
  }
  for (const text of [
    '给 abort 用例的 bash 路径加引号',
    '把那个配置项改对',
    '修复截图里发现的错别字',
    '核实这些文件是否一致，不一致就改掉',
    '补一条回归测试',
  ]) {
    assert.equal(classifyObservationTask(text).observational, false, `${text} 是能动手修的，不该误伤`);
  }
});

test('观察类问题不派轮：直接拒绝，并给出替代做法', async () => {
  for (const problem of ['核实截图里微信搜索是否搜到某人', '看看这张图里写的是什么']) {
    let turns = 0;
    const store = new Map();
    const out = await runOnTheSpotFix({
      problem,
      store,
      redStore: new Map(),
      runTurn: async () => { turns += 1; return doneReply },
    });
    assert.equal(out.ok, false);
    assert.equal(out.refused, true);
    assert.equal(out.reason, '这类是观察任务，不走当场修');
    assert.match(out.text, /直接看|看图|读图/, '要告诉模型正确做法是直接看图回答');
    assert.equal(turns, 0, '拒绝必须发生在派轮之前');
    // 拒绝不消耗当场修预算
    assert.equal(takeOnTheSpotBudget('anon', { store }).used, 1);
  }
});

test('正常可修的问题仍然放行（注入假执行器）', async () => {
  let asked = '';
  const out = await runOnTheSpotFix({
    problem: '给 abort 用例的 bash 路径加引号',
    store: new Map(),
    redStore: new Map(),
    runTurn: async (prompt) => { if (!/独立验证者/.test(prompt)) asked = prompt; return fakeTurn(doneReply)(prompt) },
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'done');
  assert.match(asked, /给 abort 用例的 bash 路径加引号/);
});

test('同一会话同一问题 10 分钟内两次 RED → 拒绝重试，并说清上次卡点', async () => {
  const store = new Map();
  const redStore = new Map();
  const now = Date.now();
  let turns = 0;
  // 执行轮与验证轮都按失败处理；每次失败时交付门都是 RED
  const runTurn = async () => { turns += 1; return failedReply };

  const first = await runOnTheSpotFix({
    problem: '修桌面代理目录里跑不起来的探测脚本', sessionKey: 's1', now, store, redStore,
    runTurn, deliveryCheck: () => redGate,
  });
  assert.equal(first.ok, false);
  // ③ RED 要说清为什么：失败命令数与未覆盖文件都要带出来
  assert.match(first.text, /3 次命令执行失败/);
  assert.match(first.text, /未覆盖|_e2e2\.mjs|test-window\.ps1/);
  assert.equal(first.red?.verdict, 'RED');
  assert.equal(first.red?.failedCount, 3);
  assert.equal(first.red?.failedCommands?.length, 3);

  const second = await runOnTheSpotFix({
    problem: '修桌面代理目录里跑不起来的探测脚本', sessionKey: 's1', now, store, redStore,
    runTurn, deliveryCheck: () => redGate,
  });
  assert.equal(second.ok, false);
  const turnsAfterTwo = turns;

  const third = await runOnTheSpotFix({
    problem: '修桌面代理目录里跑不起来的探测脚本', sessionKey: 's1', now, store, redStore,
    runTurn, deliveryCheck: () => redGate,
  });
  assert.equal(third.ok, false);
  assert.equal(third.refused, true);
  assert.match(third.reason, /不再重试/);
  assert.match(third.text, /上一轮 3 次命令执行失败/);
  assert.match(third.text, /先修环境或换目录/);
  assert.equal(turns, turnsAfterTwo, '两次失败之后不许再派第三轮');
});

test('换一个会话/换一条问题不受重复 RED 影响；过了 10 分钟窗口也恢复', async () => {
  const store = new Map();
  const redStore = new Map();
  const now = Date.now();
  const runTurn = async () => failedReply;
  for (let i = 0; i < 2; i++) {
    await runOnTheSpotFix({ problem: '修桌面代理目录里跑不起来的探测脚本', sessionKey: 's1', now, store, redStore, runTurn });
  }
  // 另一个会话允许
  const otherSession = await runOnTheSpotFix({ problem: '修桌面代理目录里跑不起来的探测脚本', sessionKey: 's2', now, store: new Map(), redStore, runTurn });
  assert.notEqual(otherSession.refused, true);
  // 同一会话换一条问题也允许
  const otherProblem = await runOnTheSpotFix({ problem: '把 parse 函数的空指针改掉', sessionKey: 's1', now, store: new Map(), redStore, runTurn });
  assert.notEqual(otherProblem.refused, true);
  // 窗口过了：重新允许
  const later = await runOnTheSpotFix({
    problem: '修桌面代理目录里跑不起来的探测脚本', sessionKey: 's1',
    now: now + ON_THE_SPOT_WINDOW_MS + 1000, store: new Map(), redStore, runTurn,
  });
  assert.notEqual(later.refused, true);
});

test('没有交付门数据时，重复 RED 也能说清"上一轮以 RED 结束"', async () => {
  const store = new Map();
  const redStore = new Map();
  const now = Date.now();
  const runTurn = async () => failedReply;
  for (let i = 0; i < 2; i++) {
    await runOnTheSpotFix({ problem: '修桌面代理目录里跑不起来的探测脚本', sessionKey: 's9', now, store, redStore, runTurn });
  }
  const third = await runOnTheSpotFix({ problem: '修桌面代理目录里跑不起来的探测脚本', sessionKey: 's9', now, store, redStore, runTurn });
  assert.equal(third.refused, true);
  assert.match(third.text, /RED|失败/);
  assert.match(third.text, /先修环境或换目录/);
});

test('工具描述（统一引擎 + Pi 侧）都写清适用边界与替代做法', () => {
  const serverSrc = fs.readFileSync('server.mjs', 'utf8');
  const toolInitsSrc = fs.readFileSync('engine/session/tool-inits.mjs', 'utf8');
  for (const [where, src] of [['server.mjs', serverSrc], ['tool-inits.mjs', toolInitsSrc]]) {
    assert.match(src, /观察类任务不要用/, `${where} 要明确禁止观察类任务`);
    assert.match(src, /直接看那张图|直接看图|读文件/, `${where} 要给出替代做法（直接读图/看图）`);
    assert.match(src, /同一会话 10 分钟内最多 3 次/, `${where} 要保留预算语义（6 处文案统一）`);
  }
});
