// ===== engine/rate-limit.mjs —— 限流与认证失败锁定（2026-11-13 公网暴露加固）=====
//
// 两代东西并存，别混：
//   ① 老的 rateLimit()/rateLimitKey()：滑动窗口，被 /api/chat 与上传接口直接调用，行为不动；
//   ② 新的 createRateLimiter()：令牌桶 + 预认证预算 + 失败锁定，交给 server.mjs 的请求闸用。
//
// 新闸的三层（顺序不能反）：
//   鉴权前 preAuth()      —— 没带任何凭据的请求先扣「预认证预算」30/分钟/IP，挡扫描；
//                            带凭据的请求不扣，交给 checkAuth 判。
//   鉴权失败 chargeAuthFailure() —— 同一个 IP 连续错 5 次 → 锁 15 分钟，回 429 + retryAfter；
//                            鉴权成功 authSuccess() 清零。
//   鉴权通过 check()      —— 按 ip + 路由类别扣令牌桶：/api/chat 20/分钟、/api/*/stream 10/分钟、
//                            其它 /api/* 120/分钟。
//
// 约定：
//   - 本机回环默认豁免（127.0.0.1 / ::1 / 127.x），可用 exemptLoopback:false 关掉；
//   - 配置 `记忆/运行时/限流.json` 可缺省，缺省=默认值；enabled:false 一键关（测试/排障用）；
//   - 所有时钟可注入（now），单测不 sleep；
//   - 命中写 `记忆/运行时/限流命中.jsonl`，最多保留 2000 行；
//   - 任何限流逻辑都不许把正常请求打挂：写日志失败只吞掉。
import fs from "node:fs";
import path from "node:path";

// ── 老接口（保持原样，调用点零改动）────────────────────────────────
const legacyBuckets = new Map(); // key -> timestamps[]
let legacyLastSweep = Date.now();

function legacySweep(now) {
  if (now - legacyLastSweep < 300000) return; // 5 分钟扫一次过期 key
  legacyLastSweep = now;
  for (const [k, arr] of legacyBuckets) {
    const alive = arr.filter((t) => now - t < 3600000);
    if (alive.length) legacyBuckets.set(k, alive);
    else legacyBuckets.delete(k);
  }
}

/**
 * 滑动窗口限速（老接口）。
 * @param {string} key 限速主体
 * @param {number} limit 窗口内最大次数
 * @param {number} windowMs 窗口毫秒（默认 60s）
 * @returns {boolean} true=放行 false=超限
 */
export function rateLimit(key, limit, windowMs = 60000) {
  const now = Date.now();
  legacySweep(now);
  const arr = (legacyBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    legacyBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  legacyBuckets.set(key, arr);
  return true;
}

/** 从请求提取限速主体（老接口）：优先认证 token，退化到客户端 IP */
export function rateLimitKey(req, channel) {
  const auth = String(req.headers?.authorization || "");
  const ip = req.socket?.remoteAddress || "anon";
  return `${channel}:${auth.slice(0, 48)}|${ip}`;
}

// ── 新闸：常量与默认配置 ─────────────────────────────────────────
export const RATE_LIMIT_CONFIG_REL = path.join("记忆", "运行时", "限流.json");
export const RATE_LIMIT_HIT_LOG_REL = path.join("记忆", "运行时", "限流命中.jsonl");
export const HIT_LOG_MAX_LINES = 2000;
export const HIT_LOG_TRIM_TO = 1800;
export const BUCKET_CAP = 50000;
export const AUTH_STATE_CAP = 20000;

export const DEFAULT_RATE_LIMIT_CONFIG = Object.freeze({
  enabled: true,
  exemptLoopback: true,
  preAuth: { limit: 30, windowMs: 60000 },
  routes: {
    chat: { limit: 20, windowMs: 60000 },
    stream: { limit: 10, windowMs: 60000 },
    api: { limit: 120, windowMs: 60000 },
  },
  lockout: { failures: 5, windowMs: 900000, lockMs: 900000 },
});

const clampInt = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

function normalizeSpec(raw, fallback) {
  const limit = Number(raw?.limit);
  const windowMs = Number(raw?.windowMs);
  return {
    // 桶参数写坏（负数/NaN/离谱值）一律回默认——不能把 /api/chat 悄悄限成 1/分钟
    limit: Number.isFinite(limit) && limit >= 1 && limit <= 100000 ? Math.trunc(limit) : fallback.limit,
    windowMs: Number.isFinite(windowMs) && windowMs >= 1000 && windowMs <= 86400000 ? Math.trunc(windowMs) : fallback.windowMs,
  };
}

/** 把用户给的（可能残缺/写错的）配置补成完整配置；坏值回默认，绝不抛。 */
export function normalizeRateLimitConfig(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_RATE_LIMIT_CONFIG;
  return {
    enabled: src.enabled !== false,
    exemptLoopback: src.exemptLoopback !== false,
    preAuth: normalizeSpec(src.preAuth, d.preAuth),
    routes: {
      chat: normalizeSpec(src.routes?.chat, d.routes.chat),
      stream: normalizeSpec(src.routes?.stream, d.routes.stream),
      api: normalizeSpec(src.routes?.api, d.routes.api),
    },
    lockout: {
      failures: clampInt(src.lockout?.failures, d.lockout.failures, 1, 1000),
      windowMs: clampInt(src.lockout?.windowMs, d.lockout.windowMs, 1000, 86400000),
      lockMs: clampInt(src.lockout?.lockMs, d.lockout.lockMs, 1000, 86400000),
    },
  };
}

/**
 * 读 `记忆/运行时/限流.json`。缺失=默认值且不算错；JSON 坏=默认值 + error（不静默关限流）。
 * @returns {{config:object, file:string, present:boolean, error:string}}
 */
export function loadRateLimitConfig(wsRoot, { readFileSync = fs.readFileSync } = {}) {
  const file = path.join(String(wsRoot || "."), RATE_LIMIT_CONFIG_REL);
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return { config: normalizeRateLimitConfig({}), file, present: false, error: "" }; }
  try {
    return { config: normalizeRateLimitConfig(JSON.parse(raw)), file, present: true, error: "" };
  } catch (e) {
    return { config: normalizeRateLimitConfig({}), file, present: true, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 回环判定：127.0.0.0/8、::1、以及 IPv4-mapped 写法。 */
export function isLoopbackAddress(ip) {
  const text = String(ip || "").trim().replace(/^::ffff:/i, "");
  if (!text) return false;
  if (text === "::1" || text === "localhost") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text);
}

/**
 * 路由类别：stream（路径以 /stream 结尾，独立 10/分钟）> chat（/api/chat，20/分钟）> api（其余 120/分钟）。
 * 非 /api/* 返回 null（静态资源/页面不走限流）。
 */
export function classifyRoute(pathname) {
  const p = String(pathname || "");
  if (!p.startsWith("/api/")) return null;
  if (/\/stream$/.test(p)) return "stream";
  if (p === "/api/chat") return "chat";
  return "api";
}

// ── 令牌桶（可注入时钟）──────────────────────────────────────────
function createBucketStore() {
  const buckets = new Map(); // key -> { tokens, at }
  let lastSweep = 0;

  function sweep(now) {
    if (buckets.size > BUCKET_CAP) { buckets.clear(); lastSweep = now; return; }
    if (now - lastSweep < 300000) return;
    lastSweep = now;
    for (const [key, b] of buckets) if (now - b.at > 3600000) buckets.delete(key);
  }

  function take(key, spec, now) {
    sweep(now);
    const rate = spec.limit / spec.windowMs; // token / ms
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: spec.limit, at: now };
      buckets.set(key, b);
    } else {
      const elapsed = Math.max(0, now - b.at);
      if (elapsed > 0) b.tokens = Math.min(spec.limit, b.tokens + elapsed * rate);
      b.at = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, remaining: Math.floor(b.tokens), limit: spec.limit, retryAfter: 0 };
    }
    const waitMs = ((1 - b.tokens) * spec.windowMs) / spec.limit;
    return { ok: false, remaining: 0, limit: spec.limit, retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  return { take, size: () => buckets.size, clear: () => buckets.clear() };
}

const toSeconds = (ms) => Math.max(1, Math.ceil(Number(ms || 0) / 1000));

function countLines(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text ? text.split(/\r?\n/).filter(Boolean).length : 0;
  } catch { return 0 }
}

/**
 * 创建限流闸。
 * @param {{wsRoot?:string, config?:object, now?:()=>number, logHits?:boolean, hitLogFile?:string, onHit?:(row:object)=>void}} opts
 */
export function createRateLimiter({ wsRoot = "", config = null, now = () => Date.now(), logHits = true, hitLogFile = "", onHit = null } = {}) {
  const loaded = config ? { config: normalizeRateLimitConfig(config), file: "", present: true, error: "" } : loadRateLimitConfig(wsRoot);
  const cfg = loaded.config;
  const routeBuckets = createBucketStore();
  const preBuckets = createBucketStore();
  const authState = new Map(); // ip -> { failures, lastAt, lockedUntil, locks }
  const logFile = hitLogFile || (wsRoot ? path.join(String(wsRoot), RATE_LIMIT_HIT_LOG_REL) : "");
  let lineCount = -1;
  let hitCount = 0;

  const exempt = (ip) => cfg.exemptLoopback && isLoopbackAddress(ip);

  function writeHit(row) {
    hitCount += 1;
    if (logHits && logFile) {
      try {
        if (lineCount < 0) lineCount = countLines(logFile);
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf8");
        lineCount += 1;
        if (lineCount > HIT_LOG_MAX_LINES) {
          const rows = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean).slice(-HIT_LOG_TRIM_TO);
          fs.writeFileSync(logFile, `${rows.join("\n")}\n`, "utf8");
          lineCount = rows.length;
        }
      } catch { /* 日志失败不影响拦截本身 */ }
    }
    try { onHit?.(row); } catch {}
  }

  function hit({ ip, pathname, method, category, reason, retryAfter, limit }) {
    writeHit({
      at: new Date(now()).toISOString(),
      ip: String(ip || "unknown").slice(0, 64),
      method: String(method || "").slice(0, 8),
      path: String(pathname || "").slice(0, 200),
      category: String(category || ""),
      reason: String(reason || ""),
      retryAfter: clampInt(retryAfter, 0, 0, 86400),
      limit: clampInt(limit, 0, 0, 100000),
    });
  }

  function stateOf(ip, t) {
    // 内存上限：唯一 IP 洪水不能把进程撑爆。先清 1 小时没动静且没在锁里的，仍超就整体失忆。
    if (authState.size >= AUTH_STATE_CAP) {
      for (const [key, s] of authState) {
        if ((!s.lockedUntil || s.lockedUntil <= t) && (!s.lastAt || t - s.lastAt > 3600000)) authState.delete(key);
      }
      if (authState.size >= AUTH_STATE_CAP) authState.clear();
    }
    let s = authState.get(ip);
    if (!s) {
      s = { failures: 0, lastAt: 0, lockedUntil: 0, locks: 0 };
      authState.set(ip, s);
    }
    if (s.lockedUntil && s.lockedUntil <= t) {
      s.lockedUntil = 0; s.failures = 0; s.lastAt = 0; // 锁到期自动解，重新计数
    } else if (!s.lockedUntil && s.failures > 0 && t - s.lastAt > cfg.lockout.windowMs) {
      s.failures = 0; s.lastAt = 0; // 失败窗口过期
    }
    return s;
  }

  function lockedReply(s, ip, t, pathname, method) {
    const retryAfter = toSeconds(s.lockedUntil - t);
    hit({ ip, pathname, method, category: "auth", reason: "auth_locked", retryAfter, limit: cfg.lockout.failures });
    return { ok: false, locked: true, reason: "auth_locked", retryAfter, limit: cfg.lockout.failures, lockedUntil: s.lockedUntil, failures: s.failures };
  }

  /** 鉴权前：锁定检查 + 无凭据连接的预认证预算。 */
  function preAuth(ip, { credential = false, pathname = "", method = "" } = {}) {
    if (!cfg.enabled) return { ok: true, enabled: false };
    if (exempt(ip)) return { ok: true, exempt: true };
    const t = now();
    const s = stateOf(ip, t);
    if (s.lockedUntil > t) return lockedReply(s, ip, t, pathname, method);
    if (credential) return { ok: true, credential: true };
    const b = preBuckets.take(`preauth:${ip}`, cfg.preAuth, t);
    if (b.ok) return { ok: true, remaining: b.remaining, limit: b.limit };
    hit({ ip, pathname, method, category: "preauth", reason: "preauth_budget", retryAfter: b.retryAfter, limit: b.limit });
    return { ok: false, reason: "preauth_budget", retryAfter: b.retryAfter, limit: b.limit, remaining: 0 };
  }

  /** 鉴权失败记账；返回是否已上锁。 */
  function chargeAuthFailure(ip, pathname = "", method = "") {
    if (!cfg.enabled) return { locked: false, enabled: false, failures: 0 };
    if (exempt(ip)) return { locked: false, exempt: true, failures: 0 };
    const t = now();
    const s = stateOf(ip, t);
    if (s.lockedUntil > t) {
      const r = lockedReply(s, ip, t, pathname, method);
      return { locked: true, failures: r.failures, retryAfter: r.retryAfter, lockedUntil: s.lockedUntil, reason: "auth_locked" };
    }
    s.failures += 1;
    s.lastAt = t;
    if (s.failures >= cfg.lockout.failures) {
      s.lockedUntil = t + cfg.lockout.lockMs;
      s.locks += 1;
      s.failures = cfg.lockout.failures;
      const retryAfter = toSeconds(s.lockedUntil - t);
      hit({ ip, pathname, method, category: "auth", reason: "auth_locked", retryAfter, limit: cfg.lockout.failures });
      return { locked: true, failures: s.failures, retryAfter, lockedUntil: s.lockedUntil, reason: "auth_locked" };
    }
    return { locked: false, failures: s.failures, remainingAttempts: cfg.lockout.failures - s.failures, retryAfter: 0 };
  }

  /** 鉴权成功：清掉失败计数（锁已到期时也一并清）。 */
  function authSuccess(ip) {
    if (!ip) return;
    authState.delete(ip);
  }

  /** 鉴权通过后：按 ip + 路由类别扣令牌桶。 */
  function check(ip, pathname, method = "") {
    if (!cfg.enabled) return { ok: true, enabled: false, category: null };
    if (exempt(ip)) return { ok: true, exempt: true, category: null };
    const category = classifyRoute(pathname);
    if (!category) return { ok: true, category: null };
    const spec = cfg.routes[category] || cfg.routes.api;
    const b = routeBuckets.take(`${category}:${ip}`, spec, now());
    if (b.ok) return { ok: true, category, remaining: b.remaining, limit: b.limit };
    hit({ ip, pathname, method, category, reason: "route_budget", retryAfter: b.retryAfter, limit: b.limit });
    return { ok: false, reason: "route_budget", category, retryAfter: b.retryAfter, limit: b.limit, remaining: 0 };
  }

  function status() {
    return {
      enabled: cfg.enabled,
      exemptLoopback: cfg.exemptLoopback,
      hits: hitCount,
      authIPs: authState.size,
      buckets: routeBuckets.size() + preBuckets.size(),
      configFile: loaded.file,
      configPresent: loaded.present,
      configError: loaded.error,
      logFile,
      config: cfg,
    };
  }

  function reset() {
    routeBuckets.clear();
    preBuckets.clear();
    authState.clear();
  }

  return {
    config: cfg,
    enabled: cfg.enabled,
    classify: classifyRoute,
    preAuth,
    chargeAuthFailure,
    authSuccess,
    check,
    status,
    reset,
    hitLogPath: logFile,
  };
}
