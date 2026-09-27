// Shared native Messages codec for chat, Gateway and direct model calls.
import { modelEndpoint } from './model-endpoints.mjs';
export function messagesEndpoint(base) {
  return modelEndpoint(base, 'messages');
}

export function messagesHeaders(key) {
  return { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
}

function contentBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (Array.isArray(content) ? content : []).flatMap(block => {
    if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : [];
    if (block.type === 'image_url') {
      const url = block.image_url?.url || block.image_url;
      const data = String(url).match(/^data:([^;]+);base64,(.+)$/s);
      return [{ type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url } }];
    }
    if (['image', 'document', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result'].includes(block.type)) return [block];
    throw new Error(`Unsupported Messages content: ${block.type}`);
  });
}

export function buildMessagesRequest({ model, modelKey, messages, tools, maxTokens = 8192, stream = false, params } = {}) {
  const system = [], turns = [];
  for (const message of messages || []) {
    if (message.role === 'system' || message.role === 'developer') { system.push(...contentBlocks(message.content)); continue; }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    let content;
    if (message.role === 'tool') {
      content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: typeof message.content === 'string' ? message.content : contentBlocks(message.content), ...(message.isError || message.is_error ? { is_error: true } : {}) }];
    } else if (role === 'assistant' && Array.isArray(message.anthropic_content) && (!message.anthropic_model || message.anthropic_model === modelKey)) {
      content = structuredClone(message.anthropic_content);
    } else {
      content = contentBlocks(message.content);
      for (const call of message.tool_calls || []) {
        const input = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: input || {} });
      }
    }
    if (!content.length) continue;
    if (turns.at(-1)?.role === role) turns.at(-1).content.push(...content);
    else turns.push({ role, content });
  }
  const body = { model, messages: turns, max_tokens: maxTokens, stream };
  if (system.length) body.system = system;
  if (Array.isArray(tools) && tools.length) body.tools = tools.map(tool => {
    const fn = tool.function || tool;
    return { name: fn.name, description: fn.description || '', input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} } };
  });
  // Native Messages uses provider-default reasoning; never send OpenAI reasoning_effort.
  if (typeof params?.temperature === 'number' && params.temperature >= 0 && params.temperature <= 1) body.temperature = params.temperature;
  else if (typeof params?.top_p === 'number' && params.top_p > 0 && params.top_p <= 1) body.top_p = params.top_p;
  return body;
}

export function decodeMessagesResponse(data) {
  if (data?.error) throw new Error(data.error.message || String(data.error));
  if (!Array.isArray(data?.content)) throw new Error('Invalid Messages response: missing content');
  const toolCalls = [];
  for (const block of data.content) {
    if (block.type !== 'tool_use') continue;
    if (!block.id || !block.name || !block.input || typeof block.input !== 'object' || Array.isArray(block.input)) throw new Error('Invalid Messages tool input');
    toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
  }
  return {
    message: {
      content: data.content.filter(b => b.type === 'text').map(b => b.text || '').join(''),
      reasoning_content: data.content.filter(b => b.type === 'thinking').map(b => b.thinking || '').join(''),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      anthropic_content: data.content,
    },
    model: data.model, usage: data.usage, finishReason: data.stop_reason,
  };
}
