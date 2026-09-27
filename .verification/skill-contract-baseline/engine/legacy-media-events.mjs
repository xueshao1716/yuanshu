import { extractPlayableMedia } from './media-embed.mjs';

function readOnlyTool(tool) {
  if (tool?.name === 'read') return true;
  const command = tool?.args?.command;
  return tool?.name === 'bash' && typeof command === 'string'
    && !/[$`<>()\r\n]|--pre\b/.test(command)
    && command.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, 'ARG').split(/&&|&|;|\|/)
      .every(s => /^(?:cd|cat|head|tail|rg|grep|wc)(?:\s|$)/.test(s.trim()));
}

/** Old tool-text scraping emitted bare {type,url} immediately after tool_end.
 * Suppress only proven read-only references. Keep the source ledger untouched,
 * original sequence numbers, media tools, explicit results and uncertain cases.
 */
export function withoutLegacyReferenceMedia(events) {
  const tools = new Map();
  let previousTool = null;
  return events.filter(event => {
    if (event.type === 'tool') tools.set(event.data?.id, event.data);
    if (event.type === 'tool_end') {
      previousTool = { ...tools.get(event.data?.id), ...event.data };
      return true;
    }
    if (event.type !== 'media') { previousTool = null; return true; }
    const media = event.data;
    if (!media || Object.keys(media).length !== 2 || !media.type || !media.url || !readOnlyTool(previousTool)) return true;
    if (!String(media.url).startsWith('/api/ws/file?path=')) return true;
    // read output may have been truncated before the referenced path.
    if (previousTool.name === 'read') return false;
    const refs = extractPlayableMedia(previousTool.output);
    return ![...refs.images, ...refs.videos, ...refs.audios].includes(media.url);
  });
}
