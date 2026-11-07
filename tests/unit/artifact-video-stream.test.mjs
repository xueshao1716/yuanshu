// 大视频落盘（2026-11-07）：旧的 50MB / 60s 统一上限会把正常成片全判死，
// 而且 `arrayBuffer()` 整包读进内存，几百 MB 的片子并发几部就 OOM。
//
// 这个测试锁三件事：
//   ① 视频走流式写盘——假下载器只提供 body、**没有** buffer()/arrayBuffer()，能成说明没整包读；
//   ② 上限/超时可配置（artifact.limits 注入），超限、超时、取消都如实 local=false + 具体原因；
//   ③ 流式收尾是 .part → rename：成功后目录里只有最终文件，失败后不留临时文件。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { initWorkspaceApi, saveArtifact, artifactDownloadLimits, localDayStamp } from "../../engine/workspace-api.mjs";

const FAKE = "https://cdn.example.test/v.mp4";
const videoDir = (root) => path.join(root, "生成物", "视频", localDayStamp());
const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const streamBody = (chunks) => Readable.toWeb(Readable.from(chunks.map(c => Buffer.from(c))));

function setup(t, fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-video-stream-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initWorkspaceApi({ wsRoot: root, fetchImpl });
  return root;
}

test("视频流式写盘：不整包读、写完 rename、没有 .part 残留", async (t) => {
  const root = setup(t, async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": "11" }),
    body: streamBody(["hello ", "video"]),
  }));
  const result = await saveArtifact({ type: "video", url: FAKE, prompt: "流式成片" });
  assert.equal(result.local, true, `应当落盘成功，实际: ${JSON.stringify(result)}`);
  const files = filesIn(videoDir(root));
  assert.equal(files.filter(n => n.endsWith(".part")).length, 0, "临时文件必须清掉");
  const mp4 = files.find(n => n.endsWith(".mp4"));
  assert.ok(mp4, `必须有 .mp4，实际: ${files.join(",")}`);
  assert.equal(fs.readFileSync(path.join(videoDir(root), mp4), "utf8"), "hello video");
  assert.ok(files.some(n => n.endsWith(".json")), "旁路提示词照旧要写");
});

test("超过上限按失败处理：local=false + 具体原因 + 不留文件", async (t) => {
  const root = setup(t, async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: streamBody(["0123456789", "abcdefghij"]),
  }));
  const result = await saveArtifact({ type: "video", url: FAKE, prompt: "超限", limits: { maxBytes: 8 } });
  assert.equal(result.local, false, "超限就是没本地化");
  assert.match(result.reason, /超过/);
  assert.match(result.reason, /8 字节/);
  assert.deepEqual(filesIn(videoDir(root)), [], "失败不能留下 .part / 空占位文件");
});

test("超时中断：local=false + 超时原因 + 不留临时文件", async (t) => {
  const root = setup(t, async () => ({
    ok: true,
    status: 200,
    // 只给响应头、body 永不结束：模拟上游卡死
    body: new ReadableStream({ start() {} }),
  }));
  const result = await saveArtifact({ type: "video", url: FAKE, prompt: "卡住", limits: { timeoutMs: 80 } });
  assert.equal(result.local, false);
  assert.match(result.reason, /超时/, `原因要说是超时，实际 "${result.reason}"`);
  assert.deepEqual(filesIn(videoDir(root)), []);
});

test("调用方取消：不下载、不落盘，原因带取消", async (t) => {
  let calls = 0;
  const root = setup(t, async () => { calls++; return { ok: true, status: 200, buffer: () => Buffer.from("x") }; });
  const controller = new AbortController();
  controller.abort(new Error("本轮已取消"));
  const result = await saveArtifact({ type: "video", url: FAKE, prompt: "取消", signal: controller.signal });
  assert.equal(result.local, false);
  assert.match(result.reason, /取消/);
  assert.equal(calls, 0, "取消后不能再发下载请求");
  assert.deepEqual(filesIn(videoDir(root)), []);
});

test("下载器只给整包（旧替身/旧实现）时仍能落盘，上限照旧生效", async (t) => {
  const root = setup(t, async () => ({ ok: true, status: 200, buffer: () => Buffer.from("fake-mp4-bytes") }));
  const result = await saveArtifact({ type: "video", url: FAKE, prompt: "整包回退" });
  assert.equal(result.local, true);
  assert.ok(filesIn(videoDir(root)).some(n => n.endsWith(".mp4")));
});

test("上限集中定义且可配置：视频 500MB/10 分钟，图片音频沿用 50MB/60 秒", () => {
  delete process.env.PI_ARTIFACT_MAX_MB;
  delete process.env.PI_ARTIFACT_TIMEOUT_MS;
  assert.deepEqual(artifactDownloadLimits("video"), { maxBytes: 500 * 1024 * 1024, timeoutMs: 10 * 60_000 });
  assert.deepEqual(artifactDownloadLimits("image"), { maxBytes: 50 * 1024 * 1024, timeoutMs: 60_000 });
  assert.deepEqual(artifactDownloadLimits("audio"), { maxBytes: 50 * 1024 * 1024, timeoutMs: 60_000 });
  assert.deepEqual(artifactDownloadLimits("未知类型"), { maxBytes: 50 * 1024 * 1024, timeoutMs: 60_000 });
  // 测试/特殊调用可单独覆盖
  assert.deepEqual(artifactDownloadLimits("video", { maxBytes: 1024, timeoutMs: 5000 }), { maxBytes: 1024, timeoutMs: 5000 });
});
