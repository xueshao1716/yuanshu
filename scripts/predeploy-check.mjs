// ===== scripts/predeploy-check.mjs —— 部署/重启前的门禁（fail-closed）=====
//
// 为什么要单独成脚本：2026-10-25 我在一条内联循环里把「探活超时」当成「没有活动轮次」，
// 于是两次把用户正在跑的对话打成了 interrupted（一次 resumable=false，直接救不回）。
// 病根不是粗心，是判定写错了方向：
//   · 探不到 / 超时 ≠ 安全，而是**不知道**——不知道就必须继续等，或者拒绝。
//   · 轮询到某个时刻拿到 0 才叫安全。
//
// 用法：
//   node scripts/predeploy-check.mjs                 # 默认最多等 300 秒
//   node scripts/predeploy-check.mjs --wait 600      # 最多等 10 分钟
//   node scripts/predeploy-check.mjs --url http://127.0.0.1:8787 --token <tok>
// 退出码：0 = 可以部署；2 = 还有活动轮次；3 = 探不到状态（不敢动）
//
// 注意本脚本只读 `/api/run/overview`，不改任何状态。
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_WAIT_MS = 300_000;
export const POLL_MS = 15_000;
/** 连续多少次探活失败就判定"状态不可知"并拒绝（不是无限等）。 */
export const MAX_CONSECUTIVE_PROBE_FAILURES = 3;

/**
 * 门禁决策（纯函数，可单测）。
 * @param {{probeOk:boolean, active:number|null, waitedMs:number, maxWaitMs:number, consecutiveFailures:number}} p
 * @returns {{allow:boolean, done:boolean, reason:string, code:number}}
 *   done=true 表示不必再轮询（allow 或 拒绝都已定）
 */
export function decideDeployGate({
  probeOk, active = null, waitedMs = 0, maxWaitMs = DEFAULT_MAX_WAIT_MS,
  consecutiveFailures = 0, maxFailures = MAX_CONSECUTIVE_PROBE_FAILURES,
} = {}) {
  if (probeOk && Number(active) === 0) {
    return { allow: true, done: true, reason: "没有活动轮次", code: 0 };
  }
  if (probeOk && Number(active) > 0) {
    if (waitedMs >= maxWaitMs) {
      return { allow: false, done: true, reason: `等满 ${Math.round(maxWaitMs / 1000)}s 仍有 ${active} 个活动轮次——按纪律不重启`, code: 2 };
    }
    return { allow: false, done: false, reason: `有 ${active} 个活动轮次，继续等（已等 ${Math.round(waitedMs / 1000)}s）`, code: 2 };
  }
  // 探不到：超时 / 连接失败 / 返回体不对
  if (consecutiveFailures >= maxFailures) {
    return { allow: false, done: true, reason: `连续 ${consecutiveFailures} 次探不到运行状态——不知道就不能动`, code: 3 };
  }
  if (waitedMs >= maxWaitMs) {
    return { allow: false, done: true, reason: `等满 ${Math.round(maxWaitMs / 1000)}s 仍探不到运行状态——不知道就不能动`, code: 3 };
  }
  return { allow: false, done: false, reason: `探不到运行状态（第 ${consecutiveFailures} 次），重试`, code: 3 };
}

function readToken(explicit) {
  if (explicit) return explicit;
  const candidates = [
    process.env.YUANSHU_TOKEN,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Yuanshu", "app", ".token"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return fs.readFileSync(c, "utf8").trim(); } catch {}
  }
  return "";
}

async function probeActiveRuns({ url, token, timeoutMs = 20_000 }) {
  const res = await fetch(`${url}/api/run/overview`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const active = Array.isArray(body?.active) ? body.active.length : null;
  if (active === null) throw new Error("overview 返回体里没有 active 数组");
  return active;
}

export async function waitForIdle({ url = "http://127.0.0.1:8787", token = "", maxWaitMs = DEFAULT_MAX_WAIT_MS, pollMs = POLL_MS, log = console.log, probe = probeActiveRuns } = {}) {
  const startedAt = Date.now();
  let failures = 0;
  for (;;) {
    const waitedMs = Date.now() - startedAt;
    let active = null, probeOk = false;
    try {
      active = await probe({ url, token });
      probeOk = true;
      failures = 0;
    } catch (e) {
      failures += 1;
      log(`  探活失败（${failures}/${MAX_CONSECUTIVE_PROBE_FAILURES}）：${String(e?.message || e).slice(0, 120)}`);
    }
    const verdict = decideDeployGate({ probeOk, active, waitedMs, maxWaitMs, consecutiveFailures: failures });
    log(`  ${verdict.reason}`);
    if (verdict.done) return verdict;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const maxWaitMs = Number(arg("wait", DEFAULT_MAX_WAIT_MS / 1000)) * 1000;
  const url = arg("url", process.env.YUANSHU_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = readToken(arg("token", ""));
  const verdict = await waitForIdle({ url, token, maxWaitMs });
  console.log(verdict.allow ? "✅ 可以部署" : `⛔ 不部署：${verdict.reason}`);
  process.exit(verdict.code);
}
