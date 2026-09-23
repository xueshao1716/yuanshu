// engine/model-session.mjs —— 模型列表端点 + 会话级模型切换（2026-08-29 从 server.mjs 拆出）
// handleModels：/api/models 列表（含 free/note 标注）
// handleSwitchModel + syncContextAfterSwitch：会话级模型切换与上下文灌输

export function createModelSessionApi(deps) {
  const {
    json, readJsonFile, resolveAuth, modelCapabilities, modelsPath,
    getModelList, getDefaultModel, getModelRuntime, getConfig,
    activeSessions, createSessionAgent,
    saveLastModel, saveSessionModelKey,
  } = deps;

  // GET /api/models —— 只返回已配置 Key 的 provider 的模型；附带 free/note 供前端种类与免费标记
  function handleModels(res) {
    const CONFIG = getConfig();
    const store = readJsonFile(modelsPath);
    const list = getModelList()
      .filter((m) => resolveAuth(m.provider))
      .map((m) => {
        const sm = (store[m.provider]?.models || []).find((x) => x.id === m.id) || {};
        return {
          provider: m.provider, id: m.id, name: m.name || m.id,
          contextWindow: m.contextWindow,
          api: sm.api || m.api,
          discoverySource: sm.discoverySource || 'configured',
          capabilitySource: sm.capabilitySource || 'configured',
          limitsSource: sm.limitsSource,
          verification: sm.verification || null,
          vision: Array.isArray(m.input) && m.input.includes("image"),
          reasoning: !!m.reasoning,
          // 派生默认值 + 持久化覆盖：store 快照是加模型时写的，没有后补的
          // reference/keyframe/seed；只写 `m.capabilities || 派生` 会让老快照永久压掉新能力。
          capabilities: { ...modelCapabilities(m.id), ...(m.capabilities || {}) },
          free: sm.free,
          note: sm.note || "",
        };
      });
    const dm = getDefaultModel();
    json(res, 200, {
      models: list,
      current: dm ? { provider: dm.provider, id: dm.id } : null,
      autoDefault: !CONFIG.model,
      cwd: CONFIG.cwd,
      tools: CONFIG.tools,
    });
  }

  let lastModelKey = null; // 历史遗留：仅写不读（保留赋值语义防意外引用）

  // POST /api/model —— 会话级模型切换
  async function handleSwitchModel(req, res, body) {
    // Auto 路由特殊处理：不绑定具体模型，每条消息按复杂度路由
    if (body.provider === "auto" || (body.modelId && /^auto(-smart)?$/i.test(body.modelId))) {
      lastModelKey = null; saveLastModel(null);
      if (body.sessionId && activeSessions.has(body.sessionId)) {
        const entry2 = activeSessions.get(body.sessionId);
        try { entry2.modelKey = { provider: "auto", id: "auto" }; } catch {}
        saveSessionModelKey(body.sessionId, { provider: "auto", id: "auto" });
        // 重建 agent 用默认 flash 暂代，下条消息 handleChat 按复杂度实时路由
        if (entry2.agent && !entry2.busy) {
          try { entry2.agent.dispose(); } catch {}
          entry2.agent = null;
          try { const ag = await createSessionAgent(entry2.sm, getDefaultModel()); entry2.agent = ag; entry2.agentModel = { provider: getDefaultModel().provider, id: getDefaultModel().id }; } catch {}
        }
        json(res, 200, { ok: true, model: { provider: "auto", id: "auto" }, sessionScoped: true, auto: true });
        return;
      }
      json(res, 200, { ok: true, model: { provider: "auto", id: "auto" }, deferred: true, auto: true });
      return;
    }
    const modelList = getModelList();
    const m = modelList.find((x) => x.provider === body.provider && x.id === body.modelId);
    if (!m) return json(res, 404, { error: `模型未找到: ${body.provider}/${body.modelId}` });
    const dm = getDefaultModel();
    const switched = !(dm?.provider === m.provider && dm?.id === m.id);
    // 完整 runtime 模型（含 compat/thinkingFormat，简版模型会导致 agent 通道 reasoning 处理异常）
    let fullModel = m;
    try {
      fullModel = getModelRuntime().getModels().find((x) => x.provider === m.provider && x.id === m.id) || m;
    } catch {}
    // 会话级切换：只改指定会话的模型，不动全局 defaultModel（避免污染其他会话）
    if (body.sessionId && activeSessions.has(body.sessionId)) {
      const entry2 = activeSessions.get(body.sessionId);
      try { entry2.modelKey = { provider: m.provider, id: m.id }; } catch {}
      saveSessionModelKey(body.sessionId, { provider: m.provider, id: m.id });
      if (entry2.agent && !entry2.busy) {
        try { entry2.agent.dispose(); } catch {}
        entry2.agent = null;
        try {
          const ag = await createSessionAgent(entry2.sm, fullModel);
          entry2.agent = ag;
          entry2.agentModel = { provider: m.provider, id: m.id };
          if (switched) { try { await syncContextAfterSwitch(entry2, m); } catch {} }
        } catch {}
      } else if (entry2.agent && entry2.busy) {
        console.log(`[元枢] 会话 busy，模型切换延迟到下次消息生效 → ${m.provider}/${m.id}`);
      }
      json(res, 200, { ok: true, model: { provider: m.provider, id: m.id }, sessionScoped: true });
      return;
    }
    // 无 sessionId → 不改全局默认（前端已用 pendingModel 等会话创建后按会话应用）
    json(res, 200, { ok: true, model: { provider: m.provider, id: m.id }, deferred: true });
  }

  // 切换模型后的上下文灌输：customType=context 注入（不进会话历史，仅当前轮生效）
  async function syncContextAfterSwitch(entry, model) {
    try {
      const mName = model?.name || model?.id || "新模型";
      try {
        await entry.agent?.sendCustomMessage?.(
          { customType: "context", content: [{ type: "text", text: "（提示）当前会话已切换模型为 " + mName + "。请直接根据对话历史继续回答，无需重复确认。" }] },
          { deliverAs: "nextTurn" }
        );
      } catch {}
      console.log(`[元枢] 模型切换为 ${mName}，已注入上下文提示（context 注入，不污染历史）`);
    } catch {}
  }

  return { handleModels, handleSwitchModel };
}
