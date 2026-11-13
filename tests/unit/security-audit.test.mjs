// engine/security-audit.mjs 单测（2026-11-13）：8 条。
// 做法：在临时目录造一个「迷你元枢仓库」（server.mjs/config.mjs/lib/static.mjs/… 的文本特征），
// 好配置下 10 条全绿，坏配置下对应 checkId 必须红；最后跑 CLI 验退出码。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { auditSecurity, PUBLIC_API_ALLOWLIST } from "../../engine/security-audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "scripts", "security-audit.mjs");
const REQUIRED_IDS = ["AUTH-001", "AUTH-002", "NET-001", "RATE-001", "SECRET-001", "PATH-001", "SSE-001", "CORS-001"];

function makeRepo(overrides = {}) {
  const opts = {
    token: crypto.randomBytes(24).toString("hex"),
    publicHost: false,
    publicExtra: "",
    queryToken: false,
    rateWired: true,
    lockoutWired: true,
    rateEnabled: true,
    rateConfigMalformed: false,
    rateConfigNone: false,
    corsWildcard: false,
    traversalGuard: true,
    leakSecret: "", // "auth.json" | "inline"
    ...overrides,
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-audit-"));
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
  };

  write(".token", `${opts.token}\n`);
  write(".gitignore", "node_modules/\n.token*\n*.token\n.env\n.env.*\n!/.env.example\n*.log\n");
  if (opts.publicHost) write(".env", "LAN=1\n");
  write("config.mjs", `import { env } from "./engine/env.mjs";
export const CONFIG = {
  port: parseInt(env("PORT") || "8787", 10),
  host: ${opts.publicHost ? 'env("HOST") || (env("LAN") === "1" ? "::" : "127.0.0.1")' : 'env("HOST") || "127.0.0.1"'},
  corsOrigins: env("CORS_ORIGINS") || "",
  token: loadToken(),
};
`);

  const staticExtra = opts.publicExtra ? ` || url.pathname === "${opts.publicExtra}"` : "";
  const needsAuth = "!isStatic && !isSignedFile && !isSetupStatus && !isPublicFeedback && !isPublicTvMedia && !isMusicLogin && !isPairPage && !isPairPublic && !isLocalLogin";
  const rateHelper = opts.rateWired
    ? `function sendRateLimited(res, guard) {
  return json(res, 429, { error: "请求过于频繁", code: "RATE_LIMITED" }, { "Retry-After": String(guard.retryAfter || 1) });
}
`
    : "";
  const rateBlock = opts.rateWired
    ? `    const needsAuth = ${needsAuth};
    if (needsAuth) {
      const pre = rateLimitGate.preAuth(clientIpOf(req), { credential: !!req.headers.authorization, pathname: url.pathname });
      if (!pre.ok) return sendRateLimited(res, pre);
      if (!checkAuth(req)) {
${opts.lockoutWired
      ? `        const fail = rateLimitGate.chargeAuthFailure(clientIpOf(req), url.pathname, req.method);
        if (fail.locked) return sendRateLimited(res, { reason: "auth_locked", retryAfter: fail.retryAfter });
`
      : ""}        return json(res, 401, { error: "未授权，请提供访问令牌" });
      }
      const guard = rateLimitGate.check(clientIpOf(req), url.pathname, req.method);
      if (!guard.ok) return sendRateLimited(res, guard);
    }`
    : `    if (${needsAuth} && !checkAuth(req)) {
      return json(res, 401, { error: "未授权，请提供访问令牌" });
    }`;

  write("server.mjs", `import { createRateLimiter } from "./engine/rate-limit.mjs";
import { createCorsPolicy } from "./engine/cors-policy.mjs";
${opts.rateWired ? "const rateLimitGate = createRateLimiter({ wsRoot: WS_ROOT });" : ""}
${rateHelper}${opts.rateWired ? 'function clientIpOf(req) { return String(req.socket?.remoteAddress || ""); }' : ""}
const corsPolicy = createCorsPolicy(CONFIG.corsOrigins);
const API_ROUTES = [
  ["GET", "/api/notify/stream", (res, req) => notifier.subscribe(res, req)],
  ["GET", "/api/chat/stream", (res) => handleChatStream(res)],
  ["GET", /^\\/api\\/sessions\\/([^/]+)\\/stream$/, (res, req, url, m) => handleSessionStream(res, req, m[1])],
  ["GET", "/api/system/doctor", (res) => json(res, 200, {})],
];

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  for (const [name, value] of Object.entries(corsPolicy.headers(req.headers.origin))) res.setHeader(name, value);
  try {
    const isStatic = ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/api/health" || WORKSHOP_PAGES[url.pathname]${staticExtra}));
    const isSetupStatus = (url.pathname === "/api/setup/status" && req.method === "GET") || (url.pathname === "/api/setup/claim" && req.method === "POST");
    const isPublicFeedback = url.pathname === "/api/public/feedback" && req.method === "POST";
    const isPublicTvMedia = url.pathname === "/api/tv/media" && req.method === "GET";
    const isPairPage = req.method === "GET" && (url.pathname === "/pair.js" || url.pathname.startsWith("/pair/"));
    const isPairPublic = (req.method === "POST" && ["/api/pair/claim", "/api/pair/token"].includes(url.pathname)) || (req.method === "GET" && url.pathname === "/api/pair/status");
    const isMusicLogin = (url.pathname === "/music-login" || url.pathname === "/api/music/login") && req.method === "GET" && isLoopbackReq(req);
    const isLocalLogin = url.pathname === "/api/auth/local-token" && req.method === "GET" && isLoopbackReq(req);
${rateBlock}
  } catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
}

function checkAuth(req) {
  const h = req.headers.authorization || "";
  if (h === \`Bearer \${CONFIG.token}\`) return true;
${opts.queryToken ? '  const url = new URL(req.url, "http://localhost");\n  return url.searchParams.get("token") === CONFIG.token;' : "  return false;"}
}
`);

  write("lib/static.mjs", `export function resolveStaticPath(root, rawUrl) {
  let p = new URL(rawUrl, "http://localhost").pathname;
  if (p === "/" || p.endsWith("/")) p = "/index.html";
  const file = path.join(root, path.normalize(p).replace(/^([\\\\/])+/, ""));
${opts.traversalGuard ? "  if (!file.startsWith(root + path.sep)) return { ok: false, reason: \"forbidden\" };" : ""}
  return { ok: true, file };
}
`);

  write("engine/workspace-api.mjs", `export function wsSafePath(p) {
${opts.traversalGuard ? "  return safeJoin(WS_ROOT, p);" : "  return path.resolve(WS_ROOT, p);"}
}
export async function handleWsFile(res, req, url) {
  if (url.searchParams.get("sig")) { const v = fb.verifySigned(req); if (!v.ok) return; }
}
`);

  write("engine/tools/security.mjs", `export function safeJoin(root, p) {
  const resolved = path.resolve(root, p);
${opts.traversalGuard ? "  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;\n  const real = fs.realpathSync(resolved);" : ""}
  return resolved;
}
`);

  write("engine/cors-policy.mjs", opts.corsWildcard
    ? `export function createCorsPolicy(configured = "") {
  return { headers(origin) { return { "Access-Control-Allow-Origin": origin || "*" }; } };
}
`
    : `export function createCorsPolicy(configured = "") {
  const origins = new Set(String(configured || "").split(",").filter(Boolean));
  return {
    allowedOrigin(origin) { return origins.has(origin) ? origin : null; },
    headers(origin) { const allowed = this.allowedOrigin(origin); return allowed ? { "Access-Control-Allow-Origin": allowed } : {}; },
  };
}
`);

  write("engine/rate-limit.mjs", "export function createRateLimiter(opts = {}) { return opts; }\n");

  if (!opts.rateConfigNone) {
    write("记忆/运行时/限流.json", opts.rateConfigMalformed ? "{ 这不是 JSON" : JSON.stringify({ enabled: opts.rateEnabled }));
  }
  if (opts.leakSecret === "auth.json") write("auth.json", JSON.stringify({ provider: "x", apiKey: "sk-live-abcdef1234567890" }));
  if (opts.leakSecret === "inline") write(".env", "OPENAI_API_KEY=sk-live-abcdef1234567890\nLAN=1\n");
  return root;
}

const runAudit = (root, config = {}) => auditSecurity({ wsRoot: root, config: { repoRoot: root, ...config } });
const byId = (report, id) => report.checks.find((c) => c.id === id);

test("好配置：10 条检查全绿，score 100，字段/fix 完整，8 个必需 checkId 齐全", () => {
  const root = makeRepo();
  const report = runAudit(root);
  assert.equal(report.ok, true);
  assert.equal(report.score, 100);
  assert.equal(report.checks.length >= 8, true);
  for (const id of REQUIRED_IDS) assert.ok(byId(report, id), `缺检查项 ${id}`);
  for (const c of report.checks) {
    assert.deepEqual(Object.keys(c).sort(), ["detail", "fix", "id", "ok", "severity", "title"].sort());
    assert.equal(["high", "medium", "low"].includes(c.severity), true, `${c.id} severity 非法`);
    assert.equal(typeof c.title, "string");
    assert.ok(c.title.length > 0, `${c.id} title 为空`);
    assert.ok(c.detail.length > 0, `${c.id} detail 为空`);
    assert.ok(c.fix.length > 0, `${c.id} fix 为空`);
    assert.equal(/(把|删|加|改|换|保持|设置|让|启用|关闭|移出)/.test(c.fix), true, `${c.id} fix 不像可执行动作：${c.fix}`);
  }
  assert.deepEqual(PUBLIC_API_ALLOWLIST.slice(0, 3), ["/api/health", "/api/setup/status", "/api/setup/claim"]);
});

test("AUTH-001：弱令牌红、强令牌绿", () => {
  const weak = runAudit(makeRepo({ token: "love#1126469194" }));
  const auth = byId(weak, "AUTH-001");
  assert.equal(auth.ok, false);
  assert.equal(auth.severity, "high");
  assert.match(auth.detail, /长度仅 15 位/);
  assert.match(auth.fix, /randomBytes\(24\)/);
  assert.equal(weak.ok, false);
  assert.ok(weak.score < 100);

  const strong = runAudit(makeRepo({ token: crypto.randomBytes(24).toString("hex") }));
  assert.equal(byId(strong, "AUTH-001").ok, true);
});

test("NET-001：0.0.0.0/:: 红（含 config.mjs 的 LAN=1 推导），127.0.0.1 绿", () => {
  // 强令牌 + 限流已开 → 仍是红，但降为中危（有加固、无 TLS/反代）
  const exposed = runAudit(makeRepo({ publicHost: true }), {});
  const net = byId(exposed, "NET-001");
  assert.equal(net.ok, false);
  assert.equal(net.severity, "medium");
  assert.match(net.detail, /\[::\]:8787/);

  // 弱令牌 + 公网 → 高危
  const weak = runAudit(makeRepo({ publicHost: true, token: "love#1126469194" }));
  assert.equal(byId(weak, "NET-001").severity, "high");

  const wildcard = runAudit(makeRepo(), { host: "0.0.0.0" });
  assert.equal(byId(wildcard, "NET-001").ok, false);
  assert.match(byId(wildcard, "NET-001").detail, /0\.0\.0\.0:8787/);

  const loop = runAudit(makeRepo());
  assert.equal(byId(loop, "NET-001").ok, true);
});

test("AUTH-002/SSE-001：白名单外的匿名 /api/* 与匿名流都必须红", () => {
  const extra = runAudit(makeRepo({ publicExtra: "/api/debug/dump" }));
  assert.equal(byId(extra, "AUTH-002").ok, false);
  assert.match(byId(extra, "AUTH-002").detail, /\/api\/debug\/dump/);

  const sse = runAudit(makeRepo({ publicExtra: "/api/notify/stream" }));
  assert.equal(byId(sse, "SSE-001").ok, false);
  assert.equal(byId(sse, "SSE-001").severity, "high");
});

test("RATE-001：enabled:false / 配置损坏 / 没接线都红；AUTH-004：没在 401 前记账也红", () => {
  const disabled = runAudit(makeRepo({ rateEnabled: false }));
  assert.equal(byId(disabled, "RATE-001").ok, false);
  assert.match(byId(disabled, "RATE-001").detail, /未生效/);

  const broken = runAudit(makeRepo({ rateConfigMalformed: true }));
  assert.equal(byId(broken, "RATE-001").ok, false);

  const unwired = runAudit(makeRepo({ rateWired: false }));
  assert.equal(byId(unwired, "RATE-001").ok, false);
  assert.equal(byId(unwired, "AUTH-004").ok, false);

  const noLockout = runAudit(makeRepo({ lockoutWired: false }));
  assert.equal(byId(noLockout, "RATE-001").ok, true);
  assert.equal(byId(noLockout, "AUTH-004").ok, false);
});

test("SECRET-001/PATH-001/CORS-001：未忽略的 auth.json、缺穿越防护、通配 CORS 各自红", () => {
  const leaked = runAudit(makeRepo({ leakSecret: "auth.json" }));
  assert.equal(byId(leaked, "SECRET-001").ok, false);
  assert.match(byId(leaked, "SECRET-001").detail, /auth\.json/);

  const inline = runAudit(makeRepo({ leakSecret: "inline" }));
  assert.equal(byId(inline, "SECRET-001").ok, false);
  assert.match(byId(inline, "SECRET-001").detail, /OPENAI_API_KEY/);

  const traversal = runAudit(makeRepo({ traversalGuard: false }));
  assert.equal(byId(traversal, "PATH-001").ok, false);

  const cors = runAudit(makeRepo({ corsWildcard: true }));
  assert.equal(byId(cors, "CORS-001").ok, false);
  assert.match(byId(cors, "CORS-001").detail, /通配反射 存在/);
});

test("AUTH-003：checkAuth 接受 ?token= 时红，只认 Authorization 时绿", () => {
  const query = runAudit(makeRepo({ queryToken: true }));
  assert.equal(byId(query, "AUTH-003").ok, false);
  assert.match(byId(query, "AUTH-003").detail, /URL/);
  assert.equal(byId(query, "AUTH-003").severity, "medium");

  const headerOnly = runAudit(makeRepo());
  assert.equal(byId(headerOnly, "AUTH-003").ok, true);
});

test("CLI：好配置 exit 0，弱令牌+公网 exit 2，--json 输出可解析，表格含 FAIL", () => {
  const good = makeRepo();
  const goodRun = spawnSync(process.execPath, [CLI, "--json", "--repo", good, "--ws", good], { encoding: "utf8", timeout: 60000 });
  assert.equal(goodRun.status, 0, goodRun.stderr || goodRun.stdout);
  const parsed = JSON.parse(goodRun.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.checks.length >= 8, true);

  const bad = makeRepo({ token: "love#1126469194", publicHost: true });
  const badJson = spawnSync(process.execPath, [CLI, "--json", "--repo", bad, "--ws", bad], { encoding: "utf8", timeout: 60000 });
  assert.equal(badJson.status, 2, "有 high 失败必须 exit 2");
  assert.equal(JSON.parse(badJson.stdout).ok, false);

  const badTable = spawnSync(process.execPath, [CLI, "--repo", bad, "--ws", bad], { encoding: "utf8", timeout: 60000 });
  assert.equal(badTable.status, 2);
  assert.match(badTable.stdout, /FAIL/);
  assert.match(badTable.stdout, /AUTH-001/);
  assert.match(badTable.stdout, /修复：/);
});
