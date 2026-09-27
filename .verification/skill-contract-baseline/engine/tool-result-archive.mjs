// ===== tool-result-archive.mjs —— 被压缩掉的工具结果原件归档 =====
//
// 为什么需要它：`shrinkToolResult` 把超长工具结果砍成头尾，中间段直接丢掉，
// 然后告诉模型"如需完整内容可重新读取"——**却没有给任何指针**。模型无从照做，
// 而报错恰恰常出现在中段（前有 build 输出、后有收尾统计），丢了就是永久丢失。
//
// 这里给每份原件一个**内容寻址**的可读地址：
//   - id = tr_ + sha256(原文) 前 24 位 → 同一份内容永远同一个 id（反复投影稳定）
//   - 落盘一次，重复投影只做校验，不重写
//   - 指针是**可执行的**：给出绝对路径 + 一条现成的读取命令，模型用已有工具就能回读
//
// 设计上借了 NVlabs/SoL-Pi 的 ObservationPack 几个细节：拒符号链接、O_EXCL 创建、
// 复用既有对象前逐字节校验 size + hash（防半截写入/被篡改的归档冒充原件）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

let _root = "";

// 传 root 启用；不传（或传空）则关闭归档——关闭时压缩会**如实说明"未归档"**，
// 而不是继续写"如需完整内容可重新读取"这种做不到的话。
export function initToolResultArchive({ root = "" } = {}) {
  _root = String(root || "");
}

/** 默认落点：agent 目录下（与 RUNS_DIR 同级，不进用户工作区、不污染生成物）。 */
export function defaultToolResultArchiveRoot() {
  return path.join(os.homedir(), ".pi", "agent", "yuanshu-tool-results");
}

export function toolResultArchiveRoot() {
  return _root || defaultToolResultArchiveRoot();
}

/** 内容寻址：同一份原文永远得到同一个 id，所以反复投影不会产生一堆重复归档。 */
export function toolResultId(text) {
  return "tr_" + crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 24);
}

export function countTextLines(text) {
  const s = String(text);
  if (!s.length) return 0;
  let lines = s.endsWith("\n") ? 0 : 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) lines++;
  return lines;
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * 归档一份工具结果原件。返回 { id, file, bytes, lines }；归档不可用时返回 null。
 * **绝不因为归档失败而抛异常**——压缩本身不能把主流程带崩，但也绝不假装归档成功。
 */
export function archiveToolResult(text) {
  const root = _root;
  if (!root) return null;
  const s = String(text);
  const id = toolResultId(s);
  const bytes = Buffer.byteLength(s, "utf8");
  const lines = countTextLines(s);
  const file = path.join(root, `${id}.txt`);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      // 复用前校验：不是普通文件（含符号链接）或 size/hash 对不上，就当作不可信。
      // 宁可归档失败也不能让一个对不上号的副本冒充原件——那比没有归档更危险。
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink()) return null;
      if (st.size !== bytes) return null;
      if (sha256(fs.readFileSync(file, "utf8")) !== sha256(s)) return null;
      return { id, file, bytes, lines };
    }
    // wx = O_CREAT | O_EXCL | O_WRONLY：并发/重入时不会互相覆盖
    fs.writeFileSync(file, s, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const written = fs.statSync(file);
    if (!written.isFile() || written.size !== bytes) return null;
    return { id, file, bytes, lines };
  } catch {
    return null;
  }
}

/** 供测试/清理用：按 id 解析归档路径（拒绝越界 id）。 */
export function toolResultArchivePath(id) {
  if (!/^tr_[a-f0-9]{24}$/.test(String(id || ""))) return "";
  return path.join(toolResultArchiveRoot(), `${id}.txt`);
}
