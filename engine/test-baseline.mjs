// ===== test-baseline.mjs —— 门禁只拦「新增红灯」（2026-10-26）=====
//
// 现实：仓库里有几条长期红着的测试（路由决策缺配置、watchdog 启动依赖 cwd、.ps1 BOM 依赖 PowerShell 版本…）。
// 如果门禁要求"全绿"，它永远红，于是没人看它——等于没有门禁。
//
// 正确做法：把**已知红灯**记成基线（人工确认过一次），门禁只拦**新增**的。
// 这样既不会让既有问题挡住改动，也不会让新问题混过去。
import fs from "node:fs";
import path from "node:path";

export const BASELINE_FILE = path.join("tests", "baseline-failures.json");

/**
 * 从 `node --test` 的输出里抠出失败的**测试名**。
 *
 * 2026-10-26 真机踩到：spec reporter 会把断言的**消息文本**也排成 `✖ …` 行，
 * 原来的正则把它们当成测试名 → 基线对不上 → 每一次自动补丁都被误判成"新增 4 条红灯"，
 * 全部回滚。**这是门禁自己的假阳性**，比补丁质量问题更危险。
 *
 * 判据：真实测试名行**一定带耗时** `(12.3ms)`；断言消息不会。
 * TAP 输出走 `not ok N - name`。
 */
export function parseFailures(output) {
  const names = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    const tap = line.match(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/);
    if (tap) { names.add(tap[1].trim()); continue; }
    // 必须带耗时才算测试名
    const spec = line.match(/^\s*✖ (.+?)\s+\((\d+(?:\.\d+)?)ms\)\s*$/);
    if (spec) names.add(spec[1].trim());
  }
  names.delete("failing tests:");
  return [...names];
}

export function loadBaseline(repoRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(repoRoot, BASELINE_FILE), "utf8"));
    return Array.isArray(data.known) ? data.known : [];
  } catch { return []; }
}

export function saveBaseline(repoRoot, known, { note = "" } = {}) {
  const file = path.join(repoRoot, BASELINE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), note, known: [...new Set(known)].sort() }, null, 2), "utf8");
  return file;
}

/** 比对：返回新增失败（不在基线里的）。 */
export function newFailures(output, baseline = []) {
  const known = new Set(baseline);
  return parseFailures(output).filter((n) => !known.has(n));
}

export function summaryOf(output, baseline = []) {
  const all = parseFailures(output);
  const fresh = all.filter((n) => !new Set(baseline).has(n));
  return { total: all.length, known: all.length - fresh.length, fresh, all };
}
