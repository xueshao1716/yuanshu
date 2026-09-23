import { decodeMessagesResponse } from './anthropic-messages.mjs';

// Parse native SSE incrementally; a disconnected tool plan must never execute.
export async function readMessagesStream(body, opts = {}) {
  const blocks = [], json = new Map(), open = new Set();
  let model, usage = {}, stopReason, stopped = false, buffer = '', full = '', mode = null;
  const decoder = new TextDecoder();
  const reader = body?.getReader?.();
  if (!reader) return { error: 'Messages response has no readable body' };
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  function consume(frame) {
    const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!payload) return;
    const e = JSON.parse(payload);
    if (e.type === 'error') throw new Error(e.error?.message || e.error?.type || 'Messages stream error');
    if (e.type === 'message_start') { model = e.message?.model; usage = { ...e.message?.usage }; }
    else if (e.type === 'content_block_start') {
      blocks[e.index] = structuredClone(e.content_block); open.add(e.index);
      if (e.content_block.type === 'text' && e.content_block.text) opts.onDelta?.(e.content_block.text);
      if (e.content_block.type === 'thinking' && e.content_block.thinking) opts.onThink?.(e.content_block.thinking);
    } else if (e.type === 'content_block_delta') {
      const block = blocks[e.index], delta = e.delta || {};
      if (!block || !open.has(e.index)) throw new Error('Invalid Messages block order');
      if (delta.type === 'text_delta') { block.text = (block.text || '') + delta.text; opts.onDelta?.(delta.text); }
      else if (delta.type === 'thinking_delta') { block.thinking = (block.thinking || '') + delta.thinking; opts.onThink?.(delta.thinking); }
      else if (delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
      else if (delta.type === 'input_json_delta') json.set(e.index, (json.get(e.index) || '') + delta.partial_json);
    } else if (e.type === 'content_block_stop') {
      // Decode inputs only after stop_reason arrives: max_tokens may close a
      // block with incomplete JSON. It must be retried, never executed as {}.
      if (blocks[e.index]?.type === 'thinking') opts.onThinkEnd?.();
      open.delete(e.index);
    } else if (e.type === 'message_delta') { stopReason = e.delta?.stop_reason; usage = { ...usage, ...e.usage }; }
    else if (e.type === 'message_stop') stopped = true;
  }
  try {
    if (opts.signal?.aborted) return { aborted: true };
    while (!stopped && !opts.signal?.aborted) {
      const { value, done } = await reader.read();
      const chunk = decoder.decode(value, { stream: !done });
      buffer += chunk;
      if (!mode && buffer.trim()) mode = buffer.trimStart().startsWith('{') ? 'json' : 'sse';
      if (mode === 'json') { full += buffer; buffer = ''; }
      else {
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          consume(frame);
          if (stopped) break;
        }
      }
      if (done) break;
    }
    if (opts.signal?.aborted) return { aborted: true, message: { content: blocks.filter(b => b?.type === 'text').map(b => b.text).join('') } };
    if (mode === 'json') return decodeMessagesResponse(JSON.parse(full));
    if (!stopped && buffer.trim()) consume(buffer);
    if (!stopped || open.size) return { error: 'Incomplete Messages stream; tool calls were not executed' };
    const incomplete = [];
    for (const [index, raw] of json) {
      try { blocks[index].input = JSON.parse(raw); }
      catch (error) {
        if (stopReason !== 'max_tokens') throw error;
        const block = blocks[index];
        incomplete.push({ id: block.id, type: 'function', function: { name: block.name, arguments: raw } });
        blocks[index] = null;
      }
    }
    const result = decodeMessagesResponse({ model, content: blocks.filter(Boolean), usage, stop_reason: stopReason });
    if (incomplete.length) result.message.tool_calls = [...(result.message.tool_calls || []), ...incomplete];
    return result;
  } catch (error) {
    return opts.signal?.aborted ? { aborted: true } : { error: error.message };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
