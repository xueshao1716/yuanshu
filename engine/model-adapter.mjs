// ===== model-adapter.mjs —— Gateway 2.0 模型适配器（dsh ModelAdapter 思想沉淀）=====
// 设计：ModelAdapter 接口 = 统一 chat() 入口，把"模型请求 + 思考提取"抽象出来。
//   任何实现（HTTP / SDK / 本地模型）都注册成插件，AgentLoop 只认接口不认厂商。
// 内置：HttpModelAdapter —— OpenAI 兼容 /chat/completions 适配器（deepseek/openai/… 通用）。
//   自动适配：baseUrl 带不带 /v1、reasoning_effort 降级重试、5xx 重试、流式关闭。
// 依赖注入：httpFetch 由宿主注入（元枢注入 httpJsonFetch 以复用系统代理栈），
//   不注入则用 Node 原生 fetch（Node 25+）。
import { normalizeToolArgs, normalizeToolCallArguments } from "./tool-args.mjs";
import { describeHttpError, sessionAffinityHeaders } from "./http.mjs";
import { clampOutputTokens, maxTokensFieldOf } from "./output-budget.mjs";

// ── ModelAdapter 接口契约 ──
// async chat(model, messages, opts) → {
//   text?, think?, history?, error?, aborted?
// }
//   model:    { id, provider, baseUrl?, reasoning?, ... }
//   messages: OpenAI 风格消息数组（含 tool_calls/tool 轮次）
//   opts:     { tools?, onTool?(id,name,args), onToolEnd?(id,name,args,out),
//               signal?, params?{temperature,top_p}, maxTokens? }
//   返回：模型最终回复 { text, think } 或 { error }；history 为完整对话（含工具轮次）

export class HttpModelAdapter {
  constructor(options = {}) {
    this.id = options.id || "http";
    this.name = options.name || "HTTP (OpenAI 兼容)";
    this.version = "1.0.0";
    this.httpFetch = options.httpFetch || defaultHttpFetch;
    this.authReader = options.authReader || (() => ({})); // () => { provider: { key } }
    this.modelReader = options.modelReader || (() => ({})); // () => { provider: { models: [...] } }
    this.resolveAuth = options.resolveAuth || ((provider) => ({})); // (provider) => { baseUrl }
  }

  // 读取模型定义（合并 auth / models-store / 传入 model）
  _modelDef(model) {
    const store = this.modelReader();
    const mdef = (store[model.provider]?.models || []).find((m) => m.id === model.id)
      || null;
    const resolved = this.resolveAuth(model.provider);
    // 2026-09-16：模型定义里的 baseUrl 优先（auth.json 里那份是账号级的，端点可能不同——
    // 真机：auth 是 zen/v1、模型定义是 zen/go/v1，用 auth 那份直接 401 "Model … is not supported"）。
    const baseUrl = mdef?.baseUrl || resolved?.baseUrl || model.baseUrl;
    return { mdef, baseUrl, base: (baseUrl || "").replace(/\/+$/, "") };
  }

  async chat(model, messages, opts = {}) {
    const key = this.authReader()[model.provider]?.key;
    if (!key) return { error: `无 ${model.provider} 的 key` };
    const { mdef, base } = this._modelDef(model);
    if (!base) return { error: `无 ${model.provider} 的 baseUrl` };
    const baseNoV1 = base.endsWith("/v1") ? base.slice(0, -3) : base;

    const history = [...messages];
    // tools 语义归一：false/空 → 不发 tools 字段（2026-08-20 修复：原实现 tools:false 时
    // 仍发 tools:[] + tool_choice:"auto"，严格校验的 API 如 agnes 直接 400）
    const rawTools = opts.tools === false
      ? undefined
      : (Array.isArray(opts.tools) ? opts.tools : (typeof opts.tools?.list === "function" ? opts.tools.list() : opts.tools));
    const toolDefs = rawTools?.length ? rawTools : undefined;
    // 按模型声明的能力统一适配（不按厂商特判）
    const isReasoning = mdef?.reasoning === true || model.reasoning === true;
    const compat = mdef?.compat || model.compat || {};
    const thinkingLevelMap = mdef?.thinkingLevelMap || model.thinkingLevelMap || null;
    let thinkingParam = null;
    if (isReasoning) {
      const mapped = thinkingLevelMap?.["high"];
      if (mapped !== null && mapped !== false && mapped !== undefined) thinkingParam = mapped;
      else if (compat.supportsReasoningEffort !== false) thinkingParam = "high";
    }

    const buildBody = (withThinking) => {
      const body = {
        model: model.id,
        // 最后一道闸（2026-09-16）：不管历史从哪来，发出去之前把 tool_call 的 arguments 都规范成合法对象。
        // 真机事故：一条双重编码的 arguments 让整轮请求 400（code 11133）。
        messages: normalizeToolCallArguments(history),
        ...(toolDefs ? { tools: toolDefs, tool_choice: "auto" } : {}),
        stream: false,
      };
      // 单次输出预算同样按模型声明给（以前写死 8192，一条大文件的工具调用必被截断）
      body[maxTokensFieldOf(compat)] = clampOutputTokens(mdef, { fallback: Number(opts.maxTokens) || undefined });
      if (opts.params) {
        if (typeof opts.params.temperature === "number" && opts.params.temperature >= 0 && opts.params.temperature <= 1) body.temperature = opts.params.temperature;
        if (typeof opts.params.top_p === "number" && opts.params.top_p > 0 && opts.params.top_p <= 1) body.top_p = opts.params.top_p;
      }
      if (withThinking && thinkingParam !== null) body.reasoning_effort = thinkingParam;
      return body;
    };

    const mkReq = (u, withThinking) => this.httpFetch(u, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...sessionAffinityHeaders({ provider: model.provider, compat, sessionId: opts.sessionId }),
      },
      body: JSON.stringify(buildBody(withThinking)),
      timeout: opts.timeout || 300000,
    });

    let usedThinking = thinkingParam !== null;
    let turn = 0;
    while (turn < 20) {
      turn++;
      if (opts.signal?.aborted) return { aborted: true };
      let r;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          r = await mkReq(`${baseNoV1}/v1/chat/completions`, usedThinking);
          if (r.status === 404) r = await mkReq(`${baseNoV1}/chat/completions`, usedThinking);
          if (!r.ok && r.status >= 500 && attempt === 0) { await sleep(1500); continue; }
          break;
        } catch (e) {
          if (attempt === 0 && !/timeout/i.test(String(e?.message || ""))) { await sleep(1500); continue; }
          throw e;
        }
      }
      // 模型不接受 reasoning_effort → 去掉重试（统一降级）
      if (!r.ok && usedThinking && (r.status === 400 || r.status === 422)) {
        usedThinking = false;
        r = await mkReq(`${baseNoV1}/v1/chat/completions`, false);
        if (r.status === 404) r = await mkReq(`${baseNoV1}/chat/completions`, false);
      }
      if (!r.ok) {
        const errBody = await r.text().catch(() => "");
        // 用 describeHttpError：把 msg / displayMsg.zh / extError.code 摘出来（原来只留 150 字，正好截在关键处）
        return { error: `HTTP ${r.status}: ${describeHttpError(errBody)}` };
      }
      const data = await r.json();
      const msg = data.choices?.[0]?.message || {};
      return extractModelReply(msg, history);
    }
    return { error: "模型调用超过 20 轮，已停止" };
  }
}

// 从模型消息里提取 { think, text } 并返回历史（供 loop 继续）
// ⚠️ 2026-08-22 修复：tool_calls 必须消毒后再入历史——上游可能返回缺 function/空 name 的坏条目
//   （mimo 实测：特定提示词稳定触发），原样回传下轮请求 → 上游 400 "`function` is not set"。
//   与 unified-chat.sanitizeToolCalls 同策略：能修补则修补（补 arguments 默认值），缺 function/name 的剔除；
//   全被剔除则降级为纯文本回复。
function sanitizeTcsLocal(tcs) {
  if (!Array.isArray(tcs)) return [];
  return tcs
    .filter(tc => tc && typeof tc === "object" && tc.id && tc.function && typeof tc.function === "object" && tc.function.name)
    // 2026-09-16：arguments 统一规范化（双重编码 / 非对象 / 非法 JSON 都会被上游 400 拒绝，见 engine/tool-args.mjs）
    .map(tc => ({ id: tc.id, type: "function", function: { name: tc.function.name, arguments: normalizeToolArgs(tc.function.arguments) } }));
}
export function extractModelReply(msg, history) {
  const raw = msg.tool_calls;
  const tcs = raw && raw.length ? sanitizeTcsLocal(raw) : null;
  if (tcs && tcs.length) {
    history.push({ role: "assistant", content: msg.content || null, tool_calls: tcs,
      ...(typeof msg.reasoning_content === "string" ? { reasoning_content: msg.reasoning_content } : {}) });
    return { toolCalls: tcs, history };
  }
  const content = String(msg.content || "").trim();
  let think = String(msg.reasoning_content || "").trim();
  let text = content;
  if (/<think>[\s\S]*?<\/think>/.test(content)) {
    const m = content.match(/<think>([\s\S]*?)<\/think>/);
    if (!think) think = String(m?.[1] || "").trim();
    text = content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  }
  history.push({ role: "assistant", content: text || null });
  return { think, text: text || null, history };
}

// ── 默认 HTTP 客户端：Node 原生 fetch（Node 25+）──
async function defaultHttpFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 60000);
  try {
    const r = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal,
    });
    return {
      status: r.status,
      ok: r.ok,
      json: async () => { try { return await r.json(); } catch { return null; } },
      text: async () => await r.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 便捷工厂：注册为插件时的 mount 返回
export function createModelAdapterPlugin(adapter) {
  return {
    id: `model-adapter:${adapter.id}`,
    name: `模型适配器: ${adapter.name}`,
    deps: [],
    mount: () => adapter,
  };
}

export default HttpModelAdapter;
