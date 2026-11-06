// 产物本地化契约（docs/NAMING.md 第三节）
//
// 为什么单独锁：外站 API（出图/出片/配音）返回的多是**临时链接**，几小时到几天就失效。
// 以前 saveArtifact 在下载失败时 catch 住、悄悄把外站 URL 原样返回，调用方里还有三处
// 直接 `catch {}` 吞掉——于是"已落盘"和"没落盘"在界面上完全一样，等链接过期才发现
// 产物根本不在本地。这个契约要求：能下的必须下到本地；下不了必须**如实标出来**。
//
// 测试怎么模拟"外站"：不能真起本地 HTTP 服务器——SSRF 守卫会（正确地）拦掉回环地址。
// 用 initWorkspaceApi({ fetchImpl }) 注入下载器，既不改安全策略，又能在生产同一条代码路径上验。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initWorkspaceApi, saveArtifact, saveArtifactUrl, localDayStamp } from "../../engine/workspace-api.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const FAKE_UPSTREAM = "https://cdn.example.test";

/** 用一个假的下载器跑 saveArtifact，工作区是临时目录。 */
async function save(artifact, fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-localize-"));
  initWorkspaceApi({ wsRoot: root, fetchImpl });
  try {
    const result = await saveArtifact(artifact);
    return { result, root };
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

const okFetch = (buffer, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, buffer: () => buffer });
const failFetch = status => async () => ({ ok: false, status, buffer: () => Buffer.alloc(0) });
const throwFetch = message => async () => { throw new Error(message); };

test("外站 http 产物必须下载到本地：local=true，文件真在磁盘上，返回的是本地地址", async () => {
  const { result, root } = await save({ type: "image", url: `${FAKE_UPSTREAM}/a.png`, prompt: "外站出图" }, okFetch(PNG));
  try {
    assert.equal(result.local, true, `应当落盘成功，实际: ${JSON.stringify(result)}`);
    assert.equal(result.reason, "");
    assert.match(result.url, /^\/api\/ws\/file\?path=/, "返回的应是本地签名地址");
    assert.ok(!result.url.includes("cdn.example.test"), "绝不能把外站 URL 当成品返回");
    const dir = path.join(root, "生成物", "图片", localDayStamp());
    const files = fs.readdirSync(dir).filter(n => n.endsWith(".png"));
    assert.equal(files.length, 1, "本地必须有且只有一个产物文件");
    assert.ok(fs.statSync(path.join(dir, files[0])).size > 0, "落盘文件不能是空的");
    assert.match(files[0], /_v\d+\.\d+\.\d+\.png$/, "落盘名要遵守命名契约（带版本段）");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("下载失败必须如实标记 local=false 并带具体原因，不能静默当成功", async () => {
  for (const [name, fetchImpl, pattern] of [
    ["HTTP 500", failFetch(500), /HTTP 500/],
    ["网络异常", throwFetch("socket hang up"), /socket hang up/],
    ["空响应体", okFetch(Buffer.alloc(0)), /为空/],
  ]) {
    const { result, root } = await save({ type: "image", url: `${FAKE_UPSTREAM}/x.png`, prompt: "失败的图" }, fetchImpl);
    try {
      assert.equal(result.local, false, `${name}：下载失败就不能声称已本地化`);
      assert.ok(result.reason, `${name}：必须带原因，否则上层没法告诉用户`);
      assert.match(result.reason, pattern, `${name}：原因要具体，实际 "${result.reason}"`);
      assert.equal(result.url, `${FAKE_UPSTREAM}/x.png`, `${name}：至少把原地址还回去`);
      assert.equal(fs.readdirSync(path.join(root, "生成物", "图片", localDayStamp())).length, 0, `${name}：失败不能留下空文件`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("HTML 错误页不能冒充图片", async () => {
  const { result, root } = await save(
    { type: "image", url: `${FAKE_UPSTREAM}/fake.png`, prompt: "假图" },
    okFetch(Buffer.from("<html>404 Not Found</html>")),
  );
  try {
    assert.equal(result.local, false, "HTML 错误页不能冒充图片");
    assert.match(result.reason, /不是图片/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("上游抖动会重试一次：第一次失败、第二次成功仍算已本地化", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNRESET");
    return { ok: true, status: 200, buffer: () => PNG };
  };
  const { result, root } = await save({ type: "image", url: `${FAKE_UPSTREAM}/flaky.png`, prompt: "抖动" }, flaky);
  try {
    assert.equal(calls, 2, "必须重试一次");
    assert.equal(result.local, true, "重试成功后要如实标记为已本地化");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("内网/回环地址出于安全拒绝下载，但同样如实标记（不假装已本地化）", async () => {
  for (const url of ["http://127.0.0.1:9/a.png", "http://localhost/a.png", "http://192.168.1.5/a.png",
    "http://10.0.0.1/a.png", "http://172.16.3.4/a.png", "http://box.internal/a.png", "http://x.local/a.png"]) {
    const { result, root } = await save({ type: "image", url, prompt: "内网" }, okFetch(PNG));
    try {
      assert.equal(result.local, false, `${url} 必须被 SSRF 拦下`);
      assert.match(result.reason, /内网|回环/, `${url} 的原因应说明是安全拦截，实际 "${result.reason}"`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("非图片产物（视频）同样走本地化，不因类型不同而放行", async () => {
  const bytes = Buffer.from("fake-mp4-bytes-for-localize-test");
  const { result, root } = await save({ type: "video", url: `${FAKE_UPSTREAM}/v.mp4`, prompt: "外站出片" }, okFetch(bytes));
  try {
    assert.equal(result.local, true);
    const dir = path.join(root, "生成物", "视频", localDayStamp());
    const files = fs.readdirSync(dir);
    assert.ok(files.some(n => n.endsWith(".mp4")), `实际: ${files.join(",")}`);
    assert.ok(files.some(n => n.endsWith(".json")), "必须写旁路提示词");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("data URL 与非 http 输入的行为不变（本来就本地）", async () => {
  const { result, root } = await save({ type: "image", url: `data:image/png;base64,${PNG.toString("base64")}`, prompt: "内联图" }, okFetch(PNG));
  try {
    assert.equal(result.local, true);
    assert.match(result.url, /^\/api\/ws\/file\?path=/);
    const rel = await saveArtifact({ type: "image", url: "/api/ws/file?path=x.png", prompt: "" });
    assert.equal(rel.local, true, "相对路径本来就是本地的");
    assert.equal(rel.url, "/api/ws/file?path=x.png");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("saveArtifactUrl 是只取地址的薄封装", async () => {
  const { root } = await save({ type: "image", url: `${FAKE_UPSTREAM}/x.png`, prompt: "薄封装" }, okFetch(PNG));
  try {
    const url = await saveArtifactUrl({ type: "image", url: `data:image/png;base64,${PNG.toString("base64")}`, prompt: "薄封装" });
    assert.equal(typeof url, "string");
    assert.match(url, /^\/api\/ws\/file\?path=/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("交付路径不得再静默吞掉本地化失败", () => {
  // 这几处以前是 `try { mr.url = await saveArtifact(mr) } catch {}` 或 `.catch(() => null)`，
  // 下载失败后 mr.url 仍是外站地址，界面上分辨不出，是最隐蔽的一环。
  const server = read("server.mjs");
  assert.ok(!/try\s*\{\s*mr\.url = await saveArtifact\(mr\);\s*\}\s*catch\s*\{\s*\}/.test(server),
    "server.mjs 不得再用 try/catch 静默吞掉本地化失败");
  assert.match(server, /saved\.local/, "server.mjs 必须检查 local 并回报");
  const chat = read("engine", "unified-chat.mjs");
  assert.ok(!/try\s*\{\s*mr\.url = await saveArtifact\(mr\);\s*\}\s*catch\s*\{\s*\}/.test(chat),
    "unified-chat.mjs 不得再静默吞掉本地化失败");
  assert.match(chat, /localizeError/, "unified-chat.mjs 必须把未本地化告诉用户");
  const media = read("engine", "media", "api.mjs");
  assert.ok(!/saveArtifact\([^;]*\)\.catch\(\(\) => null\)/.test(media),
    "media-api.mjs 不得再用 .catch(() => null) 吞掉本地化失败");
  assert.match(media, /localizeError/, "media-api.mjs 必须回报未本地化");
});
