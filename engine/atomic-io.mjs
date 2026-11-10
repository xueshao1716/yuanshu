// engine/atomic-io.mjs —— 原子写盘（2026-08-25，Odysseus atomic_io 路线）
// 会话/记忆/配置等状态文件：先写临时文件再 rename 替换。
// 进程崩溃/磁盘满/并发写都不会留下半截 JSON（损坏时报错而非静默清空重建）。

import fs from "node:fs";
import path from "node:path";

export function atomicWriteText(p, content, fsMod = fs) {
  const dir = path.dirname(p);
  fsMod.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.tmp-${process.pid}-${Date.now()}`);
  fsMod.writeFileSync(tmp, content, "utf8");
  try {
    fsMod.renameSync(tmp, p);
  } catch (e) {
    // rename 失败清理临时文件，原文件不受影响
    try { fsMod.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// 2026-11-10 P1：值没变就不落盘（收轮"合并写盘"的判据）。
// 关系/基因/成长/账本这类状态文件每轮都会被 save() 调一次；内容一字节没变时
// 再做 mkdir + 临时文件 + rename 纯属空转（Windows 上一次原子写是三次系统调用）。
// 判据是**序列化后的完整内容**与磁盘现有内容逐字相等，不是字段白名单——
// 任何真实变化（含 updatedAt/interactions/evidence.turns）都照写，不会漏状态。
// 超过 1MB 的文件不做比较（读一遍比写还贵，且大文件基本都在变）。
const DEDUP_MAX_BYTES = 1024 * 1024;
let jsonWrites = 0;
let jsonSkipped = 0;

/** 收尾观测用：本进程一共写了多少次 JSON、跳过多少次"内容没变"的空写。 */
export function jsonWriteStats() {
  return { writes: jsonWrites, skipped: jsonSkipped };
}

export function atomicWriteJson(p, obj, fsMod = fs) {
  const content = JSON.stringify(obj, null, 2);
  try {
    if (typeof fsMod?.statSync === "function" && typeof fsMod?.readFileSync === "function") {
      const st = fsMod.statSync(p);
      if (st && Number(st.size) <= DEDUP_MAX_BYTES && fsMod.readFileSync(p, "utf8") === content) {
        jsonSkipped++;
        return false;
      }
    }
  } catch {} // 文件不存在/读不了 → 照常写（与旧行为一致）
  atomicWriteText(p, content, fsMod);
  jsonWrites++;
  return true;
}
