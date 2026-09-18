// 任务中当场修（fix_problem）：核心规则与预算（engine/reflection-exec.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runOnTheSpotFix, takeOnTheSpotBudget, ON_THE_SPOT_MAX } from '../../engine/reflection-exec.mjs';

const fakeTurn = (reply) => async (prompt = '') =>
  // 2026-09-18 起，当场修在 done 之后会**再派一个独立验证轮**（engine/verifier.mjs）：
  // 所以假 runTurn 要按提示词区分"执行轮"与"验证轮"，否则验证轮会拿到执行轮的结果、
  // 解析不出 verdict → UNVERIFIED → 把 done 降级（这正是它该做的）。
  (/独立验证者/.test(prompt)
    ? '```json\n{"verdict":"PASS","evidence":"ls -l 看到文件存在，cat 内容与声明一致","checks":["ls -l","cat"]}\n```'
    : reply);
const doneReply = (evidence = 'node --test tests/unit/x.test.mjs → pass 12/12') =>
  `修好了\n\`\`\`json\n{"status":"done","evidence":"${evidence}","files":["tests/unit/x.test.mjs"],"summary":"补了守卫"}\n\`\`\``;

const freshStore = () => new Map();

test('当场修：能修的就真派一轮，并把证据回给模型', async () => {
  let asked = '';
  const out = await runOnTheSpotFix({
    problem: '给 abort 用例的 bash 路径加引号',
    store: freshStore(),
    runTurn: async (prompt) => { if (!/独立验证者/.test(prompt)) asked = prompt; return fakeTurn(doneReply())(prompt); },
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'done');
  assert.equal(out.verification?.verdict, 'PASS', '执行轮说 done 要过独立验证才算数');
  assert.match(asked, /只做这一条/, '执行轮提示词要带上硬约束');
  assert.match(asked, /给 abort 用例的 bash 路径加引号/);
  assert.match(out.text, /已当场修好/);
  assert.match(out.text, /pass 12\/12/, '证据要回到模型手里，它才能据实汇报');
  assert.match(out.text, /据实说这条已经修掉/);
});

test('当场修：执行轮说 done，但独立验证没过 → 不许当成功', async () => {
  let verifyAsked = false;
  const out = await runOnTheSpotFix({
    problem: '把那个配置项改对',
    store: freshStore(),
    runTurn: async (prompt) => {
      if (/独立验证者/.test(prompt)) { verifyAsked = true; return '```json\n{"verdict":"FAIL","evidence":"cat 看到的还是旧值"}\n```' }
      return doneReply();
    },
  });
  assert.equal(verifyAsked, true, 'done 之后必须真的派了验证轮');
  assert.equal(out.status, 'failed', 'FAIL → 降级为 failed');
  assert.equal(out.ok, false);
  assert.match(out.evidence, /独立验证未通过（FAIL）/);
  assert.match(out.text, /如实说这条没做成/);
});

test('当场修：红线一律不动手，把该说的话交回模型', async () => {
  for (const problem of ['轮换 API key 并写进配置', '把服务部署上线', 'git push 到远端', '删除旧会话数据']) {
    let called = false;
    const out = await runOnTheSpotFix({
      problem,
      store: freshStore(),
      runTurn: async () => { called = true; return doneReply(); },
    });
    assert.equal(out.ok, false, problem);
    assert.equal(out.refused, true);
    assert.equal(called, false, `${problem} 不该真的去执行`);
    assert.match(out.text, /不能当场自动修/);
    assert.match(out.text, /需要谁来做哪一步|交给用户/);
  }
});

test('当场修：没做成要如实回话（blocked/failed 不许含混过关）', async () => {
  for (const [status, word] of [['blocked', /受阻/], ['failed', /失败/]]) {
    const out = await runOnTheSpotFix({
      problem: '把某个不存在的配置项改掉',
      store: freshStore(),
      runTurn: fakeTurn(`\`\`\`json\n{"status":"${status}","evidence":"缺 X"}\n\`\`\``),
    });
    assert.equal(out.ok, false);
    assert.match(out.text, word);
    assert.match(out.text, /不要含糊过去/);
  }
  // 执行轮压根没按契约回答 → 按失败处理，不猜成功
  const bad = await runOnTheSpotFix({ problem: '把那个配置项改掉并加一条回归测试', store: freshStore(), runTurn: fakeTurn('我改了，但没写 JSON') });
  assert.equal(bad.status, 'failed');
  assert.match(bad.evidence, /没有按契约给出结果/);
  // 描述太短（不足 8 字）不接：说不清就没法动手
  const short = await runOnTheSpotFix({ problem: '改一下', store: freshStore(), runTurn: fakeTurn(doneReply()) });
  assert.equal(short.refused, true);
  assert.match(short.text, /太短/);
  assert.equal(fs.existsSync('/nonexistent'), false);
});

test('当场修：预算按会话算，超了就拒绝（免得把对话拖成一串自动执行）', async () => {
  const store = freshStore();
  const now = Date.now();
  for (let i = 0; i < ON_THE_SPOT_MAX; i++) {
    const b = takeOnTheSpotBudget('s1', { now, store });
    assert.equal(b.ok, true, `第 ${i + 1} 次应该允许`);
  }
  const over = takeOnTheSpotBudget('s1', { now, store });
  assert.equal(over.ok, false);
  assert.match(over.reason, /最多当场修 3 次/);
  // 超了之后连调用都被挡回（不是"执行了但没记账"）
  const refused = await runOnTheSpotFix({ problem: '再修一条小毛病并跑一遍测试', sessionKey: 's1', now, store, runTurn: fakeTurn(doneReply()) });
  assert.equal(refused.refused, true);
  assert.match(refused.text, /最多当场修 3 次/);
  // 另一个会话不受影响
  assert.equal(takeOnTheSpotBudget('s2', { now, store }).ok, true);
  // 过了时间窗就恢复（拿一个新的 store 判，免得上面的时间旅行影响别的断言）
  const store2 = freshStore();
  takeOnTheSpotBudget('s3', { now, store: store2 });
  assert.equal(takeOnTheSpotBudget('s3', { now: now + 11 * 60 * 1000, store: store2 }).ok, true);
});

test('当场修：接线要到两个引擎（统一引擎工具 + Pi 会话 customTool），且共用同一个核心', () => {
  const server = fs.readFileSync('server.mjs', 'utf8');
  assert.match(server, /name: "fix_problem"/, '统一引擎要注册 fix_problem 工具');
  assert.match(server, /fix_problem: async \(args, ctx\)/, '统一引擎要有它的执行器');
  assert.match(server, /runOnTheSpotFix\(\{/, '执行器要用共享核心，不要另写一套');
  assert.match(server, /setOnTheSpotFixRunner\(/, '要把执行器注入会话管理（Pi 侧同名工具）');
  const sm = fs.readFileSync('engine/session-manager.mjs', 'utf8');
  assert.match(sm, /name: "fix_problem"/, 'Pi 会话要注册同名 customTool');
  assert.match(sm, /customTools.push\(fixTool\)/, '注册了还要真的放进 customTools');
  assert.match(sm, /setOnTheSpotFixRunner/, '要留注入口');
  const proto = fs.readFileSync('engine/yuanshu-protocol.mjs', 'utf8');
  assert.match(proto, /发现问题就当场修/, '协议里要写清"别只在结论里列一条建议修复"');
  assert.match(proto, /最多当场修 3 次/, '协议里要写出预算，免得模型以为能无限修');
});
