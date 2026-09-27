// 元枢沙箱阶梯（dsh：read-only → workspace-write → danger，只升不降，拒绝词模型可见）
import path from "node:path";

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

export const BASH_DANGER_RE = /(rm\s+-rf|del\s+\/f|rd\s+\/s|git\s+push\s+--force|git\s+reset\s+--hard|git\s+clean\s+-f|cloudflared|ngrok|trycloudflare|frpc|localtunnel|setx\s+DEEPSEEK_API_KEY|type\s+.*auth\.json|cat\s+.*auth\.json|netsh.*dns)/i;

const READ_ONLY_TOOLS = new Set([
  "read", "web_search", "search_files", "activate_skill", "list_channels",
]);

export function sandboxRank(mode) {
  const i = SANDBOX_MODES.indexOf(mode);
  return i < 0 ? 1 : i;
}

export function canEscalate(from, to) {
  return sandboxRank(to) > sandboxRank(from);
}

export function sandboxDeniedTag(mode) {
  return `[sandbox: file access denied under ${mode} mode]`;
}

export function toolSandboxNeed(name, args = {}) {
  const n = String(name || "");
  if (READ_ONLY_TOOLS.has(n)) return "read-only";
  if (n === "bash" || n === "dsh") {
    return BASH_DANGER_RE.test(String(args.command || args.cmd || "")) ? "danger-full-access" : "workspace-write";
  }
  return "workspace-write";
}

export function pathInWorkspace(wsRoot, p) {
  if (!p || !wsRoot) return true;
  const root = path.resolve(wsRoot);
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const a = abs.replace(/\\/g, "/").toLowerCase();
  const r = root.replace(/\\/g, "/").toLowerCase();
  return a === r || a.startsWith(r + "/");
}

export function checkSandboxCall({
  mode = "workspace-write",
  name,
  args = {},
  requestedMode,
  justification,
  wsRoot = "",
} = {}) {
  const current = SANDBOX_MODES.includes(mode) ? mode : "workspace-write";
  const req = requestedMode || args.sandbox_permissions || "";
  const why = justification ?? args.justification;
  if (req) {
    if (!String(why || "").trim() || String(why).trim().length < 8) {
      return { ok: false, escalate: false, denied: true, tag: sandboxDeniedTag(current), note: "sandbox_permissions 必须配非空 justification" };
    }
    if (sandboxRank(req) < sandboxRank(current)) {
      return { ok: false, escalate: false, denied: true, tag: sandboxDeniedTag(current), note: "权限只升不降" };
    }
    if (sandboxRank(req) > sandboxRank(current)) {
      return { ok: false, escalate: true, to: req, tag: sandboxDeniedTag(current), note: `需要升级到 ${req}` };
    }
  }
  const need = toolSandboxNeed(name, args);
  if (sandboxRank(need) > sandboxRank(current)) {
    return {
      ok: false,
      escalate: true,
      to: need,
      tag: sandboxDeniedTag(current),
      note: `工具 ${name} 需要 ${need}。当前 ${current}。升级请带 sandbox_permissions + justification。`,
    };
  }
  if ((name === "read" || name === "write" || name === "edit") && args?.path && wsRoot) {
    if (current !== "danger-full-access" && !pathInWorkspace(wsRoot, args.path)) {
      return { ok: false, escalate: false, denied: true, tag: sandboxDeniedTag(current), note: "路径超出工作区" };
    }
  }
  return { ok: true, mode: current };
}

export function applyEscalation(mode, { to, approved } = {}) {
  if (!approved || !canEscalate(mode, to)) return mode;
  return to;
}

export async function gateSandboxCall({
  mode = "workspace-write",
  name,
  args = {},
  wsRoot = "",
  ask,
} = {}) {
  const hit = checkSandboxCall({ mode, name, args, wsRoot });
  if (hit.ok) return { ok: true, mode };
  if (hit.escalate) {
    if (typeof ask !== "function") {
      return { ok: false, denied: true, tag: hit.tag, note: `${hit.note}（无应答者，fail-closed）`, mode };
    }
    const outcome = await ask(name, args, hit.note);
    if (outcome === "allowed-once") {
      return { ok: true, mode: applyEscalation(mode, { to: hit.to, approved: true }) };
    }
    return { ok: false, denied: true, tag: hit.tag, note: hit.note, mode };
  }
  return { ok: false, denied: true, tag: hit.tag, note: hit.note, mode };
}
