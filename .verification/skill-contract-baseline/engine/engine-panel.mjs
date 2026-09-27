// 引擎页下半：Gateway 旁路状态装饰 + 预置插件（网页不能传 mount 函数）
export const CORE_PLUGIN_PREFIXES = [
  "model-adapter:",
  "tool-registry:",
  "session-store:",
  "agent-loop:",
  "yuanshu:",
];

const PLUGIN_PRESETS = {
  echo: {
    id: "echo-demo",
    name: "回声演示",
    version: "1.0.0",
    mount: () => ({ ping: () => "pong" }),
  },
  clock: {
    id: "clock-demo",
    name: "时钟演示",
    version: "1.0.0",
    mount: () => ({ now: () => Date.now() }),
  },
};

export function isCorePlugin(id) {
  const s = String(id || "");
  return CORE_PLUGIN_PREFIXES.some((p) => s.startsWith(p));
}

export function pluginFromBody(body = {}) {
  const preset = String(body.preset || "").trim().toLowerCase();
  const known = PLUGIN_PRESETS[preset];
  if (!known) throw new Error("只能挂预置插件：echo / clock");
  return {
    id: known.id,
    name: String(body.name || known.name),
    version: known.version,
    deps: [],
    mount: known.mount,
  };
}

export function defaultCapabilities({ gatewayReady, codeReady } = {}) {
  return [
    { id: "pair", name: "主次引擎切换", desc: "下一句对话生效", have: true, live: true },
    { id: "eval", name: "元枢评测绳", desc: "冻结用例出分数，不跑真模型", have: true, live: true },
    { id: "sidecar", name: "Gateway 旁路循环", desc: "探活 / 预置插件，不替换主聊天", have: !!gatewayReady, live: true },
    { id: "code", name: "Code Mode", desc: "程序编排工具绑定", have: !!codeReady, live: true },
    { id: "tools", name: "主聊天工具表", desc: "UNIFIED_TOOLS 实时列出", have: true, live: true },
    { id: "approval", name: "危险操作确认", desc: "approval.mjs 拦截危险工具", have: true, live: true },
    { id: "prompt-sections", name: "上下文分区", desc: "persona/protocol/tools/memory 命名区段", have: true, live: true },
    { id: "sandbox", name: "沙箱阶梯", desc: "read-only → workspace-write → danger，拒绝词模型可见", have: true, live: true },
    { id: "compact-archive", name: "非破坏压缩", desc: "模型面摘要，原文进 archive", have: true, live: true },
    { id: "prompt-seams", name: "区段接缝", desc: "prompt 插件贡献 system 区段；一轮只收一次", have: true, live: true },
    { id: "workmem", name: "磁盘工作记忆", desc: "每会话 task_plan / findings / progress", have: true, live: true },
    { id: "hot-swap", name: "底盘热替换接到主聊天", desc: "Gateway 循环还接不进主通道", have: false, live: false },
  ];
}

export function decorateEngineStatus(raw = {}, extras = {}) {
  const plugins = (raw.plugins || []).map((p) => ({ ...p, core: isCorePlugin(p.id) }));
  return {
    ...raw,
    role: "sidecar",
    note: "主聊天走上方主次引擎；这套 Gateway 是旁路演示，可探活、可挂预置插件。",
    probedAt: Date.now(),
    capabilities: extras.capabilities || defaultCapabilities(extras),
    plugins,
  };
}
