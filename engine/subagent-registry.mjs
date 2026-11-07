// engine/subagent-registry.mjs —— 后台子代理的登记表落盘（2026-11-07）
//
// 为什么单独落一份：`/api/subagent/continue` 要能"接着干"，就必须知道
// 它原来在做什么、给过什么上下文、上一轮结论是什么——这些不在 traces 里
// （traces 只留脱敏摘要，且 task 上限 1000 字），所以另存一张有界的登记表。
//
// 位置与 mailbox/job-pool 同一套约定：`<ws>/记忆/运行时/子代理.json`。
// 写盘一律整份替换（60 条上限 + 体积兜底裁剪，见 subagent-state.pruneRecords），
// 不做增量追加——这层的记录本来就只有几十条，整份写更不容易写坏。
import fs from "node:fs";
import path from "node:path";
import { pruneRecords } from "./subagent-state.mjs";

export const SUBAGENT_STATE_REL = path.join("记忆", "运行时", "子代理.json");
export const KEEP_RECORDS = 60;
const MAX_BYTES = 900_000;

export function subagentStateFile(wsRoot) {
  return path.join(String(wsRoot || "."), SUBAGENT_STATE_REL);
}

/** 读登记表；文件坏了当空处理（子代理记录不是关键数据，不能因为它起不来）。 */
export function readSubagentRegistry(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(subagentStateFile(wsRoot), "utf8"));
    if (raw && Array.isArray(raw.items)) return raw.items.filter((item) => item && item.id);
  } catch { /* 缺失/损坏都当空表 */ }
  return [];
}

/**
 * 整份写回。
 * @returns {{ok:boolean, count:number, error?:string}}
 */
export function writeSubagentRegistry(wsRoot, items = [], { keep = KEEP_RECORDS, maxBytes = MAX_BYTES } = {}) {
  const pruned = pruneRecords(items, { keep, maxBytes });
  try {
    const file = subagentStateFile(wsRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, updatedAt: Date.now(), items: pruned }, null, 2), "utf8");
    return { ok: true, count: pruned.length };
  } catch (error) {
    return { ok: false, count: 0, error: String(error?.message || error).slice(0, 160) };
  }
}
