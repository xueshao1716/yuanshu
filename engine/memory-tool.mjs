// engine/memory-tool.mjs —— MemorySkill：把记忆库封装成元枢原生注释（2026-10-13 伙伴定稿）
// 「记忆本身也可以包装成一个Skill，叫MemorySkill，接入元枢。内部封装：写入记忆、召回记忆、
//  更新记忆、遗忘记忆。底层存储（多维表格+向量库）完全被Skill封装，上层Agent、小程序不知道
//  底层用多维表格。以后想换PG+pgvector，只改Skill内部，上层完全不动。」
// 形态与 cultivation 工具同构：JSON Schema function calling。

const ACTIONS = ["remember", "recall", "update", "forget", "forget_by_query", "stats"];
const description =
  "MemorySkill：读写你自己的中长期记忆库（跨会话沉淀与召回）。" +
  "remember：把值得跨会话记住的内容沉淀成一条记忆——先在脑内提炼成一句短摘要（≤80字，写结论不写过程），选类型 preference（用户偏好）/task_record（任务结果）/fact（事实沉淀），打 0~1 重要性分（用户明确的偏好与红线 0.8+，事实 0.5~0.7，一次性任务细节不沉淀）；" +
  "recall：召回相关记忆拿去组织回答（用于『之前说过/上次那个/老规矩』类问题）——查询写自然语义，别照抄关键词；结果已按 语义相似×重要性 加权排序，只取前几条注入回复，不要原文罗列；" +
  "update：更正或补强某条记忆；forget：精确遗忘（user 要求删除某条时）；forget_by_query：语义找相似记忆后遗忘（user 说『忘掉之前关于XX的偏好』类）；stats：查记忆规模与 embedding 配置。" +
  "写入规则：一轮对话结束若有值得沉淀的（用户偏好/承诺/重要事实），主动 remember 一条，别等问题问；写之前别重复——先 recall 确认没记过。短时聊天不要 remember（那是上下文的事）。";

export const MEMORY_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "memory",
    description,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ACTIONS },
        user_id: { type: "string", description: "记忆归属（默认 owner=主人）" },
        memory_type: { type: "string", enum: ["preference", "task_record", "fact"] },
        summary: { type: "string", description: "提炼后的短摘要（remember 必填）" },
        raw_content: { type: "string", description: "可选：原始出处文本" },
        importance_score: { type: "number", description: "0~1 重要性" },
        expire_at: { type: "string", description: "可选 ISO 到期时间" },
        source: { type: "string", enum: ["auto", "manual", "skill", "feedback"] },
        memory_id: { type: "string" },
        patch: { type: "object", description: "update 动作的字段更新" },
        query: { type: "string", description: "recall / forget_by_query 的查询" },
        topK: { type: "integer", description: "recall 条数（默认5）" },
      },
      required: ["action"],
    },
  },
};

/** 工厂：注入 server.mjs 已初始化的 memoryDb/memoryVectors/memoryEmbedding 与管线路由口径。
 *  deps = { db, vectors, embedding, ingest, recall } —— 全部来自 server 顶层，Skill 内不直接碰文件。 */
export function createPiMemoryTool(Type, deps) {
  const describe = (m) => ({
    memory_id: m.memory_id, memory_type: m.memory_type, summary: m.summary,
    importance_score: m.importance_score, status: m.status, expire_at: m.expire_at,
    updated_at: m.updated_at, vector_id: m.vector_id ? "bound" : null,
  });

  async function execute(_id, args = {}) {
    try {
      const { user_id = "owner" } = args;
      switch (args.action) {
        case "remember": {
          if (!String(args.summary || "").trim()) return err("summary 不能为空", false);
          if (deps.ingest) {
            const r = await deps.ingest({
              user_id, memory_type: args.memory_type, summary: args.summary,
              raw_content: args.raw_content || null, importance_score: args.importance_score ?? null,
              expire_at: args.expire_at || null, source: args.source || "auto",
            });
            return ok({ remembered: r.item.memory_id, embedded: !!r.vector_id, item: describe(r.item), embedNote: r.embedNote || undefined });
          }
          const item = deps.db.addMemory({ user_id, memory_type: args.memory_type, summary: args.summary, raw_content: args.raw_content || null, importance_score: args.importance_score ?? null, expire_at: args.expire_at || null, source: args.source || "auto" });
          return ok({ remembered: item.memory_id, embedded: false, item: describe(item) });
        }
        case "recall": {
          const q = String(args.query || "").trim();
          if (!q) return err("query 不能为空", false);
          if (deps.recall) {
            const results = await deps.recall(q, { user_id, topK: args.topK || 5 });
            return ok(results.length ? { query: q, results } : { query: q, results: [], note: "没有相关记忆" });
          }
          const r = deps.db.listMemories({ user_id, q: q.slice(0, 60), limit: args.topK || 5 });
          return ok({ query: q, results: r.items.map(x => ({ memory_id: x.memory_id, summary: x.summary, importance_score: x.importance_score, similarity: 0 })) });
        }
        case "update": {
          if (!args.memory_id) return err("memory_id 不能为空", false);
          const item = deps.db.updateMemory(args.memory_id, args.patch || {});
          return ok({ updated: true, item: describe(item) });
        }
        case "forget": {
          const m = deps.db.getMemory(args.memory_id);
          if (m?.vector_id) { try { deps.vectors.remove(m.vector_id); } catch { } }
          const r = deps.db.deleteMemory(args.memory_id);
          return ok({ forgotten: r.ok, memory_id: args.memory_id });
        }
        case "forget_by_query": {
          const q = String(args.query || "").trim();
          if (!q) return err("query 不能为空", false);
          const r = deps.recall
            ? await deps.recall(q, { user_id, topK: 3 })
            : deps.db.listMemories({ user_id, q: q.slice(0, 60), limit: 3 }).items.map(x => ({ memory_id: x.memory_id, summary: x.summary }));
          const forgot = [];
          for (const x of r) {
            const m = deps.db.getMemory(x.memory_id);
            if (m?.vector_id) { try { deps.vectors.remove(m.vector_id); } catch { } }
            deps.db.deleteMemory(x.memory_id);
            forgot.push(x.summary.slice(0, 40));
          }
          return ok({ query: q, forgotten: forgot.length, items: forgot });
        }
        case "stats": {
          const lst = deps.db.listMemories({ user_id, limit: 1, status: "all" });
          const vec = deps.vectors.stats();
          const cfg = deps.embedding.configInfo ? deps.embedding.configInfo() : null;
          return ok({ user_id, total_memories: lst.total, vectors: vec.count, embedding: cfg, note: "短时记忆在上下文窗口，不在此库" });
        }
        default:
          return err(`未知动作 ${args.action}，可用：${ACTIONS.join("/")}`, false);
      }
    } catch (error) {
      return { text: String(error?.message || error).slice(0, 200), isError: true };
    }
  }
  const ok = (data) => ({ text: JSON.stringify(data), isError: false });
  const err = (m, retryable) => ({ text: JSON.stringify({ error: m, retryable: !!retryable }), isError: true });

  return {
    name: "memory",
    label: "MemorySkill",
    description,
    parameters: Type.Unsafe(MEMORY_TOOL_SCHEMA.function.parameters),
    execute: async (_id, args) => {
      const r = await execute(_id, args);
      return { content: [{ type: "text", text: r.text }], isError: r.isError };
    },
  };
}
