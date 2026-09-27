// ===== agent-loop.mjs —— Gateway 2.0 Agent 循环（dsh AgentLoop 思想沉淀）=====
// 设计：AgentLoop = 可替换的"驱动"，把 ModelAdapter + ToolRegistry 串成完整 Agent。
//   内置 StandardAgentLoop：工具循环（最多 20 轮）+ 防死循环 + 失败重试上限 + 思考提取。
//   loop 不关心模型厂商、不关心工具实现——只认注入的接口，换组件不改 loop。
// 工具调度：委托 engine/tool-scheduler.mjs（dsh 思想：排他屏障 + 有界并行池 + 结果保序 + abort 补合成结果）。

import { scheduleToolCalls } from "./tool-scheduler.mjs";

export class StandardAgentLoop {
  constructor(options = {}) {
    this.id = options.id || "standard";
    this.name = options.name || "标准工具循环";
    this.version = "2.0.0";
    this.maxTurns = options.maxTurns || 20;
    this.maxLoopCalls = options.maxLoopCalls || 3;      // 相同工具+参数连续 N 次 → 中断
    this.maxFailRetries = options.maxFailRetries || 5;  // 失败重试上限
    this.maxParallel = options.maxParallel || 4;        // 并行工具调用的并发上限（有界滚动池）
    this.getModel = options.getModel || (() => null);   // () => 当前模型 { id, provider, ... }
  }

  // run({ message, history, model?, tools?, opts }) → { text?, think?, history, error?, aborted? }
  //   tools: ToolRegistry 实例（缺省则无工具，纯对话）
  //   opts: { onTool, onToolEnd, signal, params, system }
  async run({ message, history = [], model, tools, opts = {} } = {}) {
    const adapter = opts.modelAdapter; // 由 Gateway 注入（不依赖全局）
    if (!adapter) return { error: "未配置模型适配器" };
    const m = model || this.getModel();
    if (!m) return { error: "未选择模型" };
    const messages = buildMessages(history, message, opts.system);
    const seenCalls = new Map();
    let turn = 0;

    while (turn < this.maxTurns) {
      turn++;
      if (opts.signal?.aborted) return { aborted: true, history: messages };
      const toolDefs = tools && tools.list().length ? tools.list() : undefined;
      const r = await adapter.chat(m, messages, {
        tools: toolDefs,
        signal: opts.signal,
        params: opts.params,
        timeout: opts.timeout,
      });
      if (r.error) return { error: r.error, history: messages };
      if (r.aborted) return { aborted: true, history: messages };

      // 有工具调用 → 执行并继续
      if (r.toolCalls?.length) {
        // adapter 已把 assistant(tool_calls) 追加进 r.history（完整历史），以此继续，避免 tool 消息失去前置 tool_calls
        if (r.history) {
          messages.length = 0;
          messages.push(...r.history);
        } else {
          messages.push({ role: "assistant", content: null, tool_calls: r.toolCalls });
        }
        for (const tc of r.toolCalls) {
          let a = {};
          try { a = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          const sig = (tc.function?.name || "") + ":" + JSON.stringify(a);
          seenCalls.set(sig, (seenCalls.get(sig) || 0) + 1);
        }
        // 调度执行：排他工具成屏障，其余有界并行；结果按模型顺序返回；abort 未启动的补合成结果
        const results = await scheduleToolCalls({
          toolCalls: r.toolCalls,
          tools,
          onTool: opts.onTool,
          onToolEnd: opts.onToolEnd,
          signal: opts.signal,
          maxParallel: this.maxParallel,
        });
        for (const item of results) {
          const { id: tcId, name: fnName, args, out } = item;
          const sig = fnName + ":" + JSON.stringify(args);
          const failed = out.isError === true;
          if (!failed && seenCalls.get(sig) >= this.maxLoopCalls) {
            return { error: "模型工具调用陷入循环，已中断（建议换一种方式提问）", history: messages };
          }
          if (failed && seenCalls.get(sig) >= this.maxFailRetries) {
            out.text = `[系统提示] 工具 ${fnName} 已连续失败 ${this.maxFailRetries} 次（最近错误：${String(out.text || "").slice(0, 100)}）。请换一种方式完成任务，不要重复相同的失败操作。`;
          }
          messages.push({ role: "tool", tool_call_id: tcId, content: out.text });
        }
        continue;
      }

      // 无工具调用 → 最终回复
      return { think: r.think, text: r.text, history: messages };
    }

    // 超轮数：尽量返回中间结果
    for (let i = messages.length - 1; i >= 0; i--) {
      const m0 = messages[i];
      if (m0.role === "assistant" && m0.content && !m0.tool_calls) {
        return { text: String(m0.content), partial: true, history: messages };
      }
    }
    return { error: `工具调用超过 ${this.maxTurns} 轮，已停止（任务过于复杂或陷入循环）`, history: messages };
  }
}

function buildMessages(history, message, system) {
  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  for (const h of history || []) {
    if (h.role === "system") continue; // 防重复 system
    msgs.push(h);
  }
  if (message != null) {
    msgs.push({ role: "user", content: typeof message === "string" ? message : JSON.stringify(message) });
  }
  return msgs;
}

// 注册为插件时的 mount 返回
export function createAgentLoopPlugin(loop) {
  return {
    id: `agent-loop:${loop.id}`,
    name: `Agent 循环: ${loop.name}`,
    deps: ["model-adapter:http"],
    mount: () => loop,
  };
}

export default StandardAgentLoop;
