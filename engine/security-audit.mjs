// ===== engine/security-audit.mjs —— 元枢安全审计（2026-11-13）=====
//
// 背景：用户要把 8787 暴露到公网（frp / IPv6），当前只有一把全局 token。
// 这个模块只读不改：读 server.mjs 的鉴权闸/路由表/监听配置、.token、.gitignore、
// 静态目录实现、CORS 策略、限流接线，逐条给 checkId + 结论 + 一句可执行的修复。
//
// 判据必须贴着元枢的真实实现走，不抄通用清单：
//   - 鉴权闸就是 server.mjs 里 `!isStatic && … && !checkAuth(req)` 那一行；
//   - 白名单只有 isStatic/isSetupStatus/isPublicFeedback/isPublicTvMedia/isPair*/isMusicLogin/isLocalLogin；
//   - /api/ws/file 走 engine/workspace-api.mjs 的 safeJoin（边界 + realpath）；
//   - CORS 走 engine/cors-policy.mjs 的白名单回显。
//
// 返回：{ ok, score, checks: [{ id, severity, ok, title, detail, fix }] }
// ok = 没有 high 级失败；score = 100 - 各失败项扣分（high 18 / medium 8 / low 3），夹在 0..100。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_TTL_MS = 30000;

// 允许匿名访问的 /api/* 只有这些：每一条都能在 server.mjs 里找到对应的 isXxx 白名单变量。
// 新增匿名接口时先改这里再改 server.mjs——审计会拿它对照，白名单外的匿名 /api/* 直接判红。
export const PUBLIC_API_ALLOWLIST = Object.freeze([
  "/api/health",           // 安卓客户端探活，只回 {ok:true}
  "/api/setup/status",     // 首启向导状态，只回 needsSetup
  "/api/setup/claim",      // 首启认领，路由内做 pending + 本机直连校验
  "/api/public/feedback",  // 分发出去的机器回厂反馈，IP 限频
  "/api/tv/media",         // 影院分享页媒体代理，GET only，非媒体 403
  "/api/pair/claim",       // 手机扫码配对（一次性码 + 120s）
  "/api/pair/token",       // 扫码换令牌（绑定认领 IP）
  "/api/pair/status",      // 扫码进度
  "/api/music/login",      // 网易云扫码登录，仅回环
  "/api/auth/local-token", // 本机一键登录，仅回环
]);

export const SEVERITY_WEIGHT = Object.freeze({ high: 18, medium: 8, low: 3 });

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*", ""]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function clip(text, n) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function check(id, severity, ok, title, detail, fix) {
  return { id, severity, ok: !!ok, title, detail: clip(detail, 320), fix: clip(fix, 220) };
}

// ── 读上下文：所有文件只读一次，检查项共享 ─────────────────────────
function readContext({ wsRoot, config = {} }) {
  const repoRoot = path.resolve(config.repoRoot || MODULE_ROOT);
  const workspace = path.resolve(wsRoot || repoRoot);
  const serverFile = path.resolve(config.serverFile || path.join(repoRoot, "server.mjs"));
  const staticFile = path.resolve(config.staticFile || path.join(repoRoot, "lib", "static.mjs"));
  const securityFile = path.resolve(config.securityFile || path.join(repoRoot, "engine", "tools", "security.mjs"));
  const workspaceFile = path.resolve(config.workspaceFile || path.join(repoRoot, "engine", "workspace-api.mjs"));
  const corsFile = path.resolve(config.corsFile || path.join(repoRoot, "engine", "cors-policy.mjs"));
  const rateFile = path.resolve(config.rateFile || path.join(repoRoot, "engine", "rate-limit.mjs"));
  const configFile = path.resolve(config.configFile || path.join(repoRoot, "config.mjs"));
  const rateConfigFile = path.resolve(config.rateConfigFile || path.join(workspace, "记忆", "运行时", "限流.json"));

  const serverSrc = readText(serverFile);
  const configSrc = readText(configFile);
  const staticSrc = readText(staticFile);
  const securitySrc = readText(securityFile);
  const workspaceSrc = readText(workspaceFile);
  const corsSrc = readText(corsFile);
  const rateSrc = readText(rateFile);

  const token = (() => {
    if (config.token) return { value: String(config.token), source: "config.token" };
    for (const [label, file] of [["仓库 .token", path.join(repoRoot, ".token")], ["工作区 .token", path.join(workspace, ".token")]]) {
      const value = readText(file).trim();
      if (value) return { value, source: label };
    }
    return { value: "", source: "缺失" };
  })();

  const host = resolveHost({ config, configSrc, repoRoot });
  const port = Number(config.port || (configSrc.match(/port:\s*parseInt\(env\("PORT"\)\s*\|\|\s*"(\d+)"/) || [])[1] || 8787);
  const corsOrigins = String(config.corsOrigins ?? readCorsOrigins(configSrc) ?? "");

  const rateConfig = (() => {
    const raw = readText(rateConfigFile);
    if (!raw.trim()) return { present: false, file: rateConfigFile, config: null, error: "" };
    try { return { present: true, file: rateConfigFile, config: JSON.parse(raw), error: "" }; }
    catch (e) { return { present: true, file: rateConfigFile, config: null, error: String(e?.message || e).slice(0, 120) }; }
  })();

  return {
    repoRoot, wsRoot: workspace, serverFile, staticFile, securityFile, workspaceFile, corsFile,
    rateFile, configFile, rateConfigFile,
    serverSrc, configSrc, staticSrc, securitySrc, workspaceSrc, corsSrc, rateSrc,
    token, host, port, corsOrigins, rateConfig,
  };
}

function readCorsOrigins(src) {
  const m = src.match(/corsOrigins:\s*env\("CORS_ORIGINS"\)\s*\|\|\s*"([^"]*)"/);
  return m ? m[1] : "";
}

// 监听地址：config.host 优先；否则从 config.mjs 推（LAN=1 走双栈，否则回环），再否则读 .env。
function resolveHost({ config, configSrc, repoRoot }) {
  if (config.host) return String(config.host);
  const envLan = process.env.YUANSHU_LAN === "1" || process.env.PI_WEB_LAN === "1"
    || /^\s*LAN\s*=\s*1\s*$/m.test(readText(path.join(repoRoot, ".env")));
  const tri = configSrc.match(/host:\s*env\("HOST"\)\s*\|\|\s*\(env\("LAN"\)\s*===\s*"1"\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\)/);
  if (tri) return envLan ? tri[1] : tri[2];
  const simple = configSrc.match(/host:\s*env\("HOST"\)\s*\|\|\s*"([^"]+)"/);
  if (simple) return simple[1];
  return "127.0.0.1";
}

// ── 白名单解析：找出鉴权闸里所有 isXxx 变量，收集它们的 /api/* 字面量 ──
// 鉴权闸有两种写法都要认：老的一行 `if (!isStatic … !checkAuth(req))`，
// 新的一行 `const needsAuth = !isStatic …;` + `if (needsAuth)`（2026-11-13 加限流时拆开的）。
const GATE_RE = /(?:const\s+needsAuth\s*=\s*!isStatic[\s\S]{0,2000}?;|if\s*\(\s*!isStatic[\s\S]{0,2000}?!checkAuth\s*\(\s*req\s*\)\s*\))/;

function parseAuthGate(src) {
  const gate = src.match(GATE_RE);
  if (!gate) return { found: false, paths: [], ids: [], has401: false };
  const tail = src.slice(gate.index + gate[0].length, gate.index + gate[0].length + 2500);
  const ids = [...new Set(gate[0].match(/\bis[A-Z][A-Za-z0-9]*/g) || [])];
  const paths = new Set();
  for (const id of ids) {
    const decl = new RegExp(`(?:^|\\n)[ \\t]*(?:const|let|var)[ \\t]+${id}[ \\t]*=`, "m");
    const m = decl.exec(src);
    if (!m) continue;
    const start = m.index;
    const semi = src.indexOf(";", start);
    const stmt = src.slice(start, semi === -1 ? Math.min(src.length, start + 3000) : semi + 1);
    for (const lit of stmt.match(/["'`]\/api\/[^"'`\s]*["'`]/g) || []) {
      paths.add(lit.slice(1, -1));
    }
  }
  return { found: true, paths: [...paths], ids, has401: /json\(\s*res\s*,\s*401/.test(tail) };
}

// ── AUTH-001 全局 token 强度 ───────────────────────────────────────
function checkAuth001(ctx) {
  const { value: token, source } = ctx.token;
  const fix = "把 .token 换成 `node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"` 生成的 48 位随机串并重启元枢，然后用新令牌重新登录客户端";
  if (!token) {
    return check("AUTH-001", "high", false, "全局 token 强度", `没找到令牌（${source}），任何持有空串的请求都进不来，但也说明配置不完整`, fix);
  }
  const problems = [];
  const unique = new Set(token).size;
  if (token.length < 24) problems.push(`长度仅 ${token.length} 位（<24）`);
  if (unique < 10) problems.push(`字符种类仅 ${unique} 种（<10）`);
  const weak = [
    [/^\d+$/, "纯数字"],
    [/^(?:password|passwd|admin|root|token|test|demo|yuanshu|pi-web|love|qwerty|123456|abc123)/i, "字典/默认前缀"],
    [/^[a-zA-Z]+[#@!$%^&*._-]?\d{1,10}$/, "单词+短数字"],
    [/^(.)\1+$/, "单字符重复"],
    [/^(?:change[-_]?me|default|secret)$/i, "默认占位值"],
  ];
  for (const [re, label] of weak) if (re.test(token)) problems.push(`${label}形态，可被字典/规则命中`);
  const ok = problems.length === 0;
  const detail = ok
    ? `令牌 ${token.length} 位、${unique} 种字符，无字典前缀/纯数字特征（来源：${source}）`
    : `令牌 ${token.length} 位、${unique} 种字符：${problems.join("；")}。暴露到公网后 5 次/15 分钟的锁定挡不住离线字典，必须先换掉`;
  return check("AUTH-001", "high", ok, "全局 token 强度", detail, fix);
}

// ── AUTH-002 白名单外的匿名 /api/* ────────────────────────────────
function checkAuth002(ctx) {
  const gate = parseAuthGate(ctx.serverSrc);
  const fix = "把白名单外的 /api/* 从 isStatic/isXxx 匿名条件里删掉（确需匿名就在 handler 内单独校验令牌），只保留健康探活与首启状态";
  if (!gate.found) {
    return check("AUTH-002", "high", false, "是否存在无鉴权路由", "server.mjs 里找不到 `!isStatic … !checkAuth(req)` 鉴权闸，匿名路由无法证明被挡住", fix);
  }
  const unknown = gate.paths.filter((p) => !PUBLIC_API_ALLOWLIST.includes(p));
  const ok = gate.has401 && unknown.length === 0;
  const detail = ok
    ? `全局鉴权闸在 API 路由分发前执行（401 兜底），匿名 /api/* 仅 ${gate.paths.length} 条且都在允许清单内：${gate.paths.join("、")}`
    : `鉴权闸${gate.has401 ? "有" : "没有"} 401 兜底；白名单外的匿名接口：${unknown.join("、") || "（无）"}。这些路径不验令牌就能进`;
  return check("AUTH-002", "high", ok, "是否存在无鉴权路由", detail, fix);
}

function formatHostPort(host, port) {
  const h = String(host || "");
  return (h.includes(":") && !h.startsWith("[")) ? `[${h}]:${port}` : `${h}:${port}`;
}

// ── NET-001 监听地址与暴露风险 ────────────────────────────────────
function checkNet001(ctx) {
  const host = ctx.host;
  const where = formatHostPort(host, ctx.port);
  const isLoopback = LOOPBACK_HOSTS.has(host) || /^127\./.test(host);
  const isWildcard = WILDCARD_HOSTS.has(host);
  const fix = isLoopback
    ? "保持 host 为 127.0.0.1；要远程访问只让 frp/反代连回环，不要把 node 直接绑到 0.0.0.0"
    : "把监听改回 127.0.0.1 并让 frp/反代连回环（HOST=127.0.0.1），公网入口只保留 HTTPS 域名 + 限流 + 强令牌";
  if (isLoopback) {
    return check("NET-001", "low", true, "监听地址与暴露风险", `监听 ${where}，只有本机可达`, fix);
  }
  const tokenStrong = !ctx.checks?.auth001Fail && ctx.token.value.length >= 24;
  const rateOn = ctx.rateConfig.config ? ctx.rateConfig.config.enabled !== false : true;
  const hardened = tokenStrong && rateOn;
  const detail = isWildcard
    ? `监听 ${where}（全网卡/双栈），8787 可被 frp 或公网 IPv6 直连；当前${hardened ? "已有强令牌与限流，但仍无 TLS 与前置反代" : "令牌强度/限流至少一项不达标，等于把入口直接挂公网"}`
    : `监听 ${where}，不是回环地址，局域网/公网可按地址直连`;
  return check("NET-001", hardened ? "medium" : "high", false, "监听地址与暴露风险", detail, fix);
}

// ── RATE-001 是否启用限流 ─────────────────────────────────────────
function rateSummary(rateConfig) {
  const c = rateConfig.config || {};
  return {
    enabled: c.enabled !== false,
    preAuth: Number(c?.preAuth?.limit) || 30,
    chat: Number(c?.routes?.chat?.limit) || 20,
    stream: Number(c?.routes?.stream?.limit) || 10,
    api: Number(c?.routes?.api?.limit) || 120,
    windowMin: Math.round((Number(c?.routes?.chat?.windowMs) || 60000) / 60000),
    exempt: c.exemptLoopback !== false,
  };
}

function checkRate001(ctx) {
  const rl = rateSummary(ctx.rateConfig);
  const fix = "在 `记忆/运行时/限流.json` 里保持 `\"enabled\": true`（缺省即 true），并确认 server.mjs 在 checkAuth 之前调用 `rateLimitGate.preAuth`、之后调用 `rateLimitGate.check`";
  const hasFactory = /export function createRateLimiter\s*\(/.test(ctx.rateSrc);
  const wired = /rateLimitGate\.preAuth/.test(ctx.serverSrc) && /rateLimitGate\.check/.test(ctx.serverSrc) && /429/.test(ctx.serverSrc);
  const configOk = !ctx.rateConfig.error && (ctx.rateConfig.present ? ctx.rateConfig.config?.enabled !== false : true);
  const ok = hasFactory && wired && configOk && rl.enabled;
  const source = ctx.rateConfig.present ? (ctx.rateConfig.error ? `解析失败：${ctx.rateConfig.error}` : "记忆/运行时/限流.json") : "默认值，配置文件可缺省";
  const detail = ok
    ? `已启用（${source}）：预认证 ${rl.preAuth}/分钟/IP、/api/chat ${rl.chat}/分钟、/api/*/stream ${rl.stream}/分钟、其它 /api/* ${rl.api}/分钟；回环${rl.exempt ? "豁免（frp/反代从回环转发时必须带 X-Forwarded-For，否则公网流量会被当成回环）" : "不豁免"}`
    : `未生效：模块 ${hasFactory ? "已导出 createRateLimiter" : "缺 createRateLimiter"}、server 接线 ${wired ? "在" : "缺失"}、配置 ${configOk ? "可解析且 enabled" : "被关掉或损坏"}；来源：${source}`;
  return check("RATE-001", "high", ok, "是否启用限流", detail, fix);
}

// ── AUTH-004 鉴权失败锁定 ─────────────────────────────────────────
function checkAuth004(ctx) {
  const lock = ctx.rateConfig.config?.lockout || {};
  const failures = Number(lock.failures) || 5;
  const lockMs = Number(lock.lockMs) || 900000;
  const wired = /chargeAuthFailure/.test(ctx.serverSrc) && /auth_locked/.test(ctx.serverSrc) && /Retry-After/i.test(ctx.serverSrc);
  const enabled = (ctx.rateConfig.config ? ctx.rateConfig.config.enabled !== false : true);
  const ok = wired && enabled && failures <= 10 && lockMs >= 60000;
  const fix = "把 `记忆/运行时/限流.json` 的 `lockout.failures` 设为 5、`lockout.lockMs` 设为 900000，并确认 `chargeAuthFailure` 接在 401 返回之前";
  const detail = ok
    ? `同一 IP 连续失败 ${failures} 次锁 ${Math.round(lockMs / 60000)} 分钟，成功鉴权清零；命中回 429 + Retry-After`
    : `锁定未生效：失败阈值 ${failures}、锁定时长 ${Math.round(lockMs / 60000)} 分钟、server 接线 ${wired ? "在" : "缺失"}、限流开关 ${enabled ? "开" : "关"}`;
  return check("AUTH-004", "high", ok, "认证失败锁定", detail, fix);
}

// ── SECRET-001 明文凭据是否会被跟踪 ───────────────────────────────
const SECRET_NAMES = [
  /^\.token$/, /\.token$/, /\.token\./,
  /^auth(?:-profiles)?\.json$/, /^credentials\.json$/,
  /^\.env$/, /^\.env\.(?!example$)/,
  /^\.npmrc$/, /^id_rsa$/, /\.pem$/, /\.key$/, /^config\.local\.(?:json|mjs|js)$/,
];

function globToRe(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function isIgnored(relPath, lines) {
  const norm = relPath.replace(/\\/g, "/");
  const base = path.posix.basename(norm);
  for (const raw of lines) {
    let p = raw.trim();
    if (!p || p.startsWith("#") || p.startsWith("!")) continue;
    p = p.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!p) continue;
    if (p.startsWith("**/")) p = p.slice(3);
    const target = p.includes("/") ? norm : base;
    if (globToRe(p).test(target)) return true;
  }
  return false;
}

function listSensitiveFiles(root, { depth = 1, skip = new Set() } = {}) {
  const out = [];
  const walk = (dir, level) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full);
      if (ent.isDirectory()) {
        if (level >= depth) continue;
        if (skip.has(ent.name)) continue;
        walk(full, level + 1);
        continue;
      }
      if (SECRET_NAMES.some((re) => re.test(ent.name))) out.push(rel);
    }
  };
  walk(root, 0);
  return out;
}

const SECRET_ASSIGN_RE = /^[ \t]*(?:export[ \t]+)?([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)[ \t]*=[ \t]*(.+)$/gim;
const PLACEHOLDER_RE = /^(?:<|>|\$\{|process\.env|changeme|change-me|your[-_]|placeholder|example|xxx+$|todo)/i;

function findInlineSecrets(file) {
  const text = readText(file);
  if (!text) return [];
  const hits = [];
  let m;
  SECRET_ASSIGN_RE.lastIndex = 0;
  while ((m = SECRET_ASSIGN_RE.exec(text))) {
    const value = String(m[2] || "").trim().replace(/^['"]|['"]$/g, "");
    if (!value || PLACEHOLDER_RE.test(value)) continue;
    if (value.length < 12 || !/[A-Za-z0-9]{6,}/.test(value)) continue;
    hits.push(m[1]);
  }
  return [...new Set(hits)];
}

function checkSecret001(ctx) {
  const fix = "把 auth.json/.token/.env 这类文件写进 .gitignore（已有 .token* 就再补一行 `auth.json`），并把仓库里已出现的明文密钥换成环境变量";
  const gitignoreFile = path.join(ctx.repoRoot, ".gitignore");
  const gitignore = exists(gitignoreFile) ? readText(gitignoreFile).split(/\r?\n/) : null;
  if (!gitignore) {
    return check("SECRET-001", "high", false, "明文凭据是否被跟踪", "仓库根没有 .gitignore，.token/.env/auth.json 都可能被一次 git add 带进历史", fix);
  }
  const skip = new Set(["node_modules", ".git", "backups", "tmp", "temp", "dist", "build", "models", "生成物", "output", "logs"]);
  const candidates = [...new Set([...listSensitiveFiles(ctx.repoRoot, { depth: 1, skip })])];
  const leaked = [];
  const inline = [];
  for (const rel of candidates) {
    if (!isIgnored(rel, gitignore)) leaked.push(rel);
    const full = path.join(ctx.repoRoot, rel);
    if (/(^|[\\/])\.env(\.[^\\/]+)?$/i.test(rel) || /config\.local\./i.test(rel) || /auth\.json$/i.test(rel)) {
      for (const key of findInlineSecrets(full)) inline.push(`${rel}:${key}`);
    }
  }
  const ok = leaked.length === 0 && inline.length === 0;
  const covered = [["\\.token", ".token"], ["\\.env", ".env"], ["auth\\.json", "auth.json"]]
    .filter(([re]) => gitignore.some((l) => new RegExp(re).test(l)))
    .map(([, label]) => label);
  const detail = ok
    ? `仓库内凭据文件（${candidates.length ? candidates.join("、") : "无"}）都被 .gitignore 覆盖（${covered.join("/")}），未发现明文密钥赋值`
    : `未忽略的凭据：${leaked.join("、") || "（无）"}；明文密钥赋值：${inline.join("、") || "（无）"}。一次提交就会永久留在历史里`;
  return check("SECRET-001", "high", ok, "明文凭据是否被跟踪", detail, fix);
}

// ── PATH-001 静态目录 / /api/ws/file 目录穿越 ─────────────────────
function checkPath001(ctx) {
  const staticGuard = /resolveStaticPath/.test(ctx.staticSrc) && /path\.join\(root/.test(ctx.staticSrc) && /startsWith\(root/.test(ctx.staticSrc);
  const wsGuard = /wsSafePath/.test(ctx.workspaceSrc) && /safeJoin\(/.test(ctx.workspaceSrc);
  const joinGuard = /safeJoin\(/.test(ctx.securitySrc) && /root \+ path\.sep/.test(ctx.securitySrc) && /realpathSync/.test(ctx.securitySrc);
  const signed = /verifySigned/.test(ctx.workspaceSrc) && /sig/.test(ctx.workspaceSrc);
  const ok = staticGuard && wsGuard && joinGuard;
  const fix = "保留 lib/static.mjs 的 `path.join(root, …)` + `startsWith(root)` 兜底，/api/ws/file 继续走 engine/tools/security.mjs 的 safeJoin（边界 + realpath），不要改成直接 path.join(WS_ROOT, 用户输入)";
  const detail = ok
    ? `静态目录先 URL 解析再 path.normalize，越界回 403；/api/ws/file 走 safeJoin（root + path.sep 边界 + realpath 防 symlink）${signed ? "，签名链接另有 verifySigned 校验" : ""}`
    : `防护缺件：static ${staticGuard ? "有" : "无"}、wsSafePath ${wsGuard ? "有" : "无"}、safeJoin 边界/realpath ${joinGuard ? "有" : "无"}`;
  return check("PATH-001", "high", ok, "目录穿越防护", detail, fix);
}

// ── SSE-001 事件流是否鉴权 ────────────────────────────────────────
function checkSse001(ctx) {
  const gate = parseAuthGate(ctx.serverSrc);
  const streams = ["/api/notify/stream", "/api/chat/stream"].filter((p) => ctx.serverSrc.includes(`"${p}"`) || ctx.serverSrc.includes(`'${p}'`));
  const sessionStream = /\/api\/sessions\/\(\[\^\/\]\+\)\/stream/.test(ctx.serverSrc) || /sessions\/\(\[\^\/\]\+\)\/stream/.test(ctx.serverSrc);
  const publicStream = gate.paths.filter((p) => p.endsWith("/stream") || p.includes("/stream"));
  const ok = gate.found && streams.length > 0 && publicStream.length === 0;
  const fix = "不要把任何 /stream 路径加进匿名白名单；浏览器 EventSource 用 Authorization 头或一次性 ticket，不要在 URL 里带长期令牌";
  const detail = ok
    ? `已注册 SSE：${streams.join("、")}${sessionStream ? "、/api/sessions/:id/stream" : ""}；都在全局鉴权闸之后，白名单里没有 /stream`
    : `SSE 鉴权存疑：鉴权闸 ${gate.found ? "在" : "缺失"}、已注册流 ${streams.length} 条、匿名流 ${publicStream.join("、") || "（无）"}`;
  return check("SSE-001", "high", ok, "事件流是否鉴权", detail, fix);
}

// ── CORS-001 是否允许任意 Origin ─────────────────────────────────
function checkCors001(ctx) {
  const configured = String(ctx.corsOrigins || "").split(",").map((s) => s.trim()).filter(Boolean);
  const wildcardConfig = configured.includes("*");
  const reflectsAny = /Access-Control-Allow-Origin['"]?\s*[:,]\s*(?:[^,\n]*\*\s*$|origin\s*\|\|\s*["']\*["'])/m.test(ctx.corsSrc);
  const allowlistImpl = /origins\.has\(|allowedOrigin\(/.test(ctx.corsSrc);
  const wired = /createCorsPolicy\(/.test(ctx.serverSrc) && /corsPolicy\.headers\(/.test(ctx.serverSrc);
  const ok = allowlistImpl && wired && !wildcardConfig && !reflectsAny;
  const fix = "把 CORS_ORIGINS 留空或只写具体前端域名（不要写 *），并让 engine/cors-policy.mjs 继续用白名单回显 Access-Control-Allow-Origin";
  const detail = ok
    ? `CORS 用白名单回显（本地壳 + CORS_ORIGINS），当前额外允许：${configured.length ? configured.join("、") : "无"}；不会反射任意 Origin`
    : `CORS 有问题：白名单实现 ${allowlistImpl ? "在" : "缺失"}、接线 ${wired ? "在" : "缺失"}、配置 ${wildcardConfig ? "含 *" : "正常"}、通配反射 ${reflectsAny ? "存在" : "无"}`;
  return check("CORS-001", "medium", ok, "是否允许任意 Origin", detail, fix);
}

// ── AUTH-003 令牌出现在 URL 查询串 ────────────────────────────────
function checkAuth003(ctx) {
  const queryToken = /searchParams\.get\(\s*["']token["']\s*\)\s*===\s*CONFIG\.token/.test(ctx.serverSrc)
    || /searchParams\.get\(\s*["']token["']\s*\)/.test(ctx.serverSrc);
  const fix = "删除 checkAuth 里读取 `?token=` 的分支，改由 `Authorization: Bearer` 或一次性短时 ticket 鉴权（SSE 也走短票，不要把长期令牌拼进 URL）";
  const detail = queryToken
    ? "checkAuth 接受 `?token=<长期令牌>`：URL 会进浏览器历史、代理访问日志、Referer，frp/反代一旦记录请求行，令牌就长期泄露"
    : "checkAuth 只认 Authorization 头，不接受 URL 查询串里的令牌";
  return check("AUTH-003", "medium", !queryToken, "令牌是否出现在 URL", detail, fix);
}

// ── 主入口 ───────────────────────────────────────────────────────
let _cache = { key: "", at: 0, value: null };

export function auditSecurity({ wsRoot, config = {} } = {}) {
  const ctx = readContext({ wsRoot, config });
  const key = [ctx.repoRoot, ctx.wsRoot, ctx.token.value, ctx.host, ctx.port, ctx.corsOrigins, Math.floor(Date.now() / CACHE_TTL_MS)].join("|");
  if (_cache.key === key && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.value;

  const checks = [];
  const auth001 = checkAuth001(ctx);
  checks.push(auth001);
  ctx.checks = { auth001Fail: !auth001.ok };
  checks.push(checkAuth002(ctx));
  checks.push(checkNet001(ctx));
  checks.push(checkRate001(ctx));
  checks.push(checkAuth004(ctx));
  checks.push(checkSecret001(ctx));
  checks.push(checkPath001(ctx));
  checks.push(checkSse001(ctx));
  checks.push(checkCors001(ctx));
  checks.push(checkAuth003(ctx));

  const penalty = checks.reduce((sum, c) => (c.ok ? sum : sum + (SEVERITY_WEIGHT[c.severity] || 0)), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const ok = !checks.some((c) => !c.ok && c.severity === "high");
  const report = { ok, score, checks };
  _cache = { key, at: Date.now(), value: report };
  return report;
}
