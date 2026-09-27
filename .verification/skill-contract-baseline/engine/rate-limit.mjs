// engine/rate-limit.mjs —— 轻量滑动窗口限速（2026-08-29）
// 动机：元枢公网暴露（兼容域名 pi.myxinyu.xin），模型转发/文件上传接口无限速=钱包与磁盘裸奔。
// 设计：进程内滑动窗口计数器，5 分钟全量清扫防内存膨胀。单进程部署足够（不上 redis）。
const buckets = new Map(); // key -> timestamps[]
let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < 300000) return; // 5 分钟扫一次过期 key
  lastSweep = now;
  for (const [k, arr] of buckets) {
    const alive = arr.filter((t) => now - t < 3600000);
    if (alive.length) buckets.set(k, alive);
    else buckets.delete(k);
  }
}

/**
 * 滑动窗口限速。
 * @param {string} key 限速主体（如 "chat:<token 前 40 字符>" 或 "upload:<ip>"）
 * @param {number} limit 窗口内最大次数
 * @param {number} windowMs 窗口毫秒（默认 60s）
 * @returns {boolean} true=放行 false=超限
 */
export function rateLimit(key, limit, windowMs = 60000) {
  const now = Date.now();
  sweep(now);
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

/** 从请求提取限速主体：优先认证 token，退化到客户端 IP */
export function rateLimitKey(req, channel) {
  const auth = String(req.headers?.authorization || "");
  const ip = req.socket?.remoteAddress || "anon";
  return `${channel}:${auth.slice(0, 48)}|${ip}`;
}
