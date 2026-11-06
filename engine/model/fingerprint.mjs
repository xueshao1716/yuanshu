// ===== model-fingerprint.mjs —— 记录服务端回的真实模型标识（2026-10-28）=====
//
// 起因：用户收到平台提示「旧指纹 e72d3c7f… 新指纹 bc19ba97…」——模型名没变，背后快照换了。
// 这种变化会让行为静默漂移（"今天怎么变笨了"就对上），而我们一条记录都没有，无法归因。
//
// 事实：请求发的是 `deepseek-flash`，响应体里的 `model` 字段会回**实际服务的版本串**
// （常常带日期/快照后缀），那就是可记录的指纹。
//
// 这里只做三件事：记下每个 (provider + 请求名) 最近一次服务端回的标识；变化时留历史 + 报警；
// 提供查询给面板/接口。文件：记忆/运行时/模型指纹.json
import fs from "node:fs";
import path from "node:path";

export const FP_REL = path.join("记忆", "运行时", "模型指纹.json");
const MAX_HISTORY = 300;

const fileOf = (ws) => path.join(String(ws || "."), FP_REL);

export function readFingerprints(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), "utf8"));
    if (raw && typeof raw === "object" && raw.models && typeof raw.models === "object") return raw;
  } catch {}
  return { v: 1, models: {}, history: [] };
}

function writeFingerprints(wsRoot, data) {
  try {
    fs.mkdirSync(path.dirname(fileOf(wsRoot)), { recursive: true });
    fs.writeFileSync(fileOf(wsRoot), JSON.stringify({ ...data, v: 1, updatedAt: Date.now() }, null, 2), "utf8");
    return true;
  } catch { return false }
}

/**
 * 记一次"服务端实际回的模型标识"。
 * @returns {{changed:boolean, from?:string, to?:string, first?:boolean}}
 */
export function noteFingerprint({ wsRoot, provider = "", requested = "", served = "", at = Date.now() } = {}) {
  const p = String(provider || "").slice(0, 40);
  const req = String(requested || "").slice(0, 80);
  const got = String(served || "").trim();
  if (!req || !got) return { changed: false };
  const key = `${p}/${req}`;
  const data = readFingerprints(wsRoot);
  const prev = data.models[key];
  if (!prev) {
    data.models[key] = { provider: p, requested: req, served: got, firstAt: at, lastAt: at, changes: 0 };
    writeFingerprints(wsRoot, data);
    return { changed: false, first: true, to: got };
  }
  prev.lastAt = at;
  if (prev.served === got) {
    writeFingerprints(wsRoot, data);
    return { changed: false };
  }
  const from = prev.served;
  prev.served = got;
  prev.changes = (Number(prev.changes) || 0) + 1;
  data.history = [{ key, provider: p, requested: req, from, to: got, at }, ...(data.history || [])].slice(0, MAX_HISTORY);
  writeFingerprints(wsRoot, data);
  return { changed: true, from, to: got };
}

export function listFingerprints(wsRoot, { limit = 50 } = {}) {
  const data = readFingerprints(wsRoot);
  return {
    models: Object.values(data.models || {}),
    history: (data.history || []).slice(0, Math.max(1, limit)),
  };
}

/** 面板一行摘要：只有真发生过变化才说。 */
export function fingerprintLine(wsRoot, { windowDays = 7, now = Date.now() } = {}) {
  const data = readFingerprints(wsRoot);
  const recent = (data.history || []).filter((h) => now - Number(h.at || 0) <= windowDays * 86400_000);
  if (!recent.length) return "";
  const head = recent.slice(0, 2).map((h) => `${h.requested}：${String(h.from).slice(-12)} → ${String(h.to).slice(-12)}`).join("；");
  return `【模型指纹】近 ${windowDays} 天有 ${recent.length} 次服务端快照变化：${head}——行为若有漂移，多半跟这个有关。`;
}
