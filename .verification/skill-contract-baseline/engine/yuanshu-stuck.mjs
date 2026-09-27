// OpenHands stuck.py 精简版：同一动作观察重复、ABAB 交替、同工具连错。
// 不同文件的连续 read 不算卡住，避免误杀正常勘察。

export function recordStuckEvent(name, args = {}, out = {}) {
  const n = String(name || "");
  const text = String(out?.text || "").replace(/\s+/g, " ").slice(0, 160);
  let argKey = "";
  try { argKey = JSON.stringify(args || {}); } catch { argKey = String(args || ""); }
  return {
    name: n,
    err: out?.isError === true,
    fp: `${n}:${argKey}:${text}`,
    nameFp: n,
  };
}

export function detectStuck(events) {
  const list = Array.isArray(events) ? events : [];
  if (isSameFour(list)) {
    return { hint: "检测到同一工具调用和结果重复 4 次，已卡住。换做法或直接交付，不要再重复。" };
  }
  if (isAbAb(list)) {
    return { hint: "检测到 A/B 交替循环。换做法或直接交付，不要再在这两步之间空转。" };
  }
  if (isSameToolErrors(list)) {
    return { hint: "同一工具连续失败 4 次。换工具或改参数，不要继续重试相同失败。" };
  }
  return null;
}

function isSameFour(events) {
  if (events.length < 4) return false;
  const last = events.slice(-4).map((e) => e.fp);
  return last.every((x) => x === last[0]);
}

function isAbAb(events) {
  if (events.length < 6) return false;
  const last = events.slice(-6).map((e) => e.fp);
  return last[0] === last[2] && last[2] === last[4]
    && last[1] === last[3] && last[3] === last[5]
    && last[0] !== last[1];
}

function isSameToolErrors(events) {
  if (events.length < 4) return false;
  const last = events.slice(-4);
  return last.every((e) => e.err && e.nameFp === last[0].nameFp);
}
