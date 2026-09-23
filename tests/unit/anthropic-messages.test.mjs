import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessagesRequest, decodeMessagesResponse, messagesEndpoint } from '../../engine/anthropic-messages.mjs';
import { readMessagesStream } from '../../engine/anthropic-stream.mjs';

test('Messages preserves system, image, signed thinking and paired tool results', () => {
  const signed = [{ type: 'thinking', thinking: 'plan', signature: 'signed' }, { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } }];
  const body = buildMessagesRequest({ model: 'step-5-preview', maxTokens: 2048, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], messages: [
    { role: 'system', content: '你是元枢' }, { role: 'user', content: [{ type: 'text', text: '读图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
    { role: 'assistant', anthropic_content: signed }, { role: 'tool', tool_call_id: 't1', content: 'file contents', isError: true },
  ] });
  assert.deepEqual(body.system, [{ type: 'text', text: '你是元枢' }]);
  assert.equal(body.messages[0].content[1].source.type, 'base64');
  assert.deepEqual(body.messages[1].content, signed);
  assert.deepEqual(body.messages[2].content, [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents', is_error: true }]);
  assert.equal(body.tools[0].input_schema.type, 'object');
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(messagesEndpoint('https://example.com/step_plan/v1'), 'https://example.com/step_plan/v1/messages');
});

const event = data => `event: ${data.type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
test('switching native providers preserves tool results without replaying another model signature', () => {
  const messages = [{ role: 'assistant', content: '读取', anthropic_model: 'a/original', anthropic_content: [{ type: 'thinking', thinking: 'private', signature: 'old-signature' }], tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: '42' }];
  const body = buildMessagesRequest({ model: 'fallback', modelKey: 'b/fallback', messages });
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: '读取' }, { type: 'tool_use', id: 'c1', name: 'read', input: {} }]);
  assert.equal(body.messages[1].content[0].tool_use_id, 'c1');
});
function wire(extra = [], stop = true) {
  return [event({ type: 'message_start', message: { id: 'm1', model: 'step-5-preview', content: [], usage: { input_tokens: 8, output_tokens: 0 } } }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
    event({ type: 'content_block_stop', index: 0 }), ...extra,
    ...(stop ? [event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }), event({ type: 'message_stop' })] : [])].join('');
}
function stream(s) { const bytes = new TextEncoder().encode(s); return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }); }

test('Messages SSE decodes fragmented Unicode, signatures, tools and provenance', async () => {
  const texts = [], thoughts = [];
  const parsed = await readMessagesStream(stream(wire([
    event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '检查中' } }),
    event({ type: 'content_block_stop', index: 1 }),
    event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'read', input: {} } }),
    event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }),
    event({ type: 'content_block_stop', index: 2 }),
  ])), { onDelta: t => texts.push(t), onThink: t => thoughts.push(t) });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.model, 'step-5-preview');
  assert.equal(parsed.message.anthropic_content[0].signature, 'sig');
  assert.deepEqual(JSON.parse(parsed.message.tool_calls[0].function.arguments), { path: 'a' });
  assert.equal(texts.join(''), '检查中'); assert.equal(thoughts.join(''), '思考');
  assert.equal(parsed.usage.output_tokens, 12);
});

test('Messages rejects incomplete SSE and upstream errors instead of executing partial tools', async () => {
  assert.match((await readMessagesStream(stream(wire([], false)))).error, /incomplete/i);
  assert.match((await readMessagesStream(stream(event({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } })))).error, /busy/);
  assert.throws(() => decodeMessagesResponse({ type: 'message', content: [{ type: 'tool_use', id: 't', name: 'read', input: 'broken' }] }), /input/);
});

test('Messages cancellation releases a stalled reader', async () => {
  const ac = new AbortController(); let cancelled = false;
  const pending = readMessagesStream(new ReadableStream({ cancel() { cancelled = true; } }), { signal: ac.signal });
  ac.abort(); const result = await pending;
  assert.equal(result.aborted, true); assert.equal(cancelled, true);
});
