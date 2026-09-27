// ══ SDK Provider 注册器（2026-08-27）：把元枢自定义通道接入兼容适配器 agent 体系 ══
// 背景：聊天走 unifiedChat 直发 HTTP（任意 OpenAI 兼容通道都行）；但真 agent 会话（专项工作台/
//       TUI/终端）由 pi SDK 驱动，只认 SDK 原生 provider 表——自定义中转（sensenova/volces/agnes/
//       whatstoken/bigmodel/aliyun 等）不在表内，agent 一律报「No API key found」，只能靠 deepseek
//       兜底（且 deepseek 余额不足时彻底哑火）。
// 方案：启动时把「已配 key + store 有 baseUrl 定义 + SDK 不认识」的 provider 用
//       ModelRuntime.registerProvider 动态注册进去——agent 与聊天同通道、同凭据。
import fs from "node:fs";

export function registerStoreProviders(modelRuntime, { storePath, authPath }) {
  let store = {};
  let auth = {};
  try { store = JSON.parse(fs.readFileSync(storePath, "utf8")) || {}; } catch {}
  try { auth = JSON.parse(fs.readFileSync(authPath, "utf8")) || {}; } catch {}

  // SDK 原生已认识的 provider 不重复注册
  let known = new Set();
  try {
    for (const m of modelRuntime.getModels()) known.add(m.provider);
  } catch {}

  const registered = [];
  for (const [provider, a] of Object.entries(auth)) {
    if (!a?.key || known.has(provider)) continue;
    const cfg = store[provider];
    const rawModels = cfg?.models || [];
    // bigmodel 等自定义通道不提供顶层 baseUrl——从模型定义兜底取（否则注册被 guard 跳过）
    const baseUrl = String(cfg?.baseUrl || a.baseUrl || rawModels[0]?.baseUrl || "").trim();
    const models = rawModels.map(m => ({
      id: m.id,
      name: m.name || m.id,
      reasoning: !!m.reasoning,
      input: Array.isArray(m.input) && m.input.length ? m.input : ["text"],
      cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: m.cost?.cacheWrite ?? 0 },
      contextWindow: m.contextWindow || 128000,
      maxTokens: m.maxTokens || 8192,
      // ⚠️ 必须保留 compat/thinkingLevelMap：缺失会导致流式「Unknown provider」+ 短路兜底
      compat: m.compat,
      thinkingLevelMap: m.thinkingLevelMap,
    })).filter(m => m.id);
    // 只挑有 compat 的代表模型（缺 compat 流式会报「Unknown provider」，注册了反而坏 agent）——
    // 商汤/volces/whatstoken/minimax 等无 compat 通道被跳过，保持原走 unifiedChat 不改默认流程
    const picked = models.filter(m => !/pro/i.test(m.id) && !!m.compat).slice(0, 6);
    if (!picked.length || !baseUrl) {
      console.log(`[sdk-providers] 跳过 ${provider}（无 compat 或无 baseUrl，agent 不可用，聊天仍走 unifiedChat）`);
      continue;
    }

    const api = (cfg.api === "anthropic-messages" || cfg.protocol === "anthropic") ? "anthropic-messages" : "openai-completions";
    // SDK 不做 /v1 补全（聊天适配器会补并 404 回退，这里必须手动对齐 OpenAI 规范：baseUrl 需含版本段）
    let base = baseUrl.replace(/\/+$/, "");
    if (api === "openai-completions" && !/\/v\d+$/.test(base)) base += "/v1";
    try {
      modelRuntime.registerProvider(provider, {
        name: provider,
        baseUrl: base,
        apiKey: a.key,
        api,
        models: picked,
      });
      registered.push(provider);
    } catch (e) {
      console.log(`[sdk-providers] ${provider} 注册失败: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  if (registered.length) console.log(`[元枢] agent 通道扩展注册: ${registered.join(", ")}`);
  return registered;
}
