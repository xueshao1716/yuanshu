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
    // 撞密钥墙：每次命令不同（换路径、换 shell），上面的指纹都抓不住
    secret: /凭据由宿主代持|禁止回显\/导出\/读取 API 密钥/.test(text),
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
  // 2026-11-18：一轮里翻 310 次工具、撞 27 次密钥墙都没停（每次命令都不一样）。
  // 撞墙 3 次提醒，6 次中断：密钥文件不会因为换个路径就能读到。
  const secretHits = list.filter((e) => e.secret).length;
  if (list.at(-1)?.secret && secretHits >= 3) {
    const hard = secretHits >= 6;
    return { hint: `已第 ${secretHits} 次去找密钥文件被拦。密钥文件你读不到，换路径也一样。测模型通不通用 check_model；其余照已有结果交付，说明还缺什么。`, soft: !hard };
  }
  if (isSameToolErrors(list)) {
    // 前 4~5 次只提醒（提示会拼进工具结果让模型自纠），连错 6 次才真正中断，避免一次校验误差就把整轮任务杀掉。
    const hard = isSameToolErrors(list, 6);
    return { hint: `同一工具连续失败 ${hard ? 6 : 4} 次。换工具或改参数，不要继续重试相同失败。`, soft: !hard };
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

function isSameToolErrors(events, n = 4) {
  if (events.length < n) return false;
  const last = events.slice(-n);
  return last.every((e) => e.err && e.nameFp === last[0].nameFp);
}
