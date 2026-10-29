// ===== plugin-store.mjs —— 插件商店的安装/启用/卸载（2026-10-29）=====
//
// 设计原则（跟元枢一贯的取舍一致）：
//   · 只做"装进来能看懂"的东西：技能包（SKILL.md 目录）和 MCP 连接两种，先不做任意 JS 执行。
//   · 装 = 落到 工作区/插件/<id>/，技能自动被 context-loader 扫到；MCP 由用户点连接（不自动连）。
//   · 每个包带 manifest（plugin.json），装之前先校验；不合法就不落地。
//   · 记录在 记忆/运行时/插件.json：{installed:{id:{...}}, enabled:{id:bool}}
//
// 为什么不做 url 直装：现在的信任模型是"工作区里的人装的"，远程 zip 需要签名/来源验证，
// 那是下一步；先支持"目录里的包（catalog 内嵌 payload）"。
import fs from "node:fs";
import path from "node:path";

export const PLUGIN_DIR_REL = path.join("插件");
export const STATE_REL = path.join("记忆", "运行时", "插件.json");
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

const dirOf = (wsRoot) => path.join(String(wsRoot || "."), PLUGIN_DIR_REL);
const stateFile = (wsRoot) => path.join(String(wsRoot || "."), STATE_REL);

export function readState(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(wsRoot), "utf8"));
    return { v: 1, installed: raw.installed || {}, enabled: raw.enabled || {} };
  } catch { return { v: 1, installed: {}, enabled: {} } }
}

function writeState(wsRoot, st) {
  fs.mkdirSync(path.dirname(stateFile(wsRoot)), { recursive: true });
  fs.writeFileSync(stateFile(wsRoot), JSON.stringify({ v: 1, ...st }, null, 2), "utf8");
}

/** 校验 manifest。返回 {ok, error, manifest} */
export function validateManifest(m = {}) {
  const bad = (error) => ({ ok: false, error });
  if (!m || typeof m !== "object") return bad("manifest 不是对象");
  if (!ID_RE.test(String(m.id || ""))) return bad("id 只能是小写字母/数字/._-（2~64 字符）");
  if (!/^\d+\.\d+\.\d+/.test(String(m.version || ""))) return bad("version 需要形如 1.0.0");
  if (!String(m.name || "").trim()) return bad("name 不能为空");
  if (!["skill", "mcp"].includes(String(m.type || ""))) return bad("type 目前只支持 skill / mcp");
  const out = {
    id: String(m.id),
    name: String(m.name).slice(0, 60),
    version: String(m.version),
    type: String(m.type),
    description: String(m.description || "").slice(0, 300),
    author: String(m.author || "").slice(0, 60),
    permissions: Array.isArray(m.permissions) ? m.permissions.map(String).slice(0, 12) : [],
    payload: m.payload || {},
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
  return { ok: true, manifest: out };
}

function safeChild(root, name) {
  const p = path.resolve(root, name);
  const r = path.resolve(root);
  return p === r || p.startsWith(r + path.sep) ? p : null;
}

/** 安装：把 payload 写到 插件/<id>/，记录状态。已存在则覆盖（先删目录防残留）。 */
export function installPlugin(wsRoot, manifest, { at = Date.now() } = {}) {
  const v = validateManifest(manifest);
  if (!v.ok) return { ok: false, error: v.error };
  const m = v.manifest;
  const root = path.resolve(dirOf(wsRoot));
  const target = safeChild(root, m.id);
  if (!target) return { ok: false, error: "id 越界（路径不安全）" };
  try {
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
    } else {
      fs.writeFileSync(path.join(target, "mcp.json"), JSON.stringify(m.payload.mcp, null, 2), "utf8");
    }
    fs.writeFileSync(path.join(target, "plugin.json"), JSON.stringify({
      id: m.id, name: m.name, version: m.version, type: m.type,
      description: m.description, author: m.author, permissions: m.permissions, installedAt: at,
    }, null, 2), "utf8");
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
  const st = readState(wsRoot);
  st.installed[m.id] = { id: m.id, name: m.name, version: m.version, type: m.type, description: m.description, installedAt: at, dir: target };
  if (st.enabled[m.id] === undefined) st.enabled[m.id] = true;
  writeState(wsRoot, st);
  return { ok: true, plugin: st.installed[m.id] };
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

export function setEnabled(wsRoot, id, on) {
  const st = readState(wsRoot);
  if (!st.installed[id]) return { ok: false, error: "没有这个插件" };
  st.enabled[id] = !!on;
  writeState(wsRoot, st);
  return { ok: true, enabled: !!on };
}

/** 已安装列表（带 enabled）+ 目录里实际存在的标记（手删过能看出来） */
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

/** 可安装目录：从插件目录下的 catalog.json 读（内嵌 payload，离线可用） */
export function readCatalog(wsRoot) {
  const file = path.join(String(wsRoot || "."), "插件", "catalog.json");
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return { ok: true, items: [], source: file, error: "没有 catalog.json（可放一个到 工作区/插件/catalog.json）" } }
  const items = Array.isArray(raw?.plugins) ? raw.plugins : Array.isArray(raw) ? raw : [];
  const validated = [];
  for (const item of items) {
    const v = validateManifest(item);
    if (v.ok) validated.push({ ...v.manifest, payload: undefined, installable: true });
    else validated.push({ id: String(item?.id || "?"), name: String(item?.name || item?.id || "?"), version: String(item?.version || "?"), type: String(item?.type || "?"), description: String(item?.description || ""), installable: false, error: v.error });
  }
  return { ok: true, items: validated, source: file };
}

/** 按 id 从 catalog 取原始 manifest（含 payload）并安装 */
export function installFromCatalog(wsRoot, id) {
  const file = path.join(String(wsRoot || "."), "插件", "catalog.json");
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return { ok: false, error: "读不到 catalog.json" } }
  const items = Array.isArray(raw?.plugins) ? raw.plugins : Array.isArray(raw) ? raw : [];
  const item = items.find((x) => String(x?.id) === String(id));
  if (!item) return { ok: false, error: "目录里没有这个插件" };
  return installPlugin(wsRoot, item);
}
