// ===== turn-memory.mjs —— 对话收尾的记忆结算（引擎无关）=====
//
// 流水账 / 承诺 / 纠正 / 关系 / 每-N-轮快照计数都归这里。
//
// 为什么单独成模块：这段逻辑原先只写在 server.mjs 的 Pi 分支 try 里，而 Pi 分支
// 位于 `handleChat` 的 `return` **之后** → yuanshu(unified) 与 dsh 路径静默不写记忆，
// Pi 失败降级到 unified 时也被一起跳过。而 engine/engine-pair.mjs 的引擎目录声明的
// 恰恰相反（yuanshu：「记忆、出图、规划…都挂在这条上」；pi：「记忆…不在这条循环里长」）
// ——实现与声明是反的。默认主驾是 pi，所以一直能跑，这个缺口才没被发现。
//
// 现在的规矩：**pi 与 yuanshu 都结算，dsh 按它自己声明的边界不结算**。
import fs from "node:fs";
import { extractText } from "./session-utils.mjs";
import { extractPromises, recordPromises } from "./promises.mjs";

/**
 * 只读**本轮新追加**的那段字节里的最后一条助手回复。
 *
 * 为什么不整份回读会话：
 *   ① 中止/报错的轮次也会因为用户消息落盘而让文件变长，只判断"变长了"会把上一轮的
 *      助手回复重复记进记忆；
 *   ② 追加内容恒在文件末尾，按字节偏移切片是常数级开销，不用把整份历史再解析一遍。
 * 偏移落在行中间时首行会解析失败并被跳过——追加写入本身是整行 JSON，正常不会发生。
 */
export function readAppendedAssistantText(file, fromByte, { fsMod = fs, extract = extractText } = {}) {
  try {
    const size = fsMod.statSync(file).size;
    if (!(size > fromByte)) return "";
    const len = size - fromByte;
    const fd = fsMod.openSync(file, "r");
    const buf = Buffer.alloc(len);
    let n = 0;
    try { n = fsMod.readSync(fd, buf, 0, len, fromByte); } finally { fsMod.closeSync(fd); }
    let text = "";
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let e = null;
      try { e = JSON.parse(s); } catch { continue; }
      if (e?.type === "message" && e?.message?.role === "assistant") {
        const t = extract(e.message.content) || "";
        if (t.trim()) text = t;
      }
    }
    return text;
  } catch { return ""; }
}

/** 纠正句式：只认明确纠正，排除寒暄口头语。 */
function matchCorrection(message) {
  const m = String(message || "").match(/(?:别再|不要再|别总是|不要总是|不要这样|别这样|以后别|以后不要|记住(?:别|不要|要)|不要再用|别老用)([^，。,!！?？]{2,40})/);
  if (!m) return "";
  const correction = String(m[1] || "").trim();
  // 排除寒暄/情绪口头语：别闹了、别客气、别急、别担心……不是纠正，不记录
  if (correction.length <= 1) return "";
  if (/闹|客气|急|慌|谢|担心|怕|想太多|介意|不好意思/.test(correction)) return "";
  if (/再犯|纠正/.test(String(message || ""))) return "";
  return correction;
}

/** 关系记忆：用户透露偏好/习惯；排除观点陈述（"我一直觉得…"是想法不是偏好）。 */
function matchRelation(message) {
  const m = String(message || "").match(/(?:我喜欢|我习惯|我偏好|我平时|我更爱|我偏爱)(.{2,30}?)(?:，|,|。|$)/);
  if (!m) return "";
  const detail = String(m[1] || "").trim();
  if (detail.length <= 1) return "";
  if (/^(觉得|认为|感觉|想|希望|想要|打算)/.test(detail)) return "";
  return detail;
}

/**
 * 结算一轮对话的记忆。
 * @returns {{settled:boolean, reason?:string, added?:number}}
 *   settled=false 表示本轮无事可结算（没有会话文件 / 本轮没产出助手回复）。
 *   注意 settled=true **不等于**记忆文件一定变了：是否落笔还取决于信号是否命中
 *   （纯闲聊就不该进流水账）。断言记忆内容请直接看文件。
 */
export async function settleTurnMemory({
  wsRoot, entry, message, sessionId = "", bytesBefore = 0,
  fsMod = fs, now = () => new Date(), log = console.log,
} = {}) {
  try {
    const file = entry?.sm?.sessionFile;
    if (!file) return { settled: false, reason: "无会话文件" };
    const assistLatest = readAppendedAssistantText(file, bytesBefore, { fsMod });
    // 本轮没有产出助手回复（中止/报错）→ 不结算，绝不复用上一轮的文本
    if (!assistLatest) return { settled: false, reason: "本轮无助手回复" };
    const mem = await import("./memory.mjs");
    mem.autoMemorize(wsRoot, { userMsg: message, assistantMsg: assistLatest });
    // 承诺兑现：只提取入库。**结清必须显式**（台前按钮或明确证据），这里不做任何自动判定。
    let added = 0;
    try {
      const found = extractPromises(assistLatest, { at: now(), sessionId });
      if (found.length) {
        const rec = recordPromises(wsRoot, found);
        added = rec?.added || 0;
        if (added) log(`[promises] 新增 ${added} 条待兑现承诺`);
      }
    } catch {}
    const correction = matchCorrection(message);
    if (correction) {
      mem.saveCorrection(wsRoot, { trigger: String(message || "").slice(0, 40), correction: `不要再${correction}` });
    }
    const detail = matchRelation(message);
    if (detail) mem.saveRelation(wsRoot, { aspect: "用户透露", detail });
    // 进化快照：每 20 轮存一份（计数跨引擎共享同一份 .tick，所以是"合计 20 轮"）
    mem.tickSnapshot(wsRoot, 20);
    return { settled: true, added };
  } catch { return { settled: false, reason: "结算异常" }; }
}
