// 触发用例：看门狗重复提醒（2026-11-19 收紧）
//
// 复盘的事实：14 条提醒里 4 条是同一件事被重复喊。
// 根因不是「预算扣了没记通知」，而是冷却只按签名（问题 code 组合）算，没带**事情的身份**：
// 同一会话的问题从 failing 变成 failing+loop+no_gate，签名一变就被当成新问题再喊一遍。
//
// 这个文件用真实规则跑断言（旧测试只 console.log，不判失败，等于没测）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  shouldEscalate, recordNotified, readLastNotified, signatureOf, incidentKeyOf,
  DEFAULT_COOLDOWN_MS, STORM_WINDOW_MS,
} from '../../engine/drift-escalation.mjs';

const NOW = 1_700_000_000_000;
const SESSION = '01a1e9cd-1111-7222-8333-444455556666';
const OTHER_SESSION = '01a1ed05-9999-7aaa-8bbb-ccccddddeeee';

const mk = (code, extra = {}) => ({ code, detail: `${code} 触发`, sessionId: SESSION, ...extra });

function freshWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ys-drift-trigger-'));
}

test('同一件事、同一签名、1 分钟后 → 不再提醒', () => {
  const ws = freshWs();
  const issues = [mk('failing')];
  const r1 = shouldEscalate({ drift: true, issues, now: NOW, last: readLastNotified(ws) });
  assert.equal(r1.escalate, true);
  recordNotified(ws, r1.key, { now: NOW, incident: r1.incident });

  const r2 = shouldEscalate({ drift: true, issues, now: NOW + 60_000, last: readLastNotified(ws) });
  assert.equal(r2.escalate, false, '同签名重复提醒没被压住');
  assert.match(r2.reason, /刚报过/);
});

test('核心回归：同一件事换了签名（failing → failing+loop+no_gate）也不再提醒', () => {
  const ws = freshWs();
  const first = [mk('failing')];
  const r1 = shouldEscalate({ drift: true, issues: first, now: NOW, last: readLastNotified(ws) });
  assert.equal(r1.escalate, true);
  recordNotified(ws, r1.key, { now: NOW, incident: r1.incident });

  // 41 分钟后，同一会话多叠了两种问题——旧规则会当成新问题再喊一次（这就是那 4 条重复）
  const later = [mk('failing'), mk('loop'), mk('no_gate')];
  const r2 = shouldEscalate({ drift: true, issues: later, now: NOW + 41 * 60_000, last: readLastNotified(ws) });
  assert.equal(r2.escalate, false, '签名一变又重复提醒了');
  assert.equal(r2.incident, r1.incident, '两件事应被认成同一件事');
  assert.notEqual(r2.key, r1.key, '两次签名本身确实不同（旧规则失效的前提）');
  assert.match(r2.reason, /换了签名/);
});

test('不同会话、不同签名 → 照常提醒', () => {
  const ws = freshWs();
  const a = [mk('failing')];
  const r1 = shouldEscalate({ drift: true, issues: a, now: NOW, last: readLastNotified(ws) });
  recordNotified(ws, r1.key, { now: NOW, incident: r1.incident });

  const b = [mk('no_gate', { sessionId: OTHER_SESSION })];
  const r2 = shouldEscalate({ drift: true, issues: b, now: NOW + 5 * 60_000, last: readLastNotified(ws) });
  assert.equal(r2.escalate, true, '另一件事的新问题被误压了');
});

test('防洪：不同会话、同一签名 30 分钟内只喊一次', () => {
  const ws = freshWs();
  const a = [mk('loop')];
  const r1 = shouldEscalate({ drift: true, issues: a, now: NOW, last: readLastNotified(ws) });
  recordNotified(ws, r1.key, { now: NOW, incident: r1.incident });

  const b = [mk('loop', { sessionId: OTHER_SESSION })];
  const r2 = shouldEscalate({ drift: true, issues: b, now: NOW + 10 * 60_000, last: readLastNotified(ws) });
  assert.equal(r2.escalate, false, '系统性故障刷屏没被压住');
  assert.match(r2.reason, /防洪/);

  const r3 = shouldEscalate({ drift: true, issues: b, now: NOW + STORM_WINDOW_MS + 60_000, last: readLastNotified(ws) });
  assert.equal(r3.escalate, true, '过了防洪窗口应当重新提醒');
});

test('冷却过期后同一件事可以再提醒', () => {
  const ws = freshWs();
  const issues = [mk('failing')];
  const r1 = shouldEscalate({ drift: true, issues, now: NOW, last: readLastNotified(ws) });
  recordNotified(ws, r1.key, { now: NOW, incident: r1.incident });

  const inWindow = shouldEscalate({ drift: true, issues, now: NOW + DEFAULT_COOLDOWN_MS - 60_000, last: readLastNotified(ws) });
  assert.equal(inWindow.escalate, false);
  const expired = shouldEscalate({ drift: true, issues, now: NOW + DEFAULT_COOLDOWN_MS + 60_000, last: readLastNotified(ws) });
  assert.equal(expired.escalate, true, '4 小时后仍压着，提醒永远发不出去');
});

test('身份优先级：会话 > run > task > none', () => {
  assert.equal(incidentKeyOf([{ sessionId: 'S', runId: 'R', taskId: 'T' }]), 's:S');
  assert.equal(incidentKeyOf([{ runId: 'R', taskId: 'T' }]), 'r:R');
  assert.equal(incidentKeyOf([{ taskId: 'T' }]), 't:T');
  assert.equal(incidentKeyOf([{ code: 'loop' }]), 'none');
  assert.equal(signatureOf([mk('loop'), mk('failing'), mk('loop')]), 'failing+loop');
});

test('旧台账（签名 → 数字时间戳）仍能读，并照样挡住重复', () => {
  const ws = freshWs();
  const dir = path.join(ws, '记忆', '运行时');
  fs.mkdirSync(dir, { recursive: true });
  const legacy = path.join(dir, '看门狗通知.json');
  fs.writeFileSync(legacy, JSON.stringify({ last: { failing: NOW - 60_000 } }), 'utf8');

  const last = readLastNotified(ws);
  const r = shouldEscalate({ drift: true, issues: [mk('failing')], now: NOW, last });
  assert.equal(r.escalate, false, '旧格式台账没生效 → 升级后会突然重推一轮');
});

test('记账格式：身份|签名，且只留最近 50 条', () => {
  const ws = freshWs();
  const r = shouldEscalate({ drift: true, issues: [mk('failing')], now: NOW, last: {} });
  const w = recordNotified(ws, r.key, { now: NOW, incident: r.incident });
  assert.equal(w.ok, true);
  assert.equal(w.key, `s:${SESSION}|failing`);

  for (let i = 0; i < 60; i++) {
    const t = NOW + i * 1000;
    recordNotified(ws, `s:sess-${i}|loop`, { now: t, incident: `s:sess-${i}`, sig: 'loop' });
  }
  const kept = Object.keys(readLastNotified(ws));
  assert.equal(kept.length, 50, `台账应裁剪到 50 条，实际 ${kept.length}`);
  assert.ok(!kept.includes(`s:${SESSION}|failing`), '最旧的一条应被裁掉');
  assert.ok(kept.includes('s:sess-59|loop'), '最新的一条应保留');
});

test('真实台账回放：同一件事 4 小时内不再重复推送（旧规则重复 → 新规则 0）', () => {
  const ledger = 'D:/pi-workspace/记忆/运行时/看门狗事件.json';
  if (!fs.existsSync(ledger)) return; // 别的机器上没有这份台账，跳过
  const raw = JSON.parse(fs.readFileSync(ledger, 'utf8'))?.items || [];
  assert.ok(raw.length > 0, '台账为空，回放没有意义');
  // 台账是新在前，回放必须按时间正序
  const items = [...raw].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));

  // 统计「同一件事在冷却窗内被推第二次」的次数——这才是伙伴说的重复
  const dupCount = (pushes) => {
    const byInc = new Map();
    let dup = 0;
    for (const p of pushes) {
      const prev = byInc.get(p.incident) || [];
      if (prev.some((t) => p.at - t < DEFAULT_COOLDOWN_MS)) dup += 1;
      prev.push(p.at);
      byInc.set(p.incident, prev);
    }
    return dup;
  };

  const ws = freshWs();
  const oldLast = {};
  const oldPushes = [];
  let newLast = {};
  const newPushes = [];
  let oldPush = 0, newPush = 0;
  const pushedAt = new Map(); // 身份 → 推送时间表
  for (const it of items) {
    const at = Number(it.at || 0);
    const issues = Array.isArray(it.issues) ? it.issues : [];
    if (!at || !issues.length) continue;

    const sig = signatureOf(issues);
    const prevOld = Number(oldLast[sig] || 0);
    if (!(prevOld && at - prevOld < DEFAULT_COOLDOWN_MS)) {
      oldLast[sig] = at;
      oldPush += 1;
      oldPushes.push({ incident: incidentKeyOf(issues), sig, at });
    }

    const esc = shouldEscalate({ drift: true, issues, now: at, last: newLast });
    if (!esc.escalate) continue;
    newPush += 1;
    const inc = incidentKeyOf(issues);
    newPushes.push({ incident: esc.incident, sig: esc.key, at });
    const w = recordNotified(ws, esc.key, { now: at, incident: esc.incident });
    assert.equal(w.ok, true, '落盘失败');
    newLast = readLastNotified(ws);

    // 同一件事在冷却窗内推送两次 = 旧规则里那个重复问题
    const prevs = pushedAt.get(inc) || [];
    assert.ok(!prevs.some((t) => at - t < DEFAULT_COOLDOWN_MS), `${inc} 在冷却窗内又推了一次`);
    prevs.push(at);
    pushedAt.set(inc, prevs);
  }
  const oldDup = dupCount(oldPushes);
  const newDup = dupCount(newPushes);
  assert.equal(newDup, 0, `新规则下仍有 ${newDup} 次冷却窗内重复推送`);
  assert.ok(newDup <= oldDup, '新规则的重复次数必须不高于旧规则');
  console.log(`[replay] 台账 ${items.length} 条：旧规则推送 ${oldPush} 次（重复 ${oldDup} 次）→ 新规则 ${newPush} 次（重复 ${newDup} 次）`);
  if (oldDup > 0) {
    const seen = new Map();
    for (const p of oldPushes) {
      const prev = seen.get(p.incident) || [];
      if (prev.some((t) => p.at - t < DEFAULT_COOLDOWN_MS)) {
        console.log(`[replay] 旧规则重复：${p.incident} @ ${new Date(p.at).toISOString().slice(5, 16)}（${p.sig}）`);
      }
      prev.push(p.at);
      seen.set(p.incident, prev);
    }
  }
});
