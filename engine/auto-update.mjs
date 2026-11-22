// ===== auto-update.mjs —— 小更新静默装，大更新才提醒（2026-11-23）=====
//
// 更新太勤（一天好几版），每版都弹「发现新版本」，有用户嫌烦。
// 现在：发版时用 `npm run version:bump <...> --notify` 把这一版标成「要提醒」，
// version.json 里记 notify = 最近一个要提醒的版本号。
//   远端 notify 比本机版本新 → 中间夹着大更新 → 照旧弹窗，让用户自己点
//   否则 → 小更新：电脑端空闲时自动拉取并重启，页面无感刷新；手机 App 不弹窗，只在「更多」里给个入口
// 读不到远端 version.json 时当「要提醒」处理（宁可多问一次，也不悄悄动用户的东西）。
import { compareVersions } from "./app-release.mjs";

const META_URLS = [
  "https://gitee.com/linxinyu520xue/yuanshu/raw/main/version.json",
  "https://raw.githubusercontent.com/xueshao1716/yuanshu/main/version.json",
];

/** 远端 version.json：{ version, notify }；都读不到就 null */
export async function fetchRemoteMeta(fetchImpl = fetch, urls = META_URLS) {
  for (const url of urls) {
    try {
      const resp = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "yuanshu" } });
      if (!resp.ok) continue;
      const d = await resp.json();
      const version = String(d?.version || "");
      if (!/^\d+\.\d+\.\d+/.test(version)) continue;
      return { version, notify: /^\d+\.\d+\.\d+/.test(String(d?.notify || "")) ? String(d.notify) : "" };
    } catch {}
  }
  return null;
}

/** 本机 → 远端之间有没有标了「要提醒」的版本。meta 为空（读不到）按要提醒算。 */
export function isImportant(localVersion, meta) {
  if (!meta) return true;
  if (!localVersion) return true;
  return !!meta.notify && compareVersions(meta.notify, localVersion) > 0;
}

/**
 * 后台定时检查，小更新在空闲时自动装。依赖全部注入，便于测试：
 *   check()   → checkUpdate 的结果（带 important）
 *   apply()   → 执行更新并安排重启，返回 { ok, error? }
 *   isIdle()  → 现在能不能重启（没有对话在跑、最近一段时间没人用）
 *   dirty()   → 源码目录有没有未提交改动（开发机不自动拉）
 */
export function createAutoUpdater({ check, apply, isIdle, dirty = async () => false, log = () => {},
  env = process.env, retryMs = 2 * 60_000 } = {}) {
  let busy = false;
  let pending = null; // 已确认要装、在等空闲
  async function tick() {
    if (env.YUANSHU_AUTO_UPDATE === "0") return { skipped: "disabled" };
    if (busy) return { skipped: "busy" };
    busy = true;
    try {
      if (!pending) {
        const r = await check();
        if (!r?.ok || r.upToDate) return { skipped: "up-to-date" };
        // 只在「确实落后」时自动装；分叉/未知交给人（分叉时 apply 会 reset，不能悄悄做）
        if (r.relation !== "behind") return { skipped: "relation-" + (r.relation || "unknown") };
        if (r.important) return { skipped: "important" };
        if (await dirty()) return { skipped: "dirty" };
        pending = r;
      }
      if (!isIdle()) return { skipped: "not-idle", retryMs };
      const target = pending;
      pending = null;
      log(`[自动更新] 空闲，开始静默更新到 ${target.remoteVersion || target.remote?.sha || "新版"}`);
      const res = await apply();
      if (!res?.ok) log(`[自动更新] 失败：${res?.error || "未知原因"}`);
      return { applied: !!res?.ok, error: res?.error };
    } catch (e) {
      log(`[自动更新] 检查出错：${e?.message || e}`);
      return { skipped: "error" };
    } finally { busy = false; }
  }
  return { tick, get pending() { return pending } };
}

/** 用一个假的 res 调现有的 /api/update/apply 处理器，拿回它写出的 JSON */
export async function applyViaHandler(handler, body = {}) {
  let code = 0, text = "";
  const res = { writeHead(c) { code = c; return res; }, setHeader() {}, end(s) { text = String(s || ""); } };
  await handler(res, body);
  let data = {};
  try { data = JSON.parse(text); } catch {}
  return code === 200 && data.ok ? { ok: true, message: data.message } : { ok: false, error: data.error || `HTTP ${code}` };
}

/** checkUpdate 结果补上 remoteVersion / important（两个请求并行，不拖慢检查） */
export async function checkWithImportance(checkUpdate, localVersion, fetchImpl = fetch) {
  const [r, meta] = await Promise.all([checkUpdate(), fetchRemoteMeta(fetchImpl)]);
  if (!r || typeof r !== "object") return r;
  return { ...r, remoteVersion: meta?.version || "", important: isImportant(localVersion, meta) };
}

/** 空闲：没有对话在跑，且最近 idleMs 内没有对话开始/结束 */
export function runsIdle(runs, { now = Date.now(), idleMs = 10 * 60_000 } = {}) {
  const TERMINAL = ["completed", "failed", "stopped", "interrupted"];
  for (const r of runs || []) {
    if (!r) continue;
    if (!TERMINAL.includes(String(r.status))) return false;
    const at = Date.parse(String(r.updatedAt || r.finishedAt || r.startedAt || ""));
    if (Number.isFinite(at) && now - at < idleMs) return false;
  }
  return true;
}
