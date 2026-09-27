// Claude Code 式清单：多步任务先写下再勾选，模型不用靠记忆扛目标。
const STATUSES = new Set(["pending", "in_progress", "completed"]);
const stores = new Map();
let currentSession = "default";

export const TODO_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "todo_write",
      description: "整表覆盖当前待办。多步骤任务先列出再动手，做完一项就勾 completed。状态只能 pending / in_progress / completed。同时只应有一项 in_progress。",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_read",
      description: "读取当前会话待办清单。",
      parameters: { type: "object", properties: {} },
    },
  },
];

export function bindTodoSession(id) {
  currentSession = String(id || "default");
  return currentSession;
}

export function normalizeTodos(items) {
  const list = Array.isArray(items) ? items : [];
  let sawActive = false;
  return list.slice(0, 20).map((raw) => {
    const content = String(raw?.content || raw?.subject || "").trim().slice(0, 200);
    let status = STATUSES.has(raw?.status) ? raw.status : "pending";
    if (status === "in_progress") {
      if (sawActive) status = "pending";
      else sawActive = true;
    }
    return { content, status };
  }).filter((t) => t.content);
}

export function writeTodos(items, sessionId = currentSession) {
  const list = normalizeTodos(items);
  stores.set(String(sessionId || "default"), list);
  return list;
}

export function readTodos(sessionId = currentSession) {
  return stores.get(String(sessionId || "default")) || [];
}

export function formatTodoPrompt(sessionId = currentSession) {
  const list = readTodos(sessionId);
  if (!list.length) return "";
  const lines = list.map((t, i) => {
    const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " ";
    return `${i + 1}. [${mark}] ${t.content}`;
  });
  return `【当前待办】按清单推进，完成就 todo_write 勾选：\n${lines.join("\n")}`;
}

export function todoExtraExecutors() {
  return {
    todo_write: (args) => {
      const list = writeTodos(args?.todos);
      return { text: list.length ? formatTodoPrompt() : "待办已清空", isError: false };
    },
    todo_read: () => {
      const text = formatTodoPrompt();
      return { text: text || "暂无待办。多步骤任务请先 todo_write。", isError: false };
    },
  };
}
