// ===== plugin-store.mjs —— 插件商店：安装/启用/卸载/升级回滚/远程目录/签名（2026-10-29）=====
//
// 设计原则：
//   · 只做"装进来能看懂"的东西：技能包（SKILL.md 目录）、MCP 连接、工具包（声明式工具）。
//   · 工具包**不在服务进程里跑**——落到磁盘后由 toolpack-runtime.mjs 在 worker 里执行，权限逐项校验。
//   · 每个包带 manifest（plugin.json），装之前先校验；不合法就不落地。
//   · 装同名新版本先备份旧目录，可回滚。
//   · 远程目录可选 ed25519 签名校验，requireSigned 打开后只认签名通过的包。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const PLUGIN_DIR_REL = "插件";
export const STATE_REL = path.join("记忆", "运行时", "插件.json");
export const REGISTRY_REL = path.join("记忆", "运行时", "插件源.json");
const BACKUP_DIR = ".backup";
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

const dirOf = (wsRoot) => path.join(String(wsRoot || "."), PLUGIN_DIR_REL);
const stateFile = (wsRoot) => path.join(String(wsRoot || "."), STATE_REL);
const registryFile = (wsRoot) => path.join(String(wsRoot || "."), REGISTRY_REL);

export function readState(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(wsRoot), "utf8"));
    return { v: 1, installed: raw.installed || {}, enabled: raw.enabled || {}, history: raw.history || {}, settings: raw.settings || {} };
  } catch { return { v: 1, installed: {}, enabled: {}, history: {}, settings: {} } }
}

function writeState(wsRoot, st) {
  fs.mkdirSync(path.dirname(stateFile(wsRoot)), { recursive: true });
  fs.writeFileSync(stateFile(wsRoot), JSON.stringify({ v: 1, ...st }, null, 2), "utf8");
}

/**
 * 2026-10-29：fs.cpSync 在 Node 25.8.2 + Windows 上会硬崩（0xC0000409），
 * 这里自己递归拷贝，只用 readdirSync/copyFileSync。
 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, d.name);
    const to = path.join(dest, d.name);
    if (d.isDirectory()) copyDir(from, to);
    else if (d.isFile()) fs.copyFileSync(from, to);
  }
}
function safeChild(root, name) {
  const p = path.resolve(root, String(name || ""));
  const r = path.resolve(root);
  return p === r || p.startsWith(r + path.sep) ? p : null;
}

/** 校验 manifest。返回 {ok, error, manifest} */
export function validateManifest(m = {}) {
  const bad = (error) => ({ ok: false, error });
  if (!m || typeof m !== "object") return bad("manifest 不是对象");
  if (!ID_RE.test(String(m.id || ""))) return bad("id 只能是小写字母/数字/._-（2~64 字符）");
  if (!/^\d+\.\d+\.\d+/.test(String(m.version || ""))) return bad("version 需要形如 1.0.0");
  if (!String(m.name || "").trim()) return bad("name 不能为空");
  if (!["skill", "mcp", "toolpack"].includes(String(m.type || ""))) return bad("type 目前只支持 skill / mcp / toolpack");
  const out = {
    id: String(m.id),
    name: String(m.name).slice(0, 60),
    version: String(m.version),
    type: String(m.type),
    description: String(m.description || "").slice(0, 300),
    author: String(m.author || "").slice(0, 60),
    permissions: Array.isArray(m.permissions) ? m.permissions.map(String).slice(0, 12) : [],
    payload: m.payload || {},
    sig: m.sig ? String(m.sig) : "",
  };
  if (out.type === "skill") {
    const md = String(out.payload["SKILL.md"] || "");
    if (!md.trim()) return bad("技能包必须带 payload['SKILL.md']");
    if (!/^#\s|^---/m.test(md)) return bad("SKILL.md 需要以标题或 frontmatter 开头");
  }
  if (out.type === "mcp") {
    const s = out.payload.mcp || {};
    if (!String(s.command || "").trim()) return bad("MCP 包必须带 payload.mcp.command");
    if (!Array.isArray(s.args || [])) return bad("payload.mcp.args 必须是数组");
  }
  if (out.type === "toolpack") {
    const tools = out.payload.tools;
    if (!Array.isArray(tools) || !tools.length) return bad("工具包必须带 payload.tools 数组");
    for (const t of tools) {
      if (!/^[a-z][a-z0-9_]{2,40}$/.test(String(t?.name || ""))) return bad(`工具名不合法：${t?.name || "?"}（小写字母开头，字母数字下划线）`);
      if (!String(t?.description || "").trim()) return bad(`工具 ${t?.name} 缺少 description`);
      if (!String(t?.body || "").trim()) return bad(`工具 ${t?.name} 缺少 body（函数体，返回字符串）`);
    }
  }
  return { ok: true, manifest: out };
}

/** manifest 的签名载荷：只认 id/version/type/payload，避免"改描述"绕过签名。 */
export function signaturePayload(manifest = {}) {
  const canonical = {
    id: String(manifest.id || ""),
    version: String(manifest.version || ""),
    type: String(manifest.type || ""),
    payload: manifest.payload || {},
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function verifySignature(manifest = {}, { publicKey = "" } = {}) {
  const sig = String(manifest?.sig || "");
  if (!sig) return { ok: false, reason: "未签名" };
  const key = String(publicKey || "").trim();
  if (!key) return { ok: false, reason: "没有配置公钥（无法校验签名）" };
  try {
    const ok = crypto.verify(null, Buffer.from(signaturePayload(manifest), "utf8"), crypto.createPublicKey(key), Buffer.from(sig, "base64"));
    return ok ? { ok: true, reason: "" } : { ok: false, reason: "签名不匹配" };
  } catch (e) {
    return { ok: false, reason: `签名校验失败：${String(e?.message || e).slice(0, 120)}` };
  }
}

/** 作者侧：给 manifest 签名（测试与打包脚本用）。 */
export function signManifest(manifest = {}, { privateKey = "" } = {}) {
  if (!privateKey) throw new Error("privateKey 必填");
  const sig = crypto.sign(null, Buffer.from(signaturePayload(manifest), "utf8"), crypto.createPrivateKey(privateKey));
  return { ...manifest, sig: sig.toString("base64") };
}

export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** 安装：把 payload 写到 插件/<id>/，旧版本先备份，记录历史。 */
export function installPlugin(wsRoot, manifest, { at = Date.now(), keepBackup = true } = {}) {
  const v = validateManifest(manifest);
  if (!v.ok) return { ok: false, error: v.error };
  const m = v.manifest;
  const root = path.resolve(dirOf(wsRoot));
  const target = safeChild(root, m.id);
  if (!target) return { ok: false, error: "id 越界（路径不安全）" };
  const st0 = readState(wsRoot);
  const prev = st0.installed[m.id];
  let backupDir = "";
  try {
    fs.mkdirSync(target, { recursive: true });
    if (keepBackup && prev) {
      const backup = path.join(root, BACKUP_DIR, `${m.id}-v${prev.version}-${at}`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (fs.existsSync(target)) copyDir(target, backup);
      backupDir = backup;
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    if (m.type === "skill") {
      for (const [name, content] of Object.entries(m.payload || {})) {
        if (typeof content !== "string") continue;
        const f = safeChild(target, name);
        if (!f) continue;
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content, "utf8");
      }
    } else if (m.type === "mcp") {
      fs.writeFileSync(path.join(target, "mcp.json"), JSON.stringify(m.payload.mcp, null, 2), "utf8");
    } else {
      fs.writeFileSync(path.join(target, "tools.json"), JSON.stringify(m.payload.tools, null, 2), "utf8");
    }
    fs.writeFileSync(path.join(target, "plugin.json"), JSON.stringify({
      id: m.id, name: m.name, version: m.version, type: m.type,
      description: m.description, author: m.author, permissions: m.permissions, installedAt: at,
    }, null, 2), "utf8");
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
  const st = readState(wsRoot);
  st.installed[m.id] = {
    id: m.id, name: m.name, version: m.version, type: m.type,
    description: m.description, installedAt: at, dir: target,
    // 2026-10-30：权限必须记下来——工具包运行时按它放行，不记就等于永远没权限
    permissions: m.permissions,
  };
  if (st.enabled[m.id] === undefined) st.enabled[m.id] = true;
  st.history = st.history || {};
  st.history[m.id] = [...(st.history[m.id] || []), {
    version: m.version, at, fromVersion: prev?.version || "", backupDir: keepBackup ? backupDir : "",
  }].slice(-20);
  writeState(wsRoot, st);
  try { pruneBackups(wsRoot, m.id, { keep: 3 }) } catch {}
  return { ok: true, plugin: st.installed[m.id], backupDir };
}

export function uninstallPlugin(wsRoot, id) {
  const st = readState(wsRoot);
  if (!st.installed[id]) return { ok: false, error: "没有这个插件" };
  const root = path.resolve(dirOf(wsRoot));
  const target = safeChild(root, id);
  if (target) { try { fs.rmSync(target, { recursive: true, force: true }) } catch {} }
  delete st.installed[id];
  delete st.enabled[id];
  writeState(wsRoot, st);
  return { ok: true };
}

/** 全局设置（面板开关等）。 */
export function setSetting(wsRoot, key, value) {
  const st = readState(wsRoot);
  st.settings = { ...(st.settings || {}), [String(key)]: value };
  writeState(wsRoot, st);
  return { ok: true, key: String(key), value };
}

/** 只留最近 keep 份备份，返回删掉几个。 */
export function pruneBackups(wsRoot, id, { keep = 3 } = {}) {
  const root = path.resolve(dirOf(wsRoot));
  const dir = safeChild(root, path.join(BACKUP_DIR));
  if (!dir) return { ok: false, error: "路径不安全" };
  let removed = 0;
  try {
    const names = fs.readdirSync(dir).filter((n) => n.startsWith(`${id}-v`)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - Math.max(1, keep)))) {
      fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      removed += 1;
    }
  } catch { /* 没有备份目录 */ }
  return { ok: true, removed };
}

/** 某插件的备份列表（新在前） */
export function listBackups(wsRoot, id) {
  const root = path.resolve(dirOf(wsRoot));
  const dir = safeChild(root, path.join(BACKUP_DIR));
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith(`${id}-v`)).sort().reverse()
      .map((n) => ({ name: n, path: path.join(dir, n) }));
  } catch { return [] }
}

export function setEnabled(wsRoot, id, on) {
  const st = readState(wsRoot);
  if (!st.installed[id]) return { ok: false, error: "没有这个插件" };
  st.enabled[id] = !!on;
  writeState(wsRoot, st);
  return { ok: true, enabled: !!on };
}

export function listInstalled(wsRoot) {
  const st = readState(wsRoot);
  const root = path.resolve(dirOf(wsRoot));
  return Object.values(st.installed).map((p) => {
    const dir = safeChild(root, p.id);
    let exists = false;
    try { exists = !!(dir && fs.statSync(path.join(dir, "plugin.json")).isFile()) } catch {}
    return { ...p, enabled: st.enabled[p.id] !== false, exists };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), "zh"));
}

export function versionHistory(wsRoot, id) {
  const st = readState(wsRoot);
  return (st.history?.[id] || []).slice().reverse();
}

/** 回滚到上一个可用的备份版本 */
export function rollbackPlugin(wsRoot, id) {
  const hist = versionHistory(wsRoot, id);
  const prev = hist.find((h) => h.backupDir);
  if (!prev) return { ok: false, error: "没有可回滚的上一版" };
  const root = path.resolve(dirOf(wsRoot));
  const target = safeChild(root, id);
  const backup = safeChild(root, path.relative(root, prev.backupDir));
  if (!target || !backup) return { ok: false, error: "路径不安全" };
  if (!fs.existsSync(backup)) return { ok: false, error: "备份目录已不在（可能被手删）" };
  try {
    fs.rmSync(target, { recursive: true, force: true });
    copyDir(backup, target);
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) } }
  const st = readState(wsRoot);
  if (st.installed[id]) {
    st.installed[id].version = prev.fromVersion || st.installed[id].version;
    st.installed[id].rolledBackAt = Date.now();
  }
  writeState(wsRoot, st);
  return { ok: true, version: st.installed[id]?.version };
}

export function readCatalog(wsRoot) {
  const file = path.join(String(wsRoot || "."), "插件", "catalog.json");
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) } catch {
    return { ok: true, items: [], source: file, error: "没有 catalog.json（可放一个到 工作区/插件/catalog.json）" };
  }
  const items = Array.isArray(raw?.plugins) ? raw.plugins : Array.isArray(raw) ? raw : [];
  const validated = [];
  for (const item of items) {
    const v = validateManifest(item);
    if (v.ok) validated.push({ ...v.manifest, payload: undefined, sig: undefined, installable: true });
    else validated.push({ id: String(item?.id || "?"), name: String(item?.name || item?.id || "?"), version: String(item?.version || "?"), type: String(item?.type || "?"), description: String(item?.description || ""), installable: false, error: v.error });
  }
  return { ok: true, items: validated, source: file };
}

/** 某个包的可用版本（catalog 条目可以带 versions: [{version,payload,sig}]） */
export function listVersions(wsRoot, id) {
  const file = path.join(String(wsRoot || '.'), '插件', 'catalog.json');
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
  const items = Array.isArray(raw?.plugins) ? raw.plugins : Array.isArray(raw) ? raw : [];
  const item = items.find((x) => String(x?.id) === String(id));
  if (!item) return [];
  const versions = Array.isArray(item.versions) ? item.versions : [];
  const list = versions
    .map((v) => ({ version: String(v?.version || ''), payload: v?.payload, sig: v?.sig }))
    .filter((v) => v.version);
  if (!list.length && item.version) list.push({ version: String(item.version), payload: item.payload, sig: item.sig });
  return list;
}

export function installFromCatalog(wsRoot, id, version = '') {
  const file = path.join(String(wsRoot || "."), "插件", "catalog.json");
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return { ok: false, error: "读不到 catalog.json" } }
  const items = Array.isArray(raw?.plugins) ? raw.plugins : Array.isArray(raw) ? raw : [];
  const item = items.find((x) => String(x?.id) === String(id));
  if (!item) return { ok: false, error: "目录里没有这个插件" };
  if (version) {
    const v = (Array.isArray(item.versions) ? item.versions : []).find((x) => String(x?.version) === String(version));
    if (!v) return { ok: false, error: `目录里没有 ${version} 这个版本` };
    return installPlugin(wsRoot, { ...item, version: String(version), payload: v.payload, sig: v.sig });
  }
  return installPlugin(wsRoot, item);
}

// ── 远程目录 ─────────────────────────────────────────────

export function readRegistryConfig(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(wsRoot), "utf8"));
    return {
      url: String(raw.url || ""),
      requireSigned: raw.requireSigned === true,
      publicKey: String(raw.publicKey || ""),
      lastFetchAt: Number(raw.lastFetchAt) || 0,
      lastError: String(raw.lastError || ""),
      cached: raw.cached || null,
    };
  } catch {
    return { url: "", requireSigned: false, publicKey: "", lastFetchAt: 0, lastError: "", cached: null };
  }
}

export function writeRegistryConfig(wsRoot, patch = {}) {
  const cur = readRegistryConfig(wsRoot);
  const next = {
    url: patch.url !== undefined ? String(patch.url || "") : cur.url,
    requireSigned: patch.requireSigned !== undefined ? patch.requireSigned === true : cur.requireSigned,
    publicKey: patch.publicKey !== undefined ? String(patch.publicKey || "") : cur.publicKey,
    lastFetchAt: cur.lastFetchAt,
    lastError: "",
    cached: cur.cached,
  };
  fs.mkdirSync(path.dirname(registryFile(wsRoot)), { recursive: true });
  fs.writeFileSync(registryFile(wsRoot), JSON.stringify({ v: 1, ...next }, null, 2), "utf8");
  return next;
}

export async function fetchRemoteCatalog(wsRoot, { fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now } = {}) {
  const cfg = readRegistryConfig(wsRoot);
  if (!cfg.url) return { ok: false, error: "还没有配置远程源（url）", items: [] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(cfg.url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const items = Array.isArray(raw?.plugins) ? raw.plugins : Array.isArray(raw) ? raw : [];
    const checked = items.map((m) => {
      const v = validateManifest(m);
      const sig = verifySignature(m, { publicKey: cfg.publicKey });
      const base = v.ok
        ? { ...v.manifest, payload: undefined, sig: undefined }
        : { id: String(m?.id || "?"), name: String(m?.name || "?"), version: String(m?.version || "?"), type: String(m?.type || "?"), description: String(m?.description || "") };
      if (cfg.requireSigned && !sig.ok) return { ...base, installable: false, error: `签名不通过：${sig.reason}`, signed: false };
      return { ...base, installable: v.ok, error: v.ok ? undefined : v.error, signed: sig.ok, signReason: sig.reason };
    });
    const next = { ...cfg, lastFetchAt: now(), lastError: "", cached: { at: now(), items: checked, raw: items } };
    fs.mkdirSync(path.dirname(registryFile(wsRoot)), { recursive: true });
    fs.writeFileSync(registryFile(wsRoot), JSON.stringify({ v: 1, ...next }, null, 2), "utf8");
    return { ok: true, items: checked, signedRequired: cfg.requireSigned };
  } catch (e) {
    const next = { ...cfg, lastError: String(e?.message || e).slice(0, 160) };
    fs.mkdirSync(path.dirname(registryFile(wsRoot)), { recursive: true });
    fs.writeFileSync(registryFile(wsRoot), JSON.stringify({ v: 1, ...next }, null, 2), "utf8");
    return { ok: false, error: next.lastError, items: cfg.cached?.items || [] };
  } finally {
    clearTimeout(timer);
  }
}

export function remoteCatalogItems(wsRoot) {
  const cfg = readRegistryConfig(wsRoot);
  return Array.isArray(cfg.cached?.items) ? cfg.cached.items : [];
}

export function installFromRemote(wsRoot, id) {
  const cfg = readRegistryConfig(wsRoot);
  const raw = Array.isArray(cfg.cached?.raw) ? cfg.cached.raw : [];
  const item = raw.find((x) => String(x?.id) === String(id));
  if (!item) return { ok: false, error: "远程目录里没有这个插件（先刷新远程源）" };
  if (cfg.requireSigned && !verifySignature(item, { publicKey: cfg.publicKey }).ok) {
    return { ok: false, error: "这个包签名不通过，按当前设置不能装" };
  }
  return installPlugin(wsRoot, item);
}

/** 工具包里的工具定义（给运行时构造工具用） */
export function readToolpack(wsRoot, id) {
  const st = readState(wsRoot);
  const meta = st.installed[id];
  if (!meta || meta.type !== "toolpack") return null;
  if (st.enabled[id] === false) return null;
  const file = path.join(String(wsRoot || "."), PLUGIN_DIR_REL, id, "tools.json");
  try {
    const tools = JSON.parse(fs.readFileSync(file, "utf8"));
    return { id, name: meta.name, version: meta.version, tools: Array.isArray(tools) ? tools : [] };
  } catch { return null }
}

export function listToolpacks(wsRoot) {
  return listInstalled(wsRoot).filter((p) => p.type === "toolpack").map((p) => readToolpack(wsRoot, p.id)).filter(Boolean);
}
