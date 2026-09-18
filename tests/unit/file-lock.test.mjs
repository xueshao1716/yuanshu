// 文件写队列（engine/file-lock.mjs）
//
// 这里要澄清一个我一开始搞错的前提：元枢自己的 edit 是 `readFileSync → replace →
// writeFileSync`，中间没有 await，**单线程下本来就原子**——实测并发两次 edit 两个改动都在。
// 真正存在的窗口在**跨实现**：Pi 的 edit 用 fs/promises，读写之间有真 await，
// 而它有自己的一套 withFileMutationQueue、元枢什么都没有，两套互不相通。
// 所以正确做法是共用 Pi 那把队列，而不是另造一把。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  initFileLock, withFileLock, canonicalFilePath, usingSharedFileQueue, activeFileLockCount,
  withCrossProcessLock, crossProcessLockPath, FileLockTimeoutError, lockDir, lockStats, stealAction,
} from "../../engine/file-lock.mjs";
import { spawn } from "node:child_process";
import { createUnifiedToolExecutor } from "../../engine/tools/unified-tools.mjs";
import { safeJoin } from "../../engine/tools/security.mjs";
import { CONFIG } from "../../config.mjs";

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `yuanshu-lock-${tag}-`));
}

/** 取 Pi 的共享队列；拿不到就返回 null（本机没装 Pi 时测试跳过）。 */
async function piQueue() {
  try {
    if (!CONFIG.piPackage) return null;
    const mod = await import(pathToFileURL(CONFIG.piPackage).href);
    return typeof mod.withFileMutationQueue === "function" ? mod.withFileMutationQueue : null;
  } catch { return null; }
}

// ── canonicalFilePath ──
test("canonicalFilePath：归一化 . 与 ..，且不抛异常", () => {
  const dir = tmpdir("canon");
  try {
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "x");
    assert.equal(canonicalFilePath(path.join(dir, ".", "a.txt")), canonicalFilePath(f));
    assert.equal(canonicalFilePath(path.join(dir, "sub", "..", "a.txt")), canonicalFilePath(f));
    assert.equal(canonicalFilePath(""), path.resolve(""));
    assert.equal(canonicalFilePath(null), path.resolve(""));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canonicalFilePath：符号链接与真实路径落到同一个键", t => {
  const dir = tmpdir("symlink");
  try {
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "f.txt"), "x");
    let link = path.join(dir, "link");
    try { fs.symlinkSync(real, link, "junction"); }
    catch { t.skip("本机不允许创建符号链接（需要开发者模式）"); return; }
    assert.equal(
      canonicalFilePath(path.join(link, "f.txt")),
      canonicalFilePath(path.join(real, "f.txt")),
      "通过符号链接访问必须与真实路径共用一把锁",
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canonicalFilePath：文件还不存在时，向上找最近存在的祖先做 realpath", t => {
  const dir = tmpdir("missing");
  try {
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    let link = path.join(dir, "link");
    try { fs.symlinkSync(real, link, "junction"); }
    catch { t.skip("本机不允许创建符号链接（需要开发者模式）"); return; }
    // 目标文件尚不存在（write 会创建它）
    assert.equal(
      canonicalFilePath(path.join(link, "new.txt")),
      canonicalFilePath(path.join(real, "new.txt")),
      "不存在的文件也要穿过符号链接指向同一个键，否则 write 会绕过锁",
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 自带队列（Pi 队列不可用时的退路）──
test("自带队列：同一路径串行，不交错", async () => {
  initFileLock({});
  assert.equal(usingSharedFileQueue(), false, "未注入时应走自带实现");
  const dir = tmpdir("serial");
  try {
    const f = path.join(dir, "f.txt");
    const order = [];
    await Promise.all([
      withFileLock(f, async () => { order.push("a-start"); await new Promise(r => setImmediate(r)); order.push("a-end"); }),
      withFileLock(f, async () => { order.push("b-start"); order.push("b-end"); }),
    ]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"], "第二个必须等第一个结束");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("自带队列：不同路径并行，互不阻塞", async () => {
  initFileLock({});
  const dir = tmpdir("parallel");
  try {
    const order = [];
    await Promise.all([
      withFileLock(path.join(dir, "a.txt"), async () => { order.push("a-start"); await new Promise(r => setTimeout(r, 20)); order.push("a-end"); }),
      withFileLock(path.join(dir, "b.txt"), async () => { order.push("b-start"); order.push("b-end"); }),
    ]);
    assert.deepEqual(order, ["a-start", "b-start", "b-end", "a-end"], "不同文件不该互相排队");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("自带队列：抛异常也要释放，且队列自清理", async () => {
  initFileLock({});
  const dir = tmpdir("throw");
  try {
    const f = path.join(dir, "f.txt");
    await assert.rejects(() => withFileLock(f, async () => { throw new Error("boom"); }), /boom/);
    // 释放了才会走到这里
    const r = await withFileLock(f, async () => "after");
    assert.equal(r, "after", "抛异常后锁必须释放");
    assert.equal(activeFileLockCount(), 0, "队列必须自清理，不能长跑泄漏");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 委托给 Pi 的共享队列 ──
test("注入 Pi 队列后走共享实现；传非函数安全退回", async () => {
  const calls = [];
  initFileLock({ withFileMutationQueue: async (p, fn) => { calls.push(p); return fn(); } });
  assert.equal(usingSharedFileQueue(), true);
  await withFileLock("/x/y.txt", async () => "ok");
  assert.deepEqual(calls, ["/x/y.txt"], "必须委托给注入的队列");
  initFileLock({ withFileMutationQueue: 42 });
  assert.equal(usingSharedFileQueue(), false, "非函数必须被忽略而不是崩");
  initFileLock({});
});

// ── 关键：跨实现交错 ──
// 时序要用门控钉死，否则证明不了任何东西：先让 Pi 风格变更**读完**并挂在 await 上，
// 再让元枢 edit 进来。只有这时"共用队列"才有话可说。
async function crossEngineRace({ shareQueue, shared, dir, file, exec }) {
  fs.writeFileSync(file, "A\nB\n");
  let readDone;
  const readGate = new Promise(r => { readDone = r; });
  const piStyleMutation = () => shared(file, async () => {
    const c = fs.readFileSync(file, "utf8");   // ← 先读
    readDone();
    await new Promise(r => setTimeout(r, 40)); // ← 交错窗口（Pi 的 edit 就是 await read/write）
    fs.writeFileSync(file, c.replace("B", "B1")); // ← 用陈旧内容写回
  });
  const mutation = piStyleMutation();
  await readGate;                    // 确保 Pi 那侧已经读过
  const editResult = await exec("edit", { path: "f.txt", oldText: "A", newText: "A1" });
  await mutation;
  return { editResult, final: fs.readFileSync(file, "utf8") };
}

test("共用 Pi 队列时，元枢 edit 与 Pi 风格的异步变更不会互相覆盖", async t => {
  const shared = await piQueue();
  if (!shared) { t.skip("本机拿不到 Pi 的 withFileMutationQueue"); return; }
  initFileLock({ withFileMutationQueue: shared });
  assert.equal(usingSharedFileQueue(), true);

  const dir = tmpdir("shared");
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); initFileLock({}); });
  const file = path.join(dir, "f.txt");
  const exec = createUnifiedToolExecutor({ cwd: () => dir, safePath: p => safeJoin(dir, p) });

  const { editResult, final } = await crossEngineRace({ shareQueue: true, shared, dir, file, exec });
  assert.equal(editResult.isError, false, `元枢 edit 应成功: ${editResult.text}`);
  assert.equal(final, "A1\nB1\n", `两个改动都必须保留（共用队列的意义），实际: ${JSON.stringify(final)}`);
});

test("未共用队列时，同样的交错确实会丢改动（证明共用不是多此一举）", async t => {
  const shared = await piQueue();
  if (!shared) { t.skip("本机拿不到 Pi 的 withFileMutationQueue"); return; }
  // 故意不注入：元枢走自带队列，Pi 风格变更走 Pi 的队列 → 两把互不相通的锁
  initFileLock({});

  const dir = tmpdir("noshare");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "f.txt");
  const exec = createUnifiedToolExecutor({ cwd: () => dir, safePath: p => safeJoin(dir, p) });

  const { final } = await crossEngineRace({ shareQueue: false, shared, dir, file, exec });
  assert.equal(final, "A\nB1\n", `两把独立的锁挡不住跨实现交错，A1 应被覆盖，实际: ${JSON.stringify(final)}`);
});

// ── 跨进程锁 ──
// 用真的多进程验证：每个子进程做一次非原子的 读-改-写，靠锁保证不丢计数。
const LOCK_MODULE_URL = new URL("../../engine/file-lock.mjs", import.meta.url).href;

/** 子进程脚本：在锁保护下做 读 → 睡一会儿 → 写 的非原子自增。
 *  必须等起跑线（startAt）再动手，否则 spawn 间隔比工作窗口还长，几个进程压根不会重叠，
 *  "对照"就证明不了任何东西（第一版正是这么失败的）。
 *
 *  2026-09-18 补：每个子进程把自己"读到什么、写了什么、窗口是几号到几号、用的哪个锁文件"
 *  追加进 trace 文件。这条用例偶尔会在机器很忙时红一次（形态：5 个进程都退出码 0，
 *  计数器却只有 4），而**光看"4 !== 5"什么都诊断不出来**——所以把现场留下来，
 *  断言失败时把 trace 一并打出来。 */
function childScript({ useLock }) {
  return `
import fs from 'node:fs';
import { withFileLock, initFileLock, crossProcessLockPath, lockStats } from ${JSON.stringify(LOCK_MODULE_URL)};
const [counter, lockDir, startAtRaw, trace] = process.argv.slice(1);
initFileLock({ dir: lockDir });
const traceLog = (o) => { if (!trace) return; try { fs.appendFileSync(trace, JSON.stringify(o) + '\\n'); } catch {} };
traceLog({ ev: 'boot', pid: process.pid, lockPath: crossProcessLockPath(counter) });
const startAt = Number(startAtRaw);
while (Date.now() < startAt) await new Promise(r => setTimeout(r, 2));   // 等起跑线
const bump = async () => {
  const t0 = Date.now();
  const n = Number(fs.readFileSync(counter, 'utf8') || '0');
  await new Promise(r => setTimeout(r, 60));   // 交错窗口
  fs.writeFileSync(counter, String(n + 1));
  traceLog({ ev: 'write', pid: process.pid, t0, t1: Date.now(), read: n, wrote: n + 1 });
};
try {
  if (${useLock}) await withFileLock(counter, bump);
  else await bump();
  traceLog({ ev: 'done', pid: process.pid, ok: true, stats: lockStats() });
} catch (e) {
  traceLog({ ev: 'done', pid: process.pid, ok: false, err: String(e && e.message || e).slice(0, 140), stats: lockStats() });
  process.exitCode = 1;
}
`;
}

/** trace 的读法：失败时给出一眼能看的现场（锁路径是否唯一、有没有窗口重叠）。 */
function readTrace(trace) {
  try {
    const lines = fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    const writes = lines.filter(l => l.ev === "write").sort((a, b) => a.t0 - b.t0);
    const lockPaths = [...new Set(lines.filter(l => l.ev === "boot").map(l => l.lockPath))];
    const overlaps = [];
    for (let i = 0; i < writes.length; i++) for (let j = i + 1; j < writes.length; j++) {
      const a = writes[i], b = writes[j];
      if (a.t0 < b.t1 && b.t0 < a.t1) overlaps.push(`pid ${a.pid}(读${a.read}) × pid ${b.pid}(读${b.read})`);
    }
    return `锁文件 ${lockPaths.length} 种${lockPaths.length > 1 ? "（← 两把锁！）" : ""}；`
      + `写入序列 ${writes.map(w => `${w.pid}:读${w.read}→写${w.wrote}`).join(" ") || "（没有写入）"}；`
      + `窗口重叠 ${overlaps.length ? overlaps.join("、") : "无"}；`
      + `结束 ${lines.filter(l => l.ev === "done").map(d => `${d.pid}:ok=${d.ok}${d.stats?.staleSteals ? `/接管${d.stats.staleSteals}[${(d.stats.stealReasons || []).map(r => r.why).join("+")}]` : ""}`).join(" ") || "（没有结束记录，可能有进程没跑完）"}`;
  } catch (e) { return `（trace 读不出来：${String(e?.message || e).slice(0, 60)}）`; }
}

function runChildren(script, args, count) {
  return Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
      stdio: "ignore", windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`子进程退出码 ${code}`))));
  })));
}

/** 起跑线留足时间让所有子进程都启动完并进入等待。 */
const startLine = () => String(Date.now() + 2000);

// ── 2026-09-18：从"5 个子进程都成功、计数器却少 1"那次事故里补的三条 ──
//
// 那条用例只在机器加载很高时才红，说明是**把慢持有者当成死的接管了**。
// 这里不用"等机器变忙"来复现，而是把陈旧阈值调小到几百毫秒、让临界区比它长——
// 同一个机制被放大到必然发生，然后验证两件事：有心跳就不会被接管；没心跳就会（对照）。

test("跨进程锁：临界区比陈旧阈值长时，有心跳就没人能接管（慢 ≠ 死）", async () => {
  const dir = tmpdir("hb");
  try {
    fs.writeFileSync(path.join(dir, "counter.txt"), "0");
    const target = path.join(dir, "counter.txt");
    const order = [];
    const before = lockStats().staleSteals;
    // 第一把：临界区 1200ms，陈旧阈值 300ms —— 没有心跳时它 300ms 后就会被判"死了"
    const first = withCrossProcessLock(target, async () => {
      order.push("A-start");
      await new Promise((r) => setTimeout(r, 1200));
      order.push("A-end");
    }, { staleMs: 300, waitMs: 8000 });
    await new Promise((r) => setTimeout(r, 150));
    const second = withCrossProcessLock(target, async () => { order.push("B-start"); }, { staleMs: 300, waitMs: 8000 });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["A-start", "A-end", "B-start"], "B 必须等 A 走完（心跳保住了慢持有者）");
    assert.equal(lockStats().staleSteals, before, "不该发生任何陈旧接管");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("跨进程锁：对照——关掉心跳，同样的慢持有者确实会被接管（说明心跳不是摆设）", async () => {
  const dir = tmpdir("hb-control");
  try {
    fs.writeFileSync(path.join(dir, "counter.txt"), "0");
    const target = path.join(dir, "counter.txt");
    const order = [];
    const first = withCrossProcessLock(target, async () => {
      order.push("A-start");
      await new Promise((r) => setTimeout(r, 900));
      order.push("A-end");
    }, { staleMs: 250, heartbeat: false, waitMs: 8000 });
    await new Promise((r) => setTimeout(r, 150));
    const second = withCrossProcessLock(target, async () => { order.push("B-start"); }, { staleMs: 250, heartbeat: false, waitMs: 8000 });
    await Promise.all([first, second]);
    assert.ok(order.indexOf("B-start") < order.indexOf("A-end"), `没有心跳时 B 会在 A 结束前进来（实测顺序 ${order.join("→")}）`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("跨进程锁：释放只删自己那一把（token 认领），不误删别人的锁", async () => {
  const dir = tmpdir("token");
  try {
    fs.writeFileSync(path.join(dir, "counter.txt"), "0");
    const target = path.join(dir, "counter.txt");
    const lockFile = crossProcessLockPath(target);
    await withCrossProcessLock(target, async () => {
      // 模拟"我持有期间锁被别人接管"：把锁文件换成另一个 token
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, host: "other-host", at: new Date().toISOString(), target, token: "foreign" }));
    });
    assert.ok(fs.existsSync(lockFile), "别人那把锁必须还在——不能被我的 finally 删掉");
    const holder = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    assert.equal(holder.token, "foreign");
    fs.unlinkSync(lockFile);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("跨进程锁：陈旧锁（持有者已死且够老）仍要能被接管，并记账", async () => {
  const dir = tmpdir("stale");
  try {
    fs.writeFileSync(path.join(dir, "counter.txt"), "0");
    const target = path.join(dir, "counter.txt");
    const lockFile = crossProcessLockPath(target);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, host: os.hostname(), at: "2000-01-01T00:00:00.000Z", target, token: "dead" }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);
    const before = lockStats().staleSteals;
    let ran = false;
    await withCrossProcessLock(target, async () => { ran = true; }, { staleMs: 300, waitMs: 5000 });
    assert.equal(ran, true, "死掉持有者的锁必须能被接管，否则文件永远写不进去");
    assert.equal(lockStats().staleSteals, before + 1, "接管要记账（下次再出问题能看出走的是哪条路径）");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 2026-09-18 丢更新的真凶：接管分支**无条件**删锁 ──
//
// 现场（trace 抓到的）：两个子进程都记了一次"接管"，且都读到同一个 n，最终少 1。
// 机制：A 释放 → 锁文件消失；B 恰好在判定陈旧（statSync 抛 ENOENT → 判成陈旧）→ 无条件
// `unlinkSync(lockFile)`；而这期间 C 已经抢到了新锁 → B 把 C 刚建的锁删了 → B 再抢就成功 →
// B 与 C 同时进临界区。修法是"没锁可删就别删；要删先确认还是刚才判定过的那个 token"。
test("接管决策：没有锁可删时绝不 unlink（这就是丢更新的真凶）", () => {
  assert.equal(stealAction({ verdict: { stale: false }, currentHolder: null }), "wait");
  // statSync 抛 ENOENT：没有锁可删 —— 老代码在这里无条件 unlink，删掉了别人刚建的新锁
  assert.equal(stealAction({ verdict: { stale: true, nothingToSteal: true, token: null }, currentHolder: null }), "skip-unlink");
  assert.equal(stealAction({ verdict: { stale: true, nothingToSteal: true, token: null }, currentHolder: { token: "brand-new" } }), "skip-unlink");
  // 真有一把陈旧锁：只在"还是刚才那一把"时才删
  assert.equal(stealAction({ verdict: { stale: true, token: "old" }, currentHolder: { token: "old" } }), "unlink");
  assert.equal(stealAction({ verdict: { stale: true, token: "old" }, currentHolder: { token: "new" } }), "skip-unlink");
});

test("跨进程锁：别人持有的新鲜锁绝不能被删（不变量）", async () => {
  const dir = tmpdir("fresh");
  try {
    fs.writeFileSync(path.join(dir, "counter.txt"), "0");
    const target = path.join(dir, "counter.txt");
    const lockFile = crossProcessLockPath(target);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    // 一个"活着"的持有者（用本进程 pid，pid 查得到 → 不该被判陈旧）
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), target, token: "fresh" }));
    await assert.rejects(
      withCrossProcessLock(target, async () => { throw new Error("不该进来"); }, { waitMs: 600, staleMs: 30_000 }),
      (e) => e instanceof FileLockTimeoutError,
      "持有者还活着时必须等锁超时，而不是接管",
    );
    assert.ok(fs.existsSync(lockFile), "超时退出也不能删掉别人的锁");
    assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "fresh");
    fs.unlinkSync(lockFile);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("跨进程互斥：多个进程各做一次非原子自增，一个都不丢", async () => {
  const dir = tmpdir("xproc");
  try {
    const lockRoot = path.join(dir, "locks");
    const counter = path.join(dir, "counter.txt");
    const trace = path.join(dir, "trace.jsonl");
    fs.writeFileSync(counter, "0");
    const N = 5;
    await runChildren(childScript({ useLock: true }), [counter, lockRoot, startLine(), trace], N);
    const final = Number(fs.readFileSync(counter, "utf8"));
    assert.equal(final, N,
      `${N} 个子进程都应成功自增；少于 ${N} 说明锁没挡住跨进程交错。\n现场：${readTrace(trace)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("对照：不走锁时同样的多进程自增确实会丢（说明锁不是多余的）", async () => {
  const dir = tmpdir("xproc-ctl");
  try {
    const lockRoot = path.join(dir, "locks");
    const counter = path.join(dir, "counter.txt");
    fs.writeFileSync(counter, "0");
    const N = 5;
    await runChildren(childScript({ useLock: false }), [counter, lockRoot, startLine()], N);
    const got = Number(fs.readFileSync(counter, "utf8"));
    assert.ok(got < N, `不加锁就该丢计数（实际 ${got}/${N}）——这正是要加跨进程锁的原因`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("跨进程锁：同一文件的两种写法落到同一个锁文件", () => {
  const dir = tmpdir("xproc-key");
  try {
    initFileLock({ dir: path.join(dir, "locks") });
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "x");
    assert.equal(crossProcessLockPath(f), crossProcessLockPath(path.join(dir, ".", "a.txt")));
    assert.equal(crossProcessLockPath(f), crossProcessLockPath(path.join(dir, "sub", "..", "a.txt")));
    assert.notEqual(crossProcessLockPath(f), crossProcessLockPath(path.join(dir, "b.txt")));
    assert.ok(crossProcessLockPath(f).startsWith(lockDir()), "锁文件必须落在锁目录里，不污染用户目录");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("跨进程锁：正常释放后锁文件被清掉", async () => {
  const dir = tmpdir("xproc-release");
  try {
    initFileLock({ dir: path.join(dir, "locks") });
    const f = path.join(dir, "a.txt");
    const lockFile = crossProcessLockPath(f);
    await withCrossProcessLock(f, async () => {
      assert.ok(fs.existsSync(lockFile), "持锁期间锁文件必须存在");
      return "done";
    });
    assert.ok(!fs.existsSync(lockFile), "释放后必须删掉锁文件，否则下次白等");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("跨进程锁：等不到锁就如实超时失败，绝不无锁硬写", async () => {
  const dir = tmpdir("xproc-timeout");
  try {
    initFileLock({ dir: path.join(dir, "locks") });
    const f = path.join(dir, "a.txt");
    const lockFile = crossProcessLockPath(f);
    // 伪造一个"活着的本进程持有者"，且足够新，不会被判为陈旧
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), target: f }));
    let ran = false;
    await assert.rejects(
      () => withCrossProcessLock(f, async () => { ran = true; }, { waitMs: 250 }),
      error => error instanceof FileLockTimeoutError && error.code === "ELOCKTIMEOUT",
    );
    assert.equal(ran, false, "拿不到锁时任务体绝不能被执行");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("跨进程锁：持有者进程已死时立刻接管，不必等满陈旧时间", async () => {
  const dir = tmpdir("xproc-stale");
  try {
    initFileLock({ dir: path.join(dir, "locks") });
    const f = path.join(dir, "a.txt");
    const lockFile = crossProcessLockPath(f);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    // pid 用一个几乎不可能存在的值 → holderAlive 判定为死
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, host: os.hostname(), at: new Date().toISOString(), target: f }));
    const r = await withCrossProcessLock(f, async () => "took-over", { waitMs: 2000 });
    assert.equal(r, "took-over", "死进程留下的锁必须能被接管，否则一个崩溃就永久卡住");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("跨进程锁：锁文件太老时按陈旧处理并被替换", async () => {
  const dir = tmpdir("xproc-old");
  try {
    initFileLock({ dir: path.join(dir, "locks") });
    const f = path.join(dir, "a.txt");
    const lockFile = crossProcessLockPath(f);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), at: "2000-01-01T00:00:00.000Z", target: f }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);
    const r = await withCrossProcessLock(f, async () => "ok", { waitMs: 2000, staleMs: 1000 });
    assert.equal(r, "ok");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("edit 工具：等锁超时时如实报错且不改动文件", async () => {
  const dir = tmpdir("xproc-tool");
  try {
    initFileLock({ dir: path.join(dir, "locks"), waitMs: 300 });
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "A\nB\n");
    const lockFile = crossProcessLockPath(file);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), target: file }));

    const exec = createUnifiedToolExecutor({ cwd: () => dir, safePath: p => safeJoin(dir, p) });
    const r = await exec("edit", { path: "f.txt", oldText: "A", newText: "A1" });
    assert.equal(r.isError, true, "拿不到跨进程锁时必须如实失败，不能无锁硬写");
    assert.match(r.text, /暂未写入|等锁超时/);
    assert.equal(r.text.includes("没有改动文件"), true, "要告诉用户文件没被动过");
    assert.equal(fs.readFileSync(file, "utf8"), "A\nB\n", "等锁失败时文件绝不能被改动");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("write 工具：同样受跨进程锁保护", async () => {
  const dir = tmpdir("xproc-write");
  try {
    initFileLock({ dir: path.join(dir, "locks"), waitMs: 300 });
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "orig");
    const lockFile = crossProcessLockPath(file);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), target: file }));

    const exec = createUnifiedToolExecutor({ cwd: () => dir, safePath: p => safeJoin(dir, p) });
    const r = await exec("write", { path: "f.txt", content: "clobbered" });
    assert.equal(r.isError, true);
    assert.equal(fs.readFileSync(file, "utf8"), "orig", "等锁失败时不能覆盖文件");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("回归：刚创建、还没写入元数据的空锁文件绝不能被当成陈旧", async () => {
  // 加锁是先 openSync(wx) 创建、后写元数据，两步之间别的进程看到的是空文件。
  // 第一版把"读不出元数据"当成"持有者已死"直接删锁，导致两个进程同时持锁——
  // 多进程互斥测试当场抓到。这条把它钉死。
  const dir = tmpdir("xproc-empty");
  try {
    initFileLock({ dir: path.join(dir, "locks") });
    const f = path.join(dir, "a.txt");
    const lockFile = crossProcessLockPath(f);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, "");                 // ← 空文件，mtime 是现在
    let ran = false;
    await assert.rejects(
      () => withCrossProcessLock(f, async () => { ran = true; }, { waitMs: 250 }),
      error => error instanceof FileLockTimeoutError,
      "空锁文件必须被当成正在初始化，等锁而不是接管",
    );
    assert.equal(ran, false, "接管了就说明会双持锁");
    assert.ok(fs.existsSync(lockFile), "不能把别人的锁删掉");

    // 但空文件放老了就该能接管（崩溃在写元数据之前的场景）
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);
    const r = await withCrossProcessLock(f, async () => "took-over", { waitMs: 2000, staleMs: 1000 });
    assert.equal(r, "took-over", "足够老的锁文件仍要能接管，否则崩在创建瞬间就永久卡死");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── executor 侧的行为 ──
test("edit：oldText 对不上当前内容时如实失败，绝不盲写", async () => {
  initFileLock({});
  const dir = tmpdir("stale");
  try {
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "X\nB\n");   // 文件已被（外部/另一次修改）改过
    const exec = createUnifiedToolExecutor({ cwd: () => dir, safePath: p => safeJoin(dir, p) });
    const r = await exec("edit", { path: "f.txt", oldText: "A", newText: "A1" });
    assert.equal(r.isError, true, "oldText 不存在时必须失败");
    assert.match(r.text, /未找到 oldText/);
    assert.equal(fs.readFileSync(file, "utf8"), "X\nB\n", "失败时绝不能改动文件");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("edit：锁内重读，不会拿锁外的陈旧内容去替换", async () => {
  initFileLock({});
  const dir = tmpdir("reread");
  try {
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "A\nB\n");
    const exec = createUnifiedToolExecutor({ cwd: () => dir, safePath: p => safeJoin(dir, p) });
    // 先排队一次会改动文件的锁内操作，再让 edit 进入——edit 必须在锁内读到最新内容
    await withFileLock(file, async () => { fs.writeFileSync(file, "A\nB2\n"); });
    const r = await exec("edit", { path: "f.txt", oldText: "B2", newText: "B3" });
    assert.equal(r.isError, false, `应基于锁内重读到的最新内容修改: ${r.text}`);
    assert.equal(fs.readFileSync(file, "utf8"), "A\nB3\n");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("write：与 edit 共用同一把锁，写不会被读-改-写穿插", async () => {
  initFileLock({});
  const dir = tmpdir("write");
  try {
    const file = path.join(dir, "f.txt");
    const exec = createUnifiedToolExecutor({ cwd: () => dir, safePath: p => safeJoin(dir, p) });
    const order = [];
    await Promise.all([
      withFileLock(file, async () => { order.push("lock-start"); await new Promise(r => setImmediate(r)); order.push("lock-end"); }),
      exec("write", { path: "f.txt", content: "written" }).then(() => order.push("write-done")),
    ]);
    assert.deepEqual(order, ["lock-start", "lock-end", "write-done"], "write 必须排在锁之后");
    assert.equal(fs.readFileSync(file, "utf8"), "written");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
