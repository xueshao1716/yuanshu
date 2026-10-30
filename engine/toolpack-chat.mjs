// ===== toolpack-chat.mjs —— 把工具包接进对话工具表（2026-10-30）=====
//
// 默认关闭：装工具包 ≠ 让模型随便用。要开得显式打开开关。
// 打开后：把每个工具包的工具定义 push 进对话工具表（tp_<id>_<tool>），
// 并在 extraExecutors 里注册同名执行器，走 toolpack-runtime（worker + 权限逐项校验）。
// 关闭时把之前 push 的条目清掉。
import fs from "node:fs";
import path from "node:path";
import { listToolpacks, readToolpack, readState, setSetting } from "./plugin-store.mjs";
import { runToolpackTool } from "./toolpack-runtime.mjs";

export const SETTING_KEY = "allowToolpacksInChat";
const PREFIX = "tp_";

export function toolpacksInChat(wsRoot) {
  return readState(wsRoot).settings?.[SETTING_KEY] === true;
}

export function setToolpacksInChat(wsRoot, on) {
  return setSetting(wsRoot, SETTING_KEY, !!on);
}

const toolName = (packId, name) => `${PREFIX}${String(packId).replace(/[^a-z0-9_]/g, "_")}_${name}`.slice(0, 64);

/** 同步工具表：打开时加入，关闭时清除。返回实际挂上的工具数。 */
export function syncToolpacks({ wsRoot, tools, executors } = {}) {
  if (!Array.isArray(tools) || !executors) return { ok: false, error: "tools/executors 必填" };

  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const n = tools[i]?.function?.name || tools[i]?.name || "";
    if (String(n).startsWith(PREFIX)) { tools.splice(i, 1); delete executors[n] }
  }
  if (!toolpacksInChat(wsRoot)) return { ok: true, enabled: false, tools: 0 };

  let count = 0;
  for (const pack of listToolpacks(wsRoot)) {
    for (const t of pack.tools || []) {
      const name = toolName(pack.id, t.name);
      if (tools.some((x) => (x?.function?.name || x?.name) === name)) continue;
      tools.push({
        type: "function",
        function: {
          name,
          description: `[插件 ${pack.name}] ${String(t.description || "").slice(0, 300)}`,
          parameters: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} },
        },
      });
      executors[name] = async (args) => {
        const fresh = readToolpack(wsRoot, pack.id);
        if (!fresh) return { text: `插件 ${pack.name} 已停用或已卸载`, isError: true };
        const tool = (fresh.tools || []).find((x) => x.name === t.name);
        if (!tool) return { text: `插件 ${pack.name} 里没有工具 ${t.name}`, isError: true };
        // 2026-10-30：状态里没记 permissions（老安装）就读 plugin.json，别静默变成「没权限」
        let perms = readState(wsRoot).installed?.[pack.id]?.permissions;
        if (!Array.isArray(perms)) {
          try { perms = JSON.parse(fs.readFileSync(path.join(wsRoot, "插件", pack.id, "plugin.json"), "utf8"))?.permissions || []; }
          catch { perms = []; }
        }
        const out = await runToolpackTool({ tool, args: args || {}, permissions: perms, wsRoot, timeoutMs: 20000 });
        return out.ok ? { text: String(out.text || "") } : { text: `工具包执行失败：${out.error}`, isError: true };
      };
      count += 1;
    }
  }
  return { ok: true, enabled: true, tools: count };
}
