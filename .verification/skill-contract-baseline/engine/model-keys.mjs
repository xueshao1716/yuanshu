// engine/model-keys.mjs —— 会话级模型选择持久化（2026-08-29 从 server.mjs 拆出）
// saveSessionModelKey / loadSessionModelKey：会话→模型绑定（session-model-keys.json）
// saveLastModel：全局最后模型（last-model.json，新会话继承）

import fs from "node:fs";
import path from "node:path";

export function createModelKeys(deps) {
  const { readJsonFile, getAgentDir, getModelList } = deps;
  const SESSION_KEYS_FILE = path.join(getAgentDir(), "session-model-keys.json");
  const LAST_MODEL_FILE = path.join(getAgentDir(), "last-model.json");

  function saveSessionModelKey(sid, mk) {
    if (!sid) return;
    try { const d = readJsonFile(SESSION_KEYS_FILE); d[sid] = mk; fs.writeFileSync(SESSION_KEYS_FILE, JSON.stringify(d, null, 1)); } catch {}
  }
  function loadSessionModelKey(sid) {
    try {
      const mk = readJsonFile(SESSION_KEYS_FILE)[sid] || null;
      if (!mk) return null;
      // ⚠️ 校验：会话存的模型若已下架/被清理(不在当前模型列表)，视为未设置 → 走默认路由。
      // 否则显示与实际不符、调用失败后静默降级（用户看到 A 实际跑 B）
      const exists = (getModelList() || []).some((m) => m.provider === mk.provider && m.id === mk.id);
      return exists ? mk : null;
    } catch { return null; }
  }

  // 全局最后模型：用户切过具体模型后记录，新会话继承；切回 Auto 时清空
  function saveLastModel(mk) {
    try {
      if (!mk || (mk.provider === "auto" && mk.id === "auto")) { fs.writeFileSync(LAST_MODEL_FILE, JSON.stringify({}, null, 1)); return; }
      fs.writeFileSync(LAST_MODEL_FILE, JSON.stringify({ provider: mk.provider, id: mk.id }, null, 1));
    } catch {}
  }

  return { saveSessionModelKey, loadSessionModelKey, saveLastModel };
}
