// ===== delivery-probe.test.mjs —— delivery_probe：出图/出片之后的一次确认（2026-11-14）=====
//
// 锁住三件事，不锁文案：
//   ① 判定：正常 PNG 必须 loadable=true 且尺寸正确；不存在/内容不对/HTTP 不对必须 loadable=false 且 issues 说得清
//   ② 边界：fetch 失败不抛（探测工具自己崩掉就等于又逼她回去翻日志）
//   ③ 接线：进 UNIFIED_TOOLS + 执行器表，导入早于数组（数组是模块求值时立刻构造的），
//      且反模式台账里有 AP-013 指回这个工具
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

import { DELIVERY_PROBE_TOOL, executeDeliveryProbe } from "../../engine/tools/delivery-probe.mjs";
import { configureTicketKey } from "../../engine/media-ticket.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// 票据密钥：测试自己派生一把，不依赖仓库根的 .token（那样测试会随环境红绿）。
configureTicketKey("delivery-probe-test-key");

const PNG_W = 832;
const PNG_H = 1248;

/** 手搓一个真 PNG 头：签名 + IHDR（宽高是真的，CRC 故意留 0——探测只读前 24 字节，不校验 CRC）。 */
function makePng(w = PNG_W, h = PNG_H) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR 长度
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  buf[24] = 8; // bit depth
  buf[25] = 6; // color type: RGBA
  return buf;
}

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-delivery-probe-"));
  fs.mkdirSync(path.join(root, "生成物", "图片"), { recursive: true });
  fs.writeFileSync(path.join(root, "生成物", "图片", "海报.png"), makePng());
  fs.writeFileSync(path.join(root, "生成物", "图片", "假图.png"), Buffer.from('{"error":"模型没返回图片"}', "utf8"));
  fs.writeFileSync(path.join(root, "数据.json"), '{"ok":true}');
  return root;
}

async function rmTempDir(dir, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (err) {
      const retriable = ["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(err?.code);
      if (!retriable || Date.now() - started > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

const stopServer = (server) => new Promise((resolve) => server.close(resolve));

/** 拿一个确定关着的端口：先监听 0 拿到号，再关掉。 */
async function closedPortBaseUrl() {
  const { server, baseUrl } = await startServer(() => {});
  await stopServer(server);
  return baseUrl;
}

test("正常 PNG：loadable true、尺寸正确、issues 空、结论行点名 HTTP 200", async () => {
  const root = tmpRoot();
  const png = fs.readFileSync(path.join(root, "生成物", "图片", "海报.png"));
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(png);
  });
  try {
    const out = await executeDeliveryProbe({ path: "生成物/图片/海报.png" }, { roots: [root], baseUrl, timeoutMs: 5000 });
    const r = out.details;
    assert.equal(r.exists, true);
    assert.equal(r.bytes, png.length);
    assert.equal(r.mime, "image/png");
    assert.equal(r.magicOk, true);
    assert.deepEqual(r.dimensions, { w: PNG_W, h: PNG_H });
    assert.equal(r.fetch.status, 200);
    assert.equal(r.fetch.contentType, "image/png");
    assert.equal(r.fetch.bytes, png.length);
    assert.equal(r.loadable, true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.issues, []);
    assert.equal(out.isError, false);
    // 结论行是给她直接抄的那句：格式 / 字节 / 尺寸 / HTTP
    assert.match(out.text, /✅ 可交付：image\/png \d+ 字节 832×1248，HTTP 200/);
    // URL 走票据机制（不是 ?token= 长期令牌）
    assert.match(r.url, /^\/api\/ws\/file\?path=/);
    assert.match(r.url, /&ticket=/);
    assert.doesNotMatch(r.url, /token=/);
  } finally {
    await stopServer(server);
    await rmTempDir(root);
  }
});

test("文件不存在：ok false、issues 说「不存在」、不再发 HTTP", async () => {
  const root = tmpRoot();
  try {
    const out = await executeDeliveryProbe({ path: "生成物/图片/没有这张.png" }, { roots: [root], baseUrl: await closedPortBaseUrl() });
    assert.equal(out.details.exists, false);
    assert.equal(out.details.ok, false);
    assert.equal(out.details.loadable, false);
    assert.equal(out.details.fetch, null, "文件都不在，别再去打服务");
    assert.ok(out.details.issues.some((s) => /不存在/.test(s)), out.details.issues.join(" / "));
    assert.equal(out.isError, true);
    assert.match(out.text, /❌ 不可交付/);
  } finally {
    await rmTempDir(root);
  }
});

test("扩展名 .png 但内容是 JSON：magicOk false、issues 指出内容不是 PNG", async () => {
  const root = tmpRoot();
  try {
    const out = await executeDeliveryProbe({ path: "生成物/图片/假图.png", fetch: false }, { roots: [root] });
    const r = out.details;
    assert.equal(r.exists, true);
    assert.equal(r.magicOk, false);
    assert.equal(r.mime, "image/png", "内容认不出时按扩展名报，但 magicOk 必须为 false");
    assert.equal(r.dimensions, null, "读不出尺寸就给 null，不猜");
    assert.equal(r.loadable, false);
    assert.equal(r.fetch, null);
    assert.ok(r.issues.some((s) => /内容不是 PNG/.test(s)), r.issues.join(" / "));
  } finally {
    await rmTempDir(root);
  }
});

test("fetch 失败（坏端口）：不抛、issues 记录、loadable false", async () => {
  const root = tmpRoot();
  try {
    const out = await executeDeliveryProbe(
      { path: "生成物/图片/海报.png" },
      { roots: [root], baseUrl: await closedPortBaseUrl(), timeoutMs: 3000 },
    );
    assert.equal(out.details.exists, true, "本地文件是好的");
    assert.equal(out.details.fetch.status, 0);
    assert.equal(out.details.loadable, false);
    assert.equal(out.details.ok, false);
    assert.ok(out.details.issues.some((s) => /HTTP 探测失败/.test(s)), out.details.issues.join(" / "));
  } finally {
    await rmTempDir(root);
  }
});

test("返回 JSON 而不是图片：loadable false、issues 说清是 JSON", async () => {
  const root = tmpRoot();
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "文件不存在" }));
  });
  try {
    const out = await executeDeliveryProbe({ path: "生成物/图片/海报.png" }, { roots: [root], baseUrl, timeoutMs: 5000 });
    const r = out.details;
    assert.equal(r.fetch.status, 200);
    assert.equal(r.magicOk, true, "磁盘上这个文件本身是好的 PNG，问题出在服务端返回体");
    assert.equal(r.loadable, false);
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((s) => /JSON/.test(s) && /不是图片/.test(s)), r.issues.join(" / "));
  } finally {
    await stopServer(server);
    await rmTempDir(root);
  }
});

test("schema：path 必填、fetch 可选，描述里写死使用纪律", () => {
  const fn = DELIVERY_PROBE_TOOL.function;
  assert.equal(DELIVERY_PROBE_TOOL.type, "function");
  assert.equal(fn.name, "delivery_probe");
  assert.deepEqual(fn.parameters.required, ["path"]);
  assert.equal(fn.parameters.properties.path.type, "string");
  assert.equal(fn.parameters.properties.fetch.type, "boolean");
  // 工具描述是唯一常驻上下文的地方：纪律必须在这里，不能只写在注释里
  assert.match(fn.description, /出图\/出片后先调它一次/);
  assert.match(fn.description, /serve\.log/);
  assert.match(fn.description, /读 server\.mjs/);
  assert.match(fn.description, /verify_check/);
});

test("统一执行器：extraExecutors 里的 delivery_probe 能被正常派发（与 server 同形）", async () => {
  const root = tmpRoot();
  const png = fs.readFileSync(path.join(root, "生成物", "图片", "海报.png"));
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(png);
  });
  try {
    const { createUnifiedToolExecutor } = await import("../../engine/tools/unified-tools.mjs");
    const { safeJoin } = await import("../../engine/tools/security.mjs");
    const exec = createUnifiedToolExecutor({
      cwd: () => root,
      safePath: (p) => safeJoin(root, p),
      // 与 server.mjs 里那条注册同形：一行只接 args 的箭头函数
      extraExecutors: { delivery_probe: (args) => executeDeliveryProbe(args, { roots: [root], baseUrl }) },
    });
    const r = await exec("delivery_probe", { path: "生成物/图片/海报.png" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /✅ 可交付：image\/png/);
    assert.equal(r.details.loadable, true);
  } finally {
    await stopServer(server);
    await rmTempDir(root);
  }
});

test("接线：UNIFIED_TOOLS 与执行器表里都有 delivery_probe，导入早于数组", () => {
  const src = read("server.mjs");
  const start = src.indexOf("const UNIFIED_TOOLS = [");
  assert.ok(start > 0, "找不到 UNIFIED_TOOLS");
  const end = src.indexOf("\n];", start);
  assert.ok(end > start, "找不到 UNIFIED_TOOLS 的收尾");
  assert.match(src.slice(start, end), /^\s*DELIVERY_PROBE_TOOL,\s*$/m, "必须进 UNIFIED_TOOLS");

  const exStart = src.indexOf("const extraToolExecutors = {");
  assert.ok(exStart > 0, "找不到执行器表 extraToolExecutors");
  const exEnd = src.indexOf("\n};", exStart);
  assert.match(src.slice(exStart, exEnd), /^\s*delivery_probe:\s*\(args\)\s*=>/m, "执行器表里必须有 delivery_probe");

  assert.match(src, /import\s*\{[^}]*DELIVERY_PROBE_TOOL[^}]*\}\s*from\s*["']\.\/engine\/tools\/delivery-probe\.mjs["']/);
  assert.ok(src.indexOf("import { DELIVERY_PROBE_TOOL") < start, "导入必须在 UNIFIED_TOOLS 之前");
});

test("反模式：AP-013 已进内置台账，remedy 指回 delivery_probe", async () => {
  const { DEFAULT_PATTERNS } = await import("../../engine/anti-patterns.mjs");
  const ap = DEFAULT_PATTERNS.find((p) => p.id === "AP-013");
  assert.ok(ap, "内置台账缺 AP-013");
  assert.match(ap.title, /翻日志|读源码/);
  assert.match(ap.remedy, /delivery_probe/);
  assert.match(ap.remedy, /先/);
  assert.equal(ap.severity, "medium");
});
