import { randomUUID } from "node:crypto";

const MAX_SUMMARY = 2_000;
const MAX_TEXT = 1_200;
const SENSITIVE_KEY = /^(?:authorization|api[_-]?key|token|password|secret|credential|private[_-]?key|args?|arguments?|raw)$/i;
const STATUS = new Set(["completed", "failed", "interrupted", "cancelled", "stopped"]);

function text(value, limit = MAX_TEXT) {
  if (value == null) return "";
  return String(value)
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)["']?[^\s,"'}]+/gi, "$1[REDACTED]")
    .slice(0, limit);
}

function clean(value, depth = 0) {
  if (typeof value === "string") return text(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 3) return "[OMITTED]";
  if (Array.isArray(value)) return value.slice(0, 20).map(item => clean(item, depth + 1));
  if (typeof value !== "object") return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    const next = clean(item, depth + 1);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function pick(value, keys) {
  const source = clean(value) || {};
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function normalizeStatus(value) {
  const s = String(value || "").toLowerCase();
  if (s === "done" || s === "complete" || s === "success" || s === "ok") return "completed";
  if (STATUS.has(s)) return s;
  return null;
}

function normalizeEvent(type, value = {}) {
  const name = String(type || "").replace(/^pi\//, "");
  const data = value && typeof value === "object" ? value : {};
  if (name === "tool" || name === "tool_start" || name === "tool_started") {
    return { type: "tool", data: { ...pick(data, ["id", "name", "tool", "turn", "ordinal", "effectKey", "argsHash"]), status: "started" } };
  }
  if (name === "tool_end" || name === "tool_finished") {
    const out = pick(data, ["id", "name", "tool", "turn", "ordinal", "effectKey", "argsHash", "output", "uncertain", "reused"]);
    out.status = data.isError === true ? "error" : "completed";
    return { type: "tool", data: out };
  }
  if (name === "subagent_started" || name === "subagent_start") {
    return { type: "subagent", data: { ...pick(data, ["id", "childId", "runId", "parentRunId", "sessionId", "role", "agent", "task", "model"]), status: "started" } };
  }
  if (name === "subagent_finished" || name === "subagent_end") {
    const out = pick(data, ["id", "childId", "runId", "parentRunId", "sessionId", "role", "agent", "task", "model", "result", "summary", "output", "error"]);
    out.status = normalizeStatus(data.status) || (data.error ? "failed" : "completed");
    return { type: "subagent", data: out };
  }
  if (name === "memory_written") {
    return { type: "memory_written", data: pick(data, ["id", "topic", "section", "path", "status", "summary"]) };
  }
  if (name === "artifact_created" || name === "media" || name === "file") {
    return { type: "artifact_created", data: pick(data, ["id", "path", "name", "kind", "mime", "url", "title", "description", "status", "size"]) };
  }
  if (name === "checkpoint") {
    return { type: "plan", data: pick(data, ["step", "phase", "checkpointKind", "status", "completedSteps", "pendingSteps", "summary"]) };
  }
  if (name === "verification") {
    const out = pick(data, ["id", "evidence", "artifact", "summary", "status"]);
    // A verification record is authoritative only when the producer marks it
    // as a real/runtime check; a model's self-reported `verified` flag is not
    // enough to turn a run into an accepted delivery.
    out.verified = data.verified === true && (data.real === true || data.source === "runtime" || data.origin === "runtime");
    out.status = out.verified ? "verified" : "reported";
    return { type: "verification", data: out };
  }
  return null;
}

function decodeChunk(decoder, chunk) {
  if (typeof chunk === "string") {
    try { return decoder.decode(new TextEncoder().encode(chunk), { stream: true }); } catch { return chunk; }
  }
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    try { return decoder.decode(chunk, { stream: true }); } catch { return ""; }
  }
  return "";
}

function createParser(onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = block => {
    if (!block || block.startsWith(":")) return;
    let eventName = "message";
    const dataLines = [];
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) return;
    let data;
    try { data = JSON.parse(dataLines.join("\n")); } catch { return; }
    if (data && typeof data === "object") onEvent(eventName, data);
  };
  return chunk => {
    buffer += decodeChunk(decoder, chunk);
    let match;
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
      consume(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  };
}

function signalList(signals) {
  if (!signals) return [];
  const list = Array.isArray(signals) ? signals : [signals];
  return list.flatMap(item => item?.signal && !item.addEventListener ? [item.signal] : [item]).filter(Boolean);
}

function listenAbort(signal, callback) {
  if (typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", callback, { once: true });
    return () => signal.removeEventListener?.("abort", callback);
  }
  if (typeof signal.on === "function") {
    signal.on("abort", callback);
    return () => (signal.off || signal.removeListener)?.call(signal, "abort", callback);
  }
  return () => {};
}

function install(res, name, wrapper) {
  if (!res || typeof res[name] !== "function") return null;
  const descriptor = Object.getOwnPropertyDescriptor(res, name);
  const original = res[name];
  try { res[name] = wrapper; }
  catch {
    try { if (descriptor?.configurable) Object.defineProperty(res, name, { ...descriptor, value: wrapper }); else return null; }
    catch { return null; }
  }
  return { name, wrapper, descriptor, original };
}

function restore(res, item) {
  if (!item || res[item.name] !== item.wrapper) return;
  try {
    if (item.descriptor) Object.defineProperty(res, item.name, item.descriptor);
    else delete res[item.name];
  } catch {}
}

export function createAIBodyHost(runtime = {}) {
  return {
    attach(options = {}) {
      const res = options.res;
      const runId = String(options.runId || randomUUID());
      const sessionId = options.sessionId == null ? null : String(options.sessionId);
      const source = options.source === "scheduled" ? "scheduled" : "chat";
      let turn;
      try {
        turn = runtime.beginTurn?.({ runId, sessionId, engine: options.engine || "yuanshu", source, message: text(options.message, 4_000), resume: options.resume === true });
      } catch { turn = null; }
      if (!turn || typeof turn !== "object") turn = { id: runId };
      const turnId = String(turn.id || turn.turnId || runId);
      let finished = false;
      let cancelRequested = false;
      let candidateStatus = null;
      let finalOutcome = null;
      let summary = "";
      let errorSummary = "";
      const cleanups = [];
      const parser = createParser((type, data) => event(type, data));

      const observe = (mapped) => {
        try { runtime.observe?.(turnId, mapped?.type, mapped?.data || {}); } catch {}
      };
      function event(type, data = {}) {
        const name = String(type || "").replace(/^pi\//, "");
        if (name === "delta") {
          const part = text(data?.text, MAX_SUMMARY);
          summary = (summary + part).slice(-MAX_SUMMARY);
          return null;
        }
        if (name === "done") candidateStatus = "completed";
        if (name === "error") {
          if (!candidateStatus || candidateStatus === "failed") candidateStatus = "failed";
          errorSummary = text(data?.message || data?.error, MAX_SUMMARY);
        }
        const mapped = name === "verification" && !(data?.real === true || data?.source === "runtime" || data?.origin === "runtime")
          ? null
          : normalizeEvent(name, data);
        if (mapped) observe(mapped);
        return mapped;
      }

      const originalWrite = res?.write;
      const originalEnd = res?.end;
      const wrappedWrite = function (...args) {
        const result = Reflect.apply(originalWrite, this, args);
        if (!this.__aibodyEnding) parser(args[0]);
        return result;
      };
      const wrappedEnd = function (...args) {
        this.__aibodyEnding = true;
        let result;
        try { result = Reflect.apply(originalEnd, this, args); }
        catch (error) {
          this.__aibodyEnding = false;
          event("error", { message: error?.message || error });
          finish({ status: "failed", summary: errorSummary });
          throw error;
        }
        this.__aibodyEnding = false;
        if (args[0] !== undefined && args[0] !== null) parser(args[0]);
        finish();
        return result;
      };
      const writeInstall = install(res, "write", wrappedWrite);
      const endInstall = install(res, "end", wrappedEnd);
      const finish = (input = {}) => {
        if (finished) return finalOutcome || { status: candidateStatus || "interrupted", summary };
        const requested = normalizeStatus(input.status);
        if (requested === "cancelled") cancelRequested = true;
        const status = cancelRequested ? "cancelled" : requested || candidateStatus || "interrupted";
        const finalSummary = text(input.summary || summary || (status === "failed" ? errorSummary : ""), MAX_SUMMARY);
        finished = true;
        finalOutcome = { status, summary: finalSummary };
        try { runtime.finishTurn?.(turnId, { status, summary: finalSummary, error: errorSummary || null }); } catch {}
        for (const cleanup of cleanups.splice(0)) cleanup();
        restore(res, endInstall);
        restore(res, writeInstall);
        return finalOutcome;
      };

      for (const signal of signalList(options.signals ?? options.signal)) {
        const cleanup = listenAbort(signal, () => { cancelRequested = true; finish({ status: "cancelled" }); });
        cleanups.push(cleanup);
        if (signal.aborted) { cancelRequested = true; finish({ status: "cancelled" }); }
      }

      return { ...turn, id: turnId, runId, sessionId, source, finish, event };
    },
  };
}
