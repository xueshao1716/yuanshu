// 每轮请求都会把全部工具定义发给模型。单个 MCP 工具的 schema 可达 180KB（rea 的 compare_web_captures），
// 19 个超大工具占整个请求体 80%，上游处理一次要多等几十秒。超过上限的 MCP 工具不进默认工具表（内置工具永远保留）。
export const MCP_SCHEMA_MAX_BYTES = 8000;

export function slimToolDefs(defs, { maxMcpBytes = Number(process.env.YUANSHU_MCP_SCHEMA_MAX_BYTES) || MCP_SCHEMA_MAX_BYTES } = {}) {
  if (!Array.isArray(defs)) return defs;
  const dropped = [];
  const kept = defs.filter((def) => {
    const name = def?.function?.name || def?.name || '';
    if (!name.startsWith('mcp_')) return true;
    let size = 0;
    try { size = JSON.stringify(def).length; } catch {}
    if (size > maxMcpBytes) { dropped.push(name); return false; }
    return true;
  });
  return dropped.length ? Object.assign(kept, { dropped }) : defs;
}
