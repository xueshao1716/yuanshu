// engine/external-agent.mjs —— 把活派给本机的命令行智能体（Claude Code / Codex / 通义 Qwen Code 等，2026-11-19）
//
// 借 OAR（@botiverse/oar）统一驱动外部编码智能体：它负责拉起 CLI、收事件、等这一轮结束。
// OAR 还是 0.x，接口随时可能变，所以只在这一个文件里碰它；server.mjs 只认 delegate_external。
//
// 三道闸：
//   1) 默认关闭——记忆/运行时/外部智能体.json 里 enabled:true 才放行；
//   2) 每天最多 dailyCap 次（默认 5），按派出次数算，失败也算；
//   3) 工作目录只能是工作区或它下面的子目录，Codex 用 workspace-write 沙箱。
import fs from 'node:fs';
import path from 'node:path';

export const EXTERNAL_AGENT_FILE = path.join('记忆', '运行时', '外部智能体.json');
export const DEFAULT_DAILY_CAP = 5;
export const DEFAULT_TIMEOUT_MS = 20 * 60_000;
// id → 显示名 / OAR 运行时导出名 / 没装时给用户的安装提示。默认只开前两个，其余要在设置页单独打开
const AGENTS = {
  claude: { label: 'Claude Code', exp: 'claudeRuntime', install: 'npm i -g @anthropic-ai/claude-code' },
  codex: { label: 'Codex', exp: 'codexRuntime', install: 'npm i -g @openai/codex' },
  qwen: { label: '通义 Qwen Code', exp: 'qwenRuntime', install: 'npm i -g @qwen-code/qwen-code' },
  codebuddy: { label: '腾讯 CodeBuddy（WorkBuddy 的命令行版）', exp: 'codebuddyRuntime', install: 'npm i -g @tencent-ai/codebuddy-code，再运行 codebuddy 登录' },
  kimi: { label: 'Kimi CLI', exp: 'kimiRuntime', install: 'uv tool install kimi-cli' },
  qoder: { label: 'Qoder CLI', exp: 'qoderRuntime', install: '见 qoder.com 安装 qodercli' },
  opencode: { label: 'opencode', exp: 'opencodeRuntime', install: 'npm i -g opencode-ai' },
};
export const DEFAULT_ON = ['claude', 'codex'];
const labelOf = (id) => AGENTS[id]?.label || id;

export const DELEGATE_EXTERNAL_TOOL = {
  type: 'function',
  function: {
    name: 'delegate_external',
    description: '把一件编码/改文件的活派给本机的外部命令行智能体（Claude Code、Codex、通义 Qwen Code、CodeBuddy、Kimi、Qoder、opencode），同步等它做完并返回它的总结。用户点名要某个外部智能体去做时调用；每天有次数上限，没在设置里打开的会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: Object.keys(AGENTS), description: 'claude=Claude Code，codex=Codex，qwen=通义 Qwen Code，codebuddy=腾讯 CodeBuddy/WorkBuddy，kimi=Kimi，qoder=Qoder，opencode=opencode' },
        task: { type: 'string', description: '完整、自足的任务说明（对方看不到当前对话）' },
        subdir: { type: 'string', description: '可选：工作区内的子目录，作为对方的工作目录' },
      },
      required: ['agent', 'task'],
    },
  },
};

const today = (now) => new Date(now).toISOString().slice(0, 10);

export function readExternalConfig(wsRoot) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(wsRoot, EXTERNAL_AGENT_FILE), 'utf8')) || {} } catch {}
  const cap = Number(raw.dailyCap);
  const on = raw.agents && typeof raw.agents === 'object' ? raw.agents : {};
  return {
    enabled: raw.enabled === true,
    agents: Object.fromEntries(Object.keys(AGENTS).map((id) => [id, typeof on[id] === 'boolean' ? on[id] : DEFAULT_ON.includes(id)])),
    dailyCap: Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_DAILY_CAP,
    usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : {},
    raw,
  };
}

// 先记账再派：返回 { ok, used, cap } 或 { ok:false, reason }
export function claimExternalSlot(wsRoot, now = Date.now(), agent = '') {
  const cfg = readExternalConfig(wsRoot);
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (agent && !cfg.agents[agent]) return { ok: false, reason: 'agent_off' };
  const day = today(now);
  const used = Number(cfg.usage[day]) || 0;
  if (used >= cfg.dailyCap) return { ok: false, reason: 'quota', used, cap: cfg.dailyCap };
  const file = path.join(wsRoot, EXTERNAL_AGENT_FILE);
  // 只留当天的计数，文件不会越写越长
  const next = { ...cfg.raw, usage: { [day]: used + 1 } };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  } catch { return { ok: false, reason: 'ledger' } }
  return { ok: true, used: used + 1, cap: cfg.dailyCap };
}

// 工作目录必须落在工作区里：拒绝绝对路径、.. 越界和不存在的目录
export function resolveExternalCwd(wsRoot, subdir) {
  const root = path.resolve(wsRoot);
  const rel = String(subdir || '').trim();
  if (!rel) return root;
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  try { if (!fs.statSync(full).isDirectory()) return null } catch { return null }
  return full;
}

async function defaultLoad(agent) {
  if (!AGENTS[agent]) throw new Error(`unknown agent ${agent}`);
  const [rt, observe] = await Promise.all([
    import(`@botiverse/oar/runtimes/${agent}`),
    import('@botiverse/oar/observe'),
  ]);
  return { runtime: rt[AGENTS[agent].exp], promptAndWait: observe.promptAndWait };
}

const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t };

function outcomeText(outcome) {
  if (!outcome) return '';
  if (outcome.kind === 'completed') return '';
  if (outcome.kind === 'aborted') return '被中止';
  const why = { auth: '登录/凭据有问题', quota: '额度用完了', rate_limited: '被限流', billing: '账单问题', model_unavailable: '模型不可用', overloaded: '服务繁忙' }[outcome.failure];
  return clip([why || outcome.failure, outcome.reason].filter(Boolean).join('：'), 200);
}

/**
 * 跑一次外部智能体。
 * @returns {Promise<{text:string, isError:boolean, tools?:string[]}>}
 */
export async function runExternalAgent({ agent, task, cwd, signal, timeoutMs = DEFAULT_TIMEOUT_MS, load = defaultLoad, onEvent } = {}) {
  if (!AGENTS[agent]) return { text: `不认识的外部智能体：${agent}（支持 ${Object.keys(AGENTS).join(' / ')}）`, isError: true };
  const label = labelOf(agent);
  let mod;
  try { mod = await load(agent) }
  catch (e) { return { text: `外部智能体组件没装好（@botiverse/oar，需要 Node 24+）：${clip(e?.message || e, 160)}`, isError: true } }
  let inst;
  try { inst = await mod.runtime.installation() } catch (e) { inst = { kind: 'error', reason: e?.message } }
  if (inst?.kind !== 'available') return { text: `本机没找到可用的 ${label}：${clip(inst?.reason || inst?.kind || '未安装', 160)}。安装：${AGENTS[agent].install}`, isError: true };

  const tools = [];
  let session;
  const prevSandbox = process.env.OAR_CODEX_SANDBOX;
  try {
    // Codex 默认是 danger-full-access，这里收到只能写工作目录
    if (agent === 'codex') process.env.OAR_CODEX_SANDBOX = 'workspace-write';
    session = await mod.runtime.session(inst, { cwd, ...(agent === 'claude' ? { userConfiguration: 'exclude' } : {}) });
  } catch (e) {
    return { text: `${label} 启动失败：${clip(e?.message || e, 200)}`, isError: true };
  } finally {
    if (agent === 'codex') { if (prevSandbox === undefined) delete process.env.OAR_CODEX_SANDBOX; else process.env.OAR_CODEX_SANDBOX = prevSandbox }
  }
  try {
    try {
      session.events?.((ev) => {
        if (ev?.kind === 'tool_call_started') {
          const name = String(ev.toolName || ev.tool || '工具');
          tools.push(name);
          onEvent?.({ type: 'tool', name });
        }
      }, { coalesceText: true });
    } catch {}
    const r = await mod.promptAndWait(session, String(task), { timeoutMs, ...(signal ? { signal } : {}) });
    const body = clip(r?.text, 6000);
    const used = tools.length ? `\n\n（${label} 调用了 ${tools.length} 次工具）` : '';
    if (r?.kind === 'rejected') return { text: `${label} 拒收了任务：${clip(r.reason || r.code, 200)}`, isError: true, tools };
    if (r?.kind === 'interrupted') {
      const why = r.by === 'timeout' ? `超过 ${Math.round(timeoutMs / 60000)} 分钟没做完` : '被取消';
      return { text: `${label} ${why}，已停下。${body ? `\n已有输出：\n${body}` : ''}${used}`, isError: true, tools };
    }
    if (r?.kind === 'ended') {
      const bad = outcomeText(r.outcome);
      if (bad) return { text: `${label} 这一轮没成功：${bad}${body ? `\n${body}` : ''}${used}`, isError: true, tools };
      return { text: `${body || `（${label} 没有文字输出）`}${used}`, isError: false, tools };
    }
    return { text: `${label} 返回了意外结果：${clip(r?.kind, 60)}`, isError: true, tools };
  } catch (e) {
    return { text: `${label} 运行出错：${clip(e?.message || e, 200)}`, isError: true, tools };
  } finally {
    try { if (signal?.aborted) await session.abort?.() } catch {}
    try { await session.dispose?.() } catch {}
  }
}

/** 工具执行器：闸门 → 记账 → 跑。submit 由调用方注入（server 里是作业池 + 认领）。 */
export function createDelegateExternal({ wsRoot, run = runExternalAgent, now = () => Date.now() } = {}) {
  return async (args = {}, { signal } = {}) => {
    const agent = String(args.agent || '').trim().toLowerCase();
    const task = String(args.task || '').trim();
    if (!AGENTS[agent]) return { text: `agent 只能是：${Object.keys(AGENTS).join(' / ')}`, isError: true };
    if (!task) return { text: '请给出任务说明', isError: true };
    const cwd = resolveExternalCwd(wsRoot, args.subdir);
    if (!cwd) return { text: `子目录不在工作区内或不存在：${clip(args.subdir, 80)}`, isError: true };
    const slot = claimExternalSlot(wsRoot, now(), agent);
    if (!slot.ok) {
      if (slot.reason === 'disabled') return { text: '外部智能体没开启。需要用户在 系统设置 → 外部智能体 里打开开关。', isError: true };
      if (slot.reason === 'agent_off') return { text: `${labelOf(agent)} 没在设置里打开。需要用户在 系统设置 → 外部智能体 里勾上它。`, isError: true };
      if (slot.reason === 'quota') return { text: `今天的外部智能体次数用完了（${slot.used}/${slot.cap}），明天再派。`, isError: true };
      return { text: '外部智能体台账写不进去，这次不派。', isError: true };
    }
    return run({ agent, task, cwd, signal });
  };
}

// 设置页用：开关、次数、今天用了几次、本机装没装
export function saveExternalConfig(wsRoot, { enabled, dailyCap, agents } = {}) {
  const cfg = readExternalConfig(wsRoot);
  const next = { ...cfg.raw };
  if (typeof enabled === 'boolean') next.enabled = enabled;
  if (agents && typeof agents === 'object') {
    const bad = Object.keys(agents).find((id) => !AGENTS[id]);
    if (bad) throw Object.assign(new Error(`不认识的外部智能体：${bad}`), { localStatus: 400 });
    next.agents = { ...cfg.agents, ...Object.fromEntries(Object.entries(agents).map(([k, v]) => [k, v === true])) };
  }
  const cap = Number(dailyCap);
  if (dailyCap !== undefined) {
    if (!Number.isInteger(cap) || cap < 0 || cap > 50) throw Object.assign(new Error('每天次数只能是 0–50 的整数'), { localStatus: 400 });
    next.dailyCap = cap;
  }
  const file = path.join(wsRoot, EXTERNAL_AGENT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return externalStatus(wsRoot);
}

export function externalStatus(wsRoot, now = Date.now()) {
  const cfg = readExternalConfig(wsRoot);
  return { enabled: cfg.enabled, dailyCap: cfg.dailyCap, usedToday: Number(cfg.usage[today(now)]) || 0, on: cfg.agents };
}

export async function detectExternalAgents(load = defaultLoad) {
  const out = {};
  // 并行探测：一个个来要十几秒（每个都要拉起 CLI 问版本）
  await Promise.all(Object.entries(AGENTS).map(async ([id, a]) => {
    const base = { label: a.label, install: a.install };
    try {
      const inst = await (await load(id)).runtime.installation();
      const ok = inst?.kind === 'available';
      out[id] = { ...base, available: ok, version: inst?.version || '', reason: ok ? '' : (inst?.kind === 'not_found' ? '未安装' : clip(inst?.reason || inst?.kind, 120)) };
    } catch (e) { out[id] = { ...base, available: false, version: '', reason: clip(e?.message || e, 120) } }
  }));
  return Object.fromEntries(Object.keys(AGENTS).filter((id) => out[id]).map((id) => [id, out[id]]));
}
