// engine/turn-profile.mjs —— 每轮耗时拆解（2026-10-24）
//
// 目的：回答"她为什么慢"。不猜，按阶段记账：
//   request  收到请求
//   context  上下文装配完成（记忆检索/技能匹配/外壳提示）
//   firstDelta 模型首个增量（用户感知的"开始吐字"）
//   tool     工具执行累计
//   end      本轮结束
// 结果追加到 记忆/运行时/每轮耗时.jsonl，一行一轮，便于事后聚合。
import fs from 'node:fs';
import path from 'node:path';

export const PROFILE_LOG = '记忆/运行时/每轮耗时.jsonl';
const MAX_LINES = 5000;

export function createTurnProfiler({ wsRoot, log = null } = {}) {
  const file = path.join(wsRoot, PROFILE_LOG);

  function begin({ sessionId = '', runId = '', model = '', messageChars = 0 } = {}) {
    const t0 = Date.now();
    const marks = { request: 0 };
    let firstDeltaAt = null;
    let toolMs = 0;
    // 2026-10-24：provider 真实 usage（token 数与缓存命中），用于 tok/s 与上下文占用
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, lastCtx: 0 };
    const tools = new Map(); // name -> start

    const profile = {
      get sessionId() { return sessionId },
      mark(name) {
        if (!(name in marks)) marks[name] = Date.now() - t0;
        if (name === 'firstDelta' && firstDeltaAt == null) firstDeltaAt = Date.now();
      },
      toolStart(name) { if (!tools.has(name)) tools.set(name, Date.now()) },
      addUsage(u = {}) {
        const n = (v) => Number(v) || 0;
        const input = n(u.input ?? u.prompt_tokens ?? u.input_tokens);
        const output = n(u.output ?? u.completion_tokens ?? u.output_tokens);
        const cacheRead = n(u.cacheRead ?? u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens);
        const cacheWrite = n(u.cacheWrite ?? u.cache_creation_input_tokens);
        usage.input += input; usage.output += output;
        usage.cacheRead += cacheRead; usage.cacheWrite += cacheWrite;
        usage.calls += 1;
        usage.lastCtx = n(u.totalTokens) || (input + cacheRead + output + cacheWrite);
      },
      toolEnd(name) {
        const at = tools.get(name);
        if (at) { toolMs += Date.now() - at; tools.delete(name) }
      },
      /** 把 res 的写操作当探针：从 SSE 片段里认事件名 */
      instrument(res) {
        if (!res || typeof res.write !== 'function' || res.__turnProfile) return res;
        const original = res.write.bind(res);
        res.__turnProfile = true;
        res.write = (chunk) => {
          try {
            const text = String(chunk);
            const m = /^event:\s*(\S+)/m.exec(text);
            if (m) {
              const ev = m[1];
              if (ev === 'delta' || ev === 'text' || ev === 'message_delta') profile.mark('firstDelta');
              if (ev === 'model_used') {
                try { const d = JSON.parse((/^data:\s*([\s\S]*)$/m.exec(text) || [])[1] || '{}'); if (d.model) model = d.model } catch {}
              }
              if (ev === 'usage') {
                try {
                  const data = JSON.parse((/^data:\s*([\s\S]*)$/m.exec(text) || [])[1] || '{}');
                  profile.addUsage(data);
                } catch {}
              }
              if (ev === 'tool' || ev === 'tool_start' || ev === 'tool_started') {
                const name = /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1] || 'tool';
                profile.toolStart(name);
              }
              if (ev === 'tool_result' || ev === 'tool_end' || ev === 'tool_finished') {
                const name = /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1] || 'tool';
                profile.toolEnd(name);
              }
            }
          } catch {}
          return original(chunk);
        };
        return res;
      },
      end(extra = {}) {
        const totalMs = Date.now() - t0;
        const record = {
          at: new Date(t0).toISOString(),
          sessionId: sessionId ? String(sessionId).slice(0, 36) : '',
          runId: runId ? String(runId).slice(0, 36) : '',
          model,
          messageChars,
          totalMs,
          contextMs: marks.context ?? null,
          firstDeltaMs: firstDeltaAt ? firstDeltaAt - t0 : null,
          toolMs: Math.round(toolMs),
          toolsLeft: [...tools.keys()],
          usage,
          model,
          ...extra,
        };
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
          // 简单轮转：超过 MAX_LINES 行就留最近一半
          const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
          if (lines.length > MAX_LINES) {
            fs.writeFileSync(file, lines.slice(-Math.floor(MAX_LINES / 2)).join('\n') + '\n', 'utf8');
          }
        } catch {}
        try { log?.(`[turn] total=${totalMs}ms context=${record.contextMs ?? '-'} firstDelta=${record.firstDeltaMs ?? '-'} tool=${record.toolMs}ms`); } catch {}
        return record;
      },
    };
    return profile;
  }

  /** 聚合最近 N 轮：各阶段中位数/均值，给"该砍哪里"用 */
  function summarize(limit = 50) {
    let rows = [];
    try { rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch {}
    rows = rows.slice(-limit);
    if (!rows.length) return { count: 0 };
    const pick = (k) => rows.map((r) => r[k]).filter((v) => typeof v === 'number');
    const stat = (arr) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const mean = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
      return { mean, p50: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] };
    };
    return {
      count: rows.length,
      totalMs: stat(pick('totalMs')),
      contextMs: stat(pick('contextMs')),
      firstDeltaMs: stat(pick('firstDeltaMs')),
      toolMs: stat(pick('toolMs')),
    };
  }

  return { begin, summarize };
}
