// engine/embedding.mjs —— 向量化客户端（2026-10-13）
// OpenAI 兼容 /embeddings 协议。配置优先级：
//   {wsRoot}/memory/embedding.json（显式配置）→ pi auth.json 的 zai/zai-coding-cn 凭据（GLM 官方 embedding）。
// 未配置/调用失败向上抛错，由调用方降级（记忆仍建行，vector_id 留空）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let _wsRoot = null;
export function initEmbedding(wsRoot) { _wsRoot = wsRoot; }
function configFile() { return path.join(typeof _wsRoot === "function" ? _wsRoot() : _wsRoot, "memory", "embedding.json"); }

function getConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch { }
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"));
    for (const k of ["zai", "zai-coding-cn"]) {
      const ent = auth[k];
      if (ent?.type === "api_key" && ent.key) {
        return { baseUrl: (ent.baseUrl || "https://api.z.ai/api/paas/v4").replace(/\/+$/, ""), apiKey: ent.key, model: "embedding-3" };
      }
    }
  } catch { }
  return null;
}

/** 文本 → 向量（number[]）。长文本自动截断（embedding 对长度不敏感区即可）。 */
export async function embed(text, { fetch: f = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const cfg = getConfig();
  if (!cfg) throw new Error("embedding 未配置（缺少 memory/embedding.json 且未找到 zai 凭据）");
  const input = String(text || "").trim().slice(0, 4000);
  if (!input) throw new Error("embedding 输入为空");
  const res = await f(`${cfg.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`embedding API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec) || !vec.length) throw new Error("embedding 响应无向量");
  return vec.map(Number);
}

export function configInfo() {
  const cfg = getConfig();
  return cfg ? { configured: true, baseUrl: cfg.baseUrl, model: cfg.model, keyTail: cfg.apiKey.slice(-4) } : { configured: false };
}
