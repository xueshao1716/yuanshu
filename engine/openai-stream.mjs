// engine/openai-stream.mjs —— OpenAI 兼容 chat/completions 流式解析
// 把 SSE token（或误开 stream 时的整段 JSON）还原成 message，并在到达时回调。

export function createChatStreamAccumulator() {
  const msg = { content: "", reasoning_content: "", tool_calls: [] };
  const meta = {};
  return {
    pushMetadata(json) {
      if (json?.model) meta.model = json.model;
      if (json?.usage) meta.usage = json.usage;
      if (json?.choices?.[0]?.finish_reason) meta.finishReason = json.choices[0].finish_reason;
    },
    metadata() { return { ...meta }; },
    pushDelta(delta) {
      const emitted = { think: "", text: "", done: false };
      if (!delta || typeof delta !== "object") return emitted;
      if (typeof delta.content === "string" && delta.content) {
        msg.content += delta.content;
        emitted.text = delta.content;
      }
      const think = delta.reasoning_content || delta.reasoning;
      if (typeof think === "string" && think) {
        msg.reasoning_content += think;
        emitted.think = think;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const i = Number.isInteger(tc.index) ? tc.index : 0;
          if (!msg.tool_calls[i]) {
            msg.tool_calls[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
          }
          const slot = msg.tool_calls[i];
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (typeof tc.function?.arguments === "string") slot.function.arguments += tc.function.arguments;
        }
      }
      return emitted;
    },
    message() {
      const tool_calls = msg.tool_calls.filter(Boolean);
      return {
        content: msg.content || null,
        reasoning_content: msg.reasoning_content,
        ...(tool_calls.length ? { tool_calls } : {}),
      };
    },
    hasThink() { return !!msg.reasoning_content; },
  };
}

export function consumeOpenAIStreamLine(line, acc) {
  const s = String(line || "").trim();
  if (!s || s.startsWith(":") || s.startsWith("event:")) return { done: false, think: "", text: "" };
  if (!s.startsWith("data:")) return { done: false, think: "", text: "" };
  const payload = s.slice(5).trim();
  if (payload === "[DONE]") return { done: true, think: "", text: "" };
  let json;
  try { json = JSON.parse(payload); } catch { return { done: false, think: "", text: "" }; }
  if (json?.error) return { done: true, think: "", text: "", error: String(json.error?.message || json.error).slice(0, 200) };
  acc.pushMetadata(json);
  const delta = json?.choices?.[0]?.delta;
  if (delta) return { done: false, ...acc.pushDelta(delta) };
  const message = json?.choices?.[0]?.message;
  if (message) return { done: false, ...acc.pushDelta({
    content: message.content,
    reasoning_content: message.reasoning_content,
    tool_calls: message.tool_calls,
  }) };
  return { done: false, think: "", text: "" };
}

function emit(opts, ev, acc, thinkEnded) {
  if (ev.think) opts.onThink?.(ev.think);
  if (ev.text) {
    if (!thinkEnded.value && acc.hasThink()) {
      opts.onThinkEnd?.();
      thinkEnded.value = true;
    }
    opts.onDelta?.(ev.text);
  }
}

async function readAll(body) {
  if (!body) return new Uint8Array();
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export async function readOpenAIChatStream(body, opts = {}) {
  const acc = createChatStreamAccumulator();
  const decoder = new TextDecoder();
  const thinkEnded = { value: false };
  let buf = "";
  let mode = "unknown";
  let error = "";

  const flushSseLines = (final) => {
    const parts = buf.split(/\r?\n/);
    buf = final ? "" : (parts.pop() || "");
    for (const line of parts) {
      const ev = consumeOpenAIStreamLine(line, acc);
      if (ev.error) error = ev.error;
      emit(opts, ev, acc, thinkEnded);
      if (ev.done) return true;
    }
    return false;
  };

  const ingest = (chunk, final) => {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: !final });
    if (mode === "unknown") {
      const trimmed = buf.trimStart();
      if (!trimmed) return false;
      if (trimmed.startsWith("data:") || trimmed.startsWith(":") || trimmed.startsWith("event:")) mode = "sse";
      else if (trimmed.startsWith("{") || trimmed.startsWith("[")) mode = "json";
    }
    if (mode === "sse") return flushSseLines(final);
    return false;
  };

  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    while (true) {
      if (opts.signal?.aborted) return { aborted: true, message: acc.message() };
      const { done, value } = await reader.read();
      if (done) {
        ingest(new Uint8Array(), true);
        break;
      }
      if (ingest(value, false)) break;
    }
  } else if (body) {
    const all = await readAll(body);
    ingest(all, true);
  }

  if (mode === "json") {
    const raw = buf.trim();
    try {
      const json = JSON.parse(raw);
      acc.pushMetadata(json);
      if (json?.error) error = String(json.error?.message || json.error).slice(0, 200);
      const message = json?.choices?.[0]?.message || {};
      const ev = acc.pushDelta({
        content: message.content,
        reasoning_content: message.reasoning_content,
        tool_calls: message.tool_calls,
      });
      emit(opts, ev, acc, thinkEnded);
    } catch {
      error = error || "流式响应不是合法 JSON";
    }
  }

  if (!thinkEnded.value && acc.hasThink()) opts.onThinkEnd?.();
  return { message: acc.message(), ...acc.metadata(), error: error || undefined, aborted: !!opts.signal?.aborted };
}
