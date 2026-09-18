// engine/runtime-registry.mjs —— 运行时实例登记（2026-09-18）
//
// ── 为什么要有它 ───────────────────────────────────────────────────────
// 今天的真机事故：这台机器上同时跑着**多份 server.mjs**，都在抢 8787。
// 输的那个在"端口占用，等待释放 (n/30)"里空转，赢的那个在服务——但**从外面看不出来是谁在服务**。
// 代价是实打实的：我验证"做梦定时器挂上了没"时，抓到的日志属于**空转的那个实例**，
// 于是得出了"定时器没挂上"的错误结论，白折腾一轮。
//
// 根因不是代码错，是**没有登记**：谁在跑、哪份版本、谁持有端口，全靠猜。
// 这里就是那份登记：每个实例在 记忆/运行时/实例-<pid>.json 里写心跳（30 秒一摸），
// 持有端口的那个额外标 ownsPort。于是"有几份、谁在服务"变成可查事实。
//
// 顺便解决我自己的验证难题：启动事实（版本/是否重复/定时器有没有挂上）写成
// 记忆/运行时/启动日志.jsonl —— **机器可读**，不受重定向日志的 GBK 乱码影响。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "./atomic-io.mjs";

export const HEARTBEAT_STALE_MS = 120_000;   // 超过 2 分钟没心跳就当这个实例没了
const MAX_STARTUPS = 200;

export function runtimeDir(wsRoot) {
  return path.join(wsRoot, "记忆", "运行时");
}
export function instancePath(wsRoot, pid) {
  return path.join(runtimeDir(wsRoot), `实例-${pid}.json`);
}
export function startupLogPath(wsRoot) {
  return path.join(runtimeDir(wsRoot), "启动日志.jsonl");
}

function ensureDir(wsRoot) {
  fs.mkdirSync(runtimeDir(wsRoot), { recursive: true });
}

/** 写一次心跳。返回 {ok}；失败绝不影响服务启动。 */
export function heartbeat(wsRoot, info = {}, { fsMod = fs } = {}) {
  try {
    ensureDir(wsRoot);
    const row = {
      pid: Number(info.pid) || process.pid,
      version: String(info.version || ""),
      port: Number(info.port) || 0,
      ownsPort: !!info.ownsPort,
      startedAt: info.startedAt || new Date().toISOString(),
      at: new Date().toISOString(),
      node: process.version,
    };
    atomicWriteText(instancePath(wsRoot, row.pid), JSON.stringify(row, null, 2));
    return { ok: true, row };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}

/** 还活着的实例（按心跳新鲜度判定）。`samePid` 用来把自己排除掉。 */
export function liveInstances(wsRoot, { now = Date.now(), staleMs = HEARTBEAT_STALE_MS, fsMod = fs } = {}) {
  let files = [];
  try { files = fsMod.readdirSync(runtimeDir(wsRoot)).filter((f) => f.startsWith("实例-") && f.endsWith(".json")); } catch { return [] }
  const out = [];
  for (const f of files) {
    const full = path.join(runtimeDir(wsRoot), f);
    try {
      const row = JSON.parse(fsMod.readFileSync(full, "utf8"));
      const age = now - new Date(row.at).getTime();
      if (!(age <= staleMs)) { try { fsMod.unlinkSync(full) } catch {} continue }   // 顺手清掉死掉的登记
      out.push({ ...row, ageMs: age });
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => (Number(b.ownsPort) - Number(a.ownsPort)) || (a.ageMs - b.ageMs));
}

/** 谁在持有端口（心跳里标了 ownsPort 的那个）。 */
export function portOwner(wsRoot, opts) {
  return liveInstances(wsRoot, opts).find((x) => x.ownsPort) || null;
}

/** 启动事实（机器可读）：版本、是否被判为重复、定时器挂没挂上、端口归属。 */
export function recordStartup(wsRoot, record = {}, { fsMod = fs } = {}) {
  try {
    ensureDir(wsRoot);
    const row = { at: new Date().toISOString(), pid: process.pid, node: process.version, ...record };
    fsMod.appendFileSync(startupLogPath(wsRoot), JSON.stringify(row) + "\n", "utf8");
    // 只留最近 N 条
    try {
      const lines = fsMod.readFileSync(startupLogPath(wsRoot), "utf8").split("\n").filter(Boolean);
      if (lines.length > MAX_STARTUPS) atomicWriteText(startupLogPath(wsRoot), lines.slice(-MAX_STARTUPS).join("\n") + "\n");
    } catch { /* 压缩失败不影响 */ }
    return { ok: true, row };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}

export function recentStartups(wsRoot, { limit = 20, fsMod = fs } = {}) {
  try {
    return fsMod.readFileSync(startupLogPath(wsRoot), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).slice(-limit).reverse();
  } catch { return [] }
}

/**
 * 启动自检：给出"现在有几份在跑、谁持有端口、这份该不该继续"。
 * 只做判断，不做处置（杀进程这类事绝不由它决定）。
 */
export function selfCheck(wsRoot, { myPid = process.pid, myVersion = "", now = Date.now(), fsMod = fs } = {}) {
  const others = liveInstances(wsRoot, { now, fsMod }).filter((x) => x.pid !== myPid);
  const owner = others.find((x) => x.ownsPort) || null;
  const sameVersion = !!owner && !!myVersion && owner.version === myVersion;
  return {
    others,
    owner,
    duplicate: sameVersion,
    note: !owner
      ? "没有别的实例在服务，这份可以正常启动"
      : sameVersion
        ? `已有同版本实例（pid ${owner.pid}）在服务 8787：这份是重复实例`
        : `已有实例（pid ${owner.pid}，版本 ${owner.version || "未知"}）在服务 8787：这份版本是 ${myVersion}`,
  };
}
