// 元枢沙箱阶梯（dsh：read-only → workspace-write → danger，只升不降，拒绝词模型可见）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeToolPath } from "./tools/security.mjs";

// 系统本体目录（仓库根）。工具层的 write/edit 本来就是「工作区 + 系统目录」双根白名单
// （unified-tools resolveToolPath），沙箱必须用同一张白名单，否则工具层放行的路径在沙箱先被拦。
export const SYSTEM_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

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
  const roots = (Array.isArray(wsRoot) ? wsRoot : [wsRoot]).filter(Boolean);
  if (!p || !roots.length) return true;
  const raw = normalizeToolPath(p);
  return roots.some((r0) => {
    const root = path.resolve(r0);
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
    const a = abs.replace(/\\/g, "/").toLowerCase();
    const r = root.replace(/\\/g, "/").toLowerCase();
    return a === r || a.startsWith(r + "/");
  });
}

// 沙箱写白名单 = 工作区 + 系统本体目录（与工具层一致）。
export function sandboxWriteRoots(wsRoot) {
  const roots = (Array.isArray(wsRoot) ? wsRoot : [wsRoot]).filter(Boolean);
  return roots.length ? [...roots, SYSTEM_ROOT] : [];
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
  // read 不在这里卡路径：工具层对双根外的绝对路径本就开放只读（凭据文件由 secrets-guard 拦），
  // 沙箱再拦一次只会制造「看得见、读不到」。写类只认双根白名单。
  if ((name === "write" || name === "edit") && args?.path && wsRoot) {
    if (current !== "danger-full-access" && !pathInWorkspace(sandboxWriteRoots(wsRoot), args.path)) {
      return {
        ok: false, escalate: false, denied: true, tag: sandboxDeniedTag(current),
        note: `路径超出可写范围：写/改只限工作区与系统目录（${sandboxWriteRoots(wsRoot).map((r) => String(r).replace(/\\/g, "/")).join("、")}）。临时文件请放工作区 tmp/。`,
      };
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
      // 定时/微信/后台这类通道没人能当场点卡片：告诉模型去哪里放权，而不是让它换写法重试。
      return { ok: false, denied: true, tag: hit.tag, note: `${hit.note}（无应答者，fail-closed：这条通道没人能当场批。要做就请伙伴在元枢对话里发起，或在「授权中心 → 本会话执行权限」预先放开）`, mode };
    }
    const outcome = await ask(name, args, hit.note);
    if (outcome === "allowed-once") {
      return { ok: true, mode: applyEscalation(mode, { to: hit.to, approved: true }) };
    }
    return { ok: false, denied: true, tag: hit.tag, note: `${hit.note}（伙伴没批准这次升级：不要换个写法绕过去，先问清楚要不要做）`, mode };
  }
  return { ok: false, denied: true, tag: hit.tag, note: hit.note, mode };
}
