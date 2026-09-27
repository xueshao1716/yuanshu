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

export function atomicWriteJson(p, obj, fsMod = fs) {
  atomicWriteText(p, JSON.stringify(obj, null, 2), fsMod);
}
