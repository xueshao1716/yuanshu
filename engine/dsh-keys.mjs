// engine/dsh-keys.mjs —— dsh 执行臂 + 双引擎密钥 + 声明式策略引擎（2026-08-20 从 server.mjs 拆出）
// 依赖注入：initDshKeys({ dshWebPort, readJsonFile, writeJsonFile, authPath, modelsPath, ModelRuntime, refreshModelList })
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { json, readBody } from "./http-utils.mjs";
import { modelCapabilities } from "./model-probe.mjs";
import { createModelOnboarding } from './model-onboarding.mjs';

// 支持的 provider 清单（模型管理下拉）；随块从 server.mjs 迁入
const SUPPORTED_PROVIDERS = ["deepseek", "openai", "openrouter", "anthropic", "google", "qwen", "xai", "moonshotai", "zai", "together", "mistral", "modelscope", "cloudflare-ai"];
let _port = 3080, _readJsonFile = null, _writeJsonFile = null, _authPath = "", _modelsPath = "", _ModelRuntime = null, _refreshModelList = null;
let _setModelList = () => {}, _getDefaultModel = () => null, _setDefaultModel = () => {}, _setModelRuntime = () => {}, _getModelRuntime = () => null, _keepModels = new Set(), _resetHealth = () => {};
export function initDshKeys({ dshWebPort = 3080, readJsonFile = null, writeJsonFile = null, authPath = "", modelsPath = "", ModelRuntime = null, refreshModelList = null, supportedProviders = [], setModelList = null, getDefaultModel = null, setDefaultModel = null, setModelRuntime = null, getModelRuntime = null, keepModels = new Set(), resetModelHealth = null } = {}) {
  _port = dshWebPort; _readJsonFile = readJsonFile; _writeJsonFile = writeJsonFile; _authPath = authPath; _modelsPath = modelsPath; _ModelRuntime = ModelRuntime; _refreshModelList = refreshModelList;
  if (setModelList) _setModelList = setModelList; if (getDefaultModel) _getDefaultModel = getDefaultModel; if (setDefaultModel) _setDefaultModel = setDefaultModel;
  if (setModelRuntime) _setModelRuntime = setModelRuntime; if (getModelRuntime) _getModelRuntime = getModelRuntime; _keepModels = keepModels; if (resetModelHealth) _resetHealth = resetModelHealth; 
}

export const KNOWN_PROVIDERS = new Set(["deepseek", "openai", "openrouter", "anthropic", "google", "qwen", "xai", "moonshotai", "zai", "together", "mistral", "opencode-go"]);

// 主流大厂预设（OpenAI 兼容 /models 探测）：首次启动引导下拉框 + keys/apply 验证共用
export const PROVIDER_PRESETS = {
  deepseek:    { name: "DeepSeek 深度求索",     baseUrl: "https://api.deepseek.com" },
  openai:      { name: "OpenAI",                baseUrl: "https://api.openai.com/v1" },
  openrouter:  { name: "OpenRouter 聚合",        baseUrl: "https://openrouter.ai/api/v1" },
  anthropic:   { name: "Anthropic · Claude",    baseUrl: "https://api.anthropic.com/v1", api: 'anthropic-messages' },
  google:      { name: "Google · Gemini",        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  qwen:        { name: "阿里云百炼 · Qwen",     baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  moonshotai:  { name: "Moonshot · Kimi",       baseUrl: "https://api.moonshot.cn/v1" },
  zai:         { name: "智谱 · GLM",            baseUrl: "https://api.z.ai/api/v1" },
  "volces-ark":{ name: "火山方舟 · Ark",       baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  xai:         { name: "xAI · Grok",            baseUrl: "https://api.x.ai/v1" },
  mistral:     { name: "Mistral",               baseUrl: "https://api.mistral.ai/v1" },
  together:    { name: "Together AI",           baseUrl: "https://api.together.xyz/v1" },
  sensenova:   { name: "商汤 · 日日新",         baseUrl: "https://api.sensenova.cn/v1" },
  modelscope:  { name: "魔搭 · ModelScope",     baseUrl: "https://api.modelscope.cn/v1" },
  "cloudflare-ai": { name: "Cloudflare Workers AI", baseUrl: "" },
};

// GET /api/keys/presets —— 首启引导下拉框数据（单一来源，前端不写死）
export function handleKeysPresets(res) {
  json(res, 200, { presets: PROVIDER_PRESETS });
}

// 解析 provider 的认证：优先 auth.json，其次环境变量（如 OPENROUTER_API_KEY）
export function resolveAuth(provider) {
  const auth = _readJsonFile(_authPath);
  if (auth[provider]?.key) return { key: auth[provider].key, baseUrl: auth[provider].baseUrl || "" };
  const envName = String(provider).toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY";
  if (process.env[envName]) return { key: process.env[envName], baseUrl: "" };
  return null;
}

// 刷新内存模型列表（直接读 models-store.json——权威来源，且重建运行时让新 key 生效）
export async function refreshModelList() {
  try { _setModelRuntime(await _ModelRuntime.create()); } catch {}
  _resetHealth(); // 模型清单刷新 = 重新探测，冷却状态一并清零给所有模型新机会
  const store = _readJsonFile(_modelsPath);
  const authed = new Set(Object.keys(_readJsonFile(_authPath)));
  const all = [];
  // 原生 provider（pi 内置目录，如 xiaomi-token-plan-cn）——只取不在 store 里的（store 的保持自定义逻辑）
  try {
    for (const m of ((_getModelRuntime?.() || {}).getModels?.() || [])) {
      if (!authed.has(m.provider) || store[m.provider]) continue;
      all.push({
        provider: m.provider, id: m.id, name: m.name || m.id, api: m.api, baseUrl: m.baseUrl,
        reasoning: !!m.reasoning, contextWindow: m.contextWindow, input: m.input,
        compat: m.compat, thinkingLevelMap: m.thinkingLevelMap,
        capabilities: modelCapabilities(m.id),
      });
    }
  } catch {}
  // 自定义 / 既有 provider（store）
  for (const [provider, cfg] of Object.entries(store)) {
    if (!authed.has(provider)) continue;
    for (const m of (cfg.models || [])) {
      all.push({
        provider, id: m.id, name: m.name || m.id, api: m.api, baseUrl: m.baseUrl,
        reasoning: !!m.reasoning, contextWindow: m.contextWindow, input: m.input,
        compat: m.compat, thinkingLevelMap: m.thinkingLevelMap,
        // 派生默认值 + 持久化覆盖：store 里的 capabilities 是**加模型时的快照**，
        // 新补的 reference/keyframe/seed 它自然没有（2026-09-14）。
        // 只写 `m.capabilities || 派生` 会让老快照永久压掉新能力，故改为合并。
        capabilities: { ...modelCapabilities(m.id), ...(m.capabilities || {}) },
      });
    }
  }
  const list = all.filter(m => {
    if (["deepseek", "openai", "openrouter"].includes(m.provider) && !store[m.provider]?.managedCatalog) return _keepModels.has(`${m.provider}/${m.id}`);
    return true;
  });
  _setModelList(list);
  const curDefault = _getDefaultModel();
  if (curDefault && !list.find(m => m.provider === curDefault.provider && m.id === curDefault.id)) {
    _setDefaultModel(list[0] || undefined);
  }
  console.log(`[元枢] 模型刷新: ${list.length} 个（含 ${Object.keys(store).join(", ")}）`);
}

// GET /api/models/manage —— 只显示真正配置了 Key 的 provider
export async function handleModelsManage(res) {
  const auth = _readJsonFile(_authPath);
  const store = _readJsonFile(_modelsPath);
  const providers = Object.keys(store)
    .filter(p => auth[p]?.key)
    .map(p => ({
      provider: p,
      hasKey: !!auth[p],
      baseUrl: store[p]?.baseUrl || store[p]?.models?.[0]?.baseUrl || auth[p]?.baseUrl || "",
      api: store[p]?.api || store[p]?.models?.[0]?.api || PROVIDER_PRESETS[p]?.api || 'openai-completions',
      checkedAt: store[p]?.checkedAt || null,
      modelCount: (store[p]?.models || []).length,
      capabilities: (store[p]?.models || []).reduce((acc, m) => { const c = m.capabilities || modelCapabilities(m.id); for (const k of Object.keys(acc)) if (c[k]) acc[k] = true; return acc; }, { chat: false, image: false, video: false, tts: false, asr: false }),
      models: (store[p]?.models || []).map(m => m.id).slice(0, 30),
    }));
  json(res, 200, { providers, supported: SUPPORTED_PROVIDERS });
}

// 模型能力探测与发现已抽到 engine/model-probe.mjs（modelCapabilities / probeModelCapabilities / discoverCustomModels）
// POST /api/models/add —— 统一按协议发现或手动登记，验证完成后才保存，不依赖 SDK。
function onboarding() {
  return createModelOnboarding({ read: _readJsonFile, write: _writeJsonFile, authPath: _authPath, modelsPath: _modelsPath, refresh: _refreshModelList, presets: PROVIDER_PRESETS, json,
    syncDsh: key => {
      try { execFileSync("setx", ["DEEPSEEK_API_KEY", key], { windowsHide: true, timeout: 10000 }); return { dsh: true, dshNote: "dsh 已同步（新开的终端/进程生效）" }; }
      catch { return { dsh: false, dshNote: "dsh 同步失败，模型配置已保存" }; }
    } });
}
export async function handleModelsAdd(res, body) { return onboarding().add(res, body); }
export async function handleModelsDiscover(res, body) { return onboarding().preview(res, body); }
export async function handleModelsVerify(res, body) { return onboarding().verify(res, body); }

// ── dsh 引擎适配层：探测（安装/版本/密钥/web 前台在线）+ 一键拉起 web ──
// 背景：⇄ dsh 链接是硬编码 3080，dsh web 没起时点过去是死页——前端需要真实状态。
const DSH_WEB_PORT = 3080;
export function dshResolveBin() {
  const cands = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    path.join(process.env.ProgramFiles || "", "nodejs", "node_modules", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}
export async function handleDshStatus(res) {
  const bin = dshResolveBin();
  // web 前台探测：本地 3080 有响应即在线（不依赖 dsh 内部实现）
  let webUp = false;
  try {
    const r = await fetch(`http://127.0.0.1:${_port}/`, { signal: AbortSignal.timeout(1500) });
    webUp = r.status < 500;
  } catch {}
  // 密钥：只检查当前进程环境与本机 auth.json，不读取系统注册表或外部服务。
  let keyOk = !!process.env.DEEPSEEK_API_KEY;
  if (!keyOk) { const a = _readJsonFile(_authPath); keyOk = !!a?.deepseek?.key; }
  json(res, 200, { installed: !!bin, bin, webUp, webPort: _port, keyOk });
}
export async function handleDshWebStart(res) {
  const bin = dshResolveBin();
  if (!bin) return json(res, 404, { error: "dsh 引擎未安装：npm i -g @deepseek-ai/dsh" });
  try {
    const probe = await fetch(`http://127.0.0.1:${_port}/`, { signal: AbortSignal.timeout(1500) });
    if (probe.status < 500) return json(res, 200, { ok: true, already: true, url: `http://127.0.0.1:${_port}` });
  } catch {}
  // detached 拉起：独立于元枢生命周期，日志落 dsh-web.log 便于排查
  try {
    const { resolveDshEnv } = await import("./engine/dsh-tool.mjs");
    const logFd = fs.openSync(path.join(os.tmpdir(), "dsh-web.log"), "a");
    const child = spawn(process.execPath, [bin, "web"], {
      detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true, env: resolveDshEnv(),
    });
    child.unref();
    try { fs.closeSync(logFd); } catch {}
  } catch (e) {
    return json(res, 500, { error: "dsh web 启动失败: " + String(e?.message || e).slice(0, 120) });
  }
  // 冷启动需要数秒：轮询最多 15s 等它上线
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await fetch(`http://127.0.0.1:${_port}/`, { signal: AbortSignal.timeout(1000) });
      if (r.status < 500) return json(res, 200, { ok: true, url: `http://127.0.0.1:${_port}` });
    } catch {}
  }
  json(res, 202, { ok: true, pending: true, url: `http://127.0.0.1:${_port}`, note: "dsh web 启动中（冷启动较慢），稍后刷新即可" });
}

// ── 双引擎密钥：状态查询（pi auth.json + dsh DEEPSEEK_API_KEY）──
export function handleKeysStatus(res) {
  const auth = _readJsonFile(_authPath);
  const piProviders = Object.keys(auth).filter(k => auth[k]?.key);
  // 状态判断与执行链路保持一致：进程 env → 本机 auth.json。
  const dshKey = process.env.DEEPSEEK_API_KEY || auth?.deepseek?.key || "";
  json(res, 200, { pi: piProviders, dsh: !!dshKey });
}

// ── 双引擎密钥：应用（pi 写 auth.json + 探测验证 + 刷新模型列表；可选 setx 同步 dsh）──
// ── 声明式策略引擎（Gemini Policy Engine 借鉴）：~/.piweb/policies.json ──
// 规则：tool(glob) + match(参数名→正则) → decision(allow/deny)；deny 优先；内置隧道/密钥/危险操作默认规则
let policiesCache = null, policiesMtime = 0;
export function loadPolicies() {
  try {
    const f = path.join(os.homedir(), ".piweb", "policies.json");
    const st = fs.statSync(f);
    if (st.mtimeMs !== policiesMtime || !policiesCache) {
      policiesCache = JSON.parse(fs.readFileSync(f, "utf8"));
      policiesMtime = st.mtimeMs;
    }
  } catch { policiesCache = { rules: [] }; }
  return policiesCache;
}
export function toolMatch(pat, name) {
  if (pat === "*" || pat === name) return true;
  if (pat.includes("*")) {
    const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(name);
  }
  return false;
}
// 匹配工具调用 → { decision, note }（deny 优先于 allow；无规则默认 allow）
export function policyDecide(tool, args) {
  const { rules = [] } = loadPolicies();
  let deny = null, allow = null;
  for (const r of rules) {
    if (!r.tool || !toolMatch(r.tool, tool)) continue;
    if (r.match) {
      let hit = true;
      for (const [k, re] of Object.entries(r.match)) {
        const v = String(args?.[k] ?? "");
        try { if (!new RegExp(re, "i").test(v)) { hit = false; break; } } catch { hit = false; break; }
      }
      if (!hit) continue;
    }
    if (r.decision === "deny") deny = r;
    else if (r.decision === "allow") allow = r;
  }
  if (deny) return { decision: "deny", note: deny.note || `工具 ${tool} 被策略禁止` };
  if (allow) return { decision: "allow", note: allow.note || "" };
  return { decision: "allow", note: "" };
}

export async function handleKeysApply(res, body) { return onboarding().add(res, body); }
