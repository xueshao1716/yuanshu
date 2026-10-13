// 记忆库测试夹具：临时 wsRoot 下的 memory-db + vector-store + 假 embedding（零网络）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function createMemoryDbTestHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-mem-"));
  const db = await import("../../../engine/memory-db.mjs");
  const vectors = await import("../../../engine/vector-store.mjs");
  db.initMemoryDb(() => dir);
  vectors.initVectorStore(() => dir);
  const embedding = { configInfo: () => ({ configured: false }) };
  return {
    db, vectors, embedding, dir,
    vectorsLeft: async () => {
      try { return Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "vectors.json"), "utf8")).vectors).length; }
      catch { return 0; }
    },
    close: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } },
  };
}
