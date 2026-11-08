// 正文 Markdown 外链图归档器（2026-11-08）。
//
// 产品原则：远程图片必须先落盘本地，再发本地地址；厂商地址随时会失效，不能当交付物。
// 这里锁住纯逻辑的六条：找图/跳过、成功替换、失败替换且不露远端地址、
// 缓存命中不下载、单条最多 3 张、异常降级。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ARCHIVE_REL,
  DEFAULT_MAX_PER_MESSAGE,
  FAILURE_TTL_MS,
  IMAGE_UNAVAILABLE_NOTE,
  configureMarkdownImages,
  findMarkdownImages,
  localizeMarkdownImages,
  localizeMarkdownImagesCached,
  localizeMarkdownImagesDetailed,
  readImageArchive,
} from "../../engine/media/markdown-images.mjs";

const REMOTE = "https://platform-outputs.agnes-ai.space/images/t2i/task_1/out_1.png";
const REMOTE_2 = "https://platform-outputs.agnes-ai.space/images/t2i/task_1/out_2.png";
const LOCAL = "/api/ws/file?path=" + encodeURIComponent("生成物/图片/2026-11-08/海报.png") + "&exp=1&sig=abc";
const LOCAL_2 = "/api/ws/file?path=" + encodeURIComponent("生成物/图片/2026-11-08/海报2.png") + "&exp=1&sig=def";
const NOW = new Date("2026-11-08T12:00:00.000Z");

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-mdimg-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  configureMarkdownImages({ wsRoot: dir });
  return dir;
}

const okSave = (local = LOCAL) => async () => ({ url: local, local: true, reason: "" });

test("findMarkdownImages：只取远端 http(s) 图片，跳过 data:/本地/api/ws/file/视频", () => {
  const text = [
    "![海报](" + REMOTE + ")",
    "![](data:image/png;base64,iVBORw0KGgo=)",
    "![本地](/api/ws/file?path=x.png)",
    "![本机](http://127.0.0.1:8787/api/ws/file?path=x.png)",
    "![相对](生成物/图片/x.png)",
    "![视频](https://cdn.example.com/clip.mp4)",
    "![另一张](" + REMOTE_2 + ")",
    "![重复](" + REMOTE + ")",
  ].join("\n");
  assert.deepEqual(findMarkdownImages(text), [REMOTE, REMOTE_2, REMOTE], "按出现顺序返回所有远端图片 URL");
  assert.deepEqual(findMarkdownImages("没有图"), []);
  assert.deepEqual(findMarkdownImages(""), []);
});

test("成功：下载后替换成本地地址并写缓存（url → {local,size,at,ok,reason}）", async (t) => {
  const wsRoot = tempRoot(t);
  const map = {};
  const saves = [];
  const out = await localizeMarkdownImagesDetailed("画好了：\n\n![海报](" + REMOTE + ")", {
    wsRoot,
    map,
    now: NOW,
    saveArtifact: async (artifact) => { saves.push(artifact); return { url: LOCAL, local: true, reason: "" }; },
  });
  assert.equal(saves.length, 1, "未命中缓存必须下载一次");
  assert.equal(saves[0].type, "image");
  assert.equal(saves[0].url, REMOTE, "下载的是原始厂商地址");
  assert.equal(saves[0].prompt, "海报", "alt 作为落盘提示词");
  assert.match(out.text, /!\[海报\]\(\/api\/ws\/file\?path=/);
  assert.ok(!out.text.includes(REMOTE), "输出里不许再出现原远端 URL");
  assert.equal(out.localized, 1);
  assert.equal(out.attempted, 1);
  assert.equal(map[REMOTE].ok, true);
  assert.equal(map[REMOTE].local, LOCAL);
  assert.equal(map[REMOTE].at, NOW.toISOString());
});

test("失败：整张图换成文字说明，输出不再含原远端 URL，并写失败缓存", async (t) => {
  const wsRoot = tempRoot(t);
  const map = {};
  const out = await localizeMarkdownImagesDetailed("画好了：\n\n![海报](" + REMOTE + ")", {
    wsRoot,
    map,
    now: NOW,
    saveArtifact: async () => ({ url: REMOTE, local: false, reason: "下载失败 HTTP 502" }),
  });
  assert.equal(out.failed, 1);
  assert.ok(out.text.includes(IMAGE_UNAVAILABLE_NOTE), "要留一行人话说明");
  assert.ok(out.text.includes("画好了"), "正文其它内容不能丢");
  assert.ok(!out.text.includes(REMOTE), "失败时绝不保留厂商地址");
  assert.equal(map[REMOTE].ok, false);
  assert.equal(map[REMOTE].local, "");
  assert.match(map[REMOTE].reason, /502/);
});

test("缓存命中成功：不调用下载器，直接换本地地址", async (t) => {
  const wsRoot = tempRoot(t);
  const map = { [REMOTE]: { local: LOCAL, size: 1234, at: NOW.toISOString(), ok: true, reason: "" } };
  let calls = 0;
  const out = await localizeMarkdownImagesDetailed("![海报](" + REMOTE + ")", {
    wsRoot,
    map,
    now: NOW,
    saveArtifact: async () => { calls += 1; throw new Error("缓存命中不该下载"); },
  });
  assert.equal(calls, 0);
  assert.match(out.text, /!\[海报\]\(\/api\/ws\/file/);
  assert.equal(out.cached, 1);
  assert.equal(out.attempted, 0);
});

test("缓存命中失败且未过期：不再尝试，换文字说明", async (t) => {
  const wsRoot = tempRoot(t);
  const map = { [REMOTE]: { local: "", size: 0, at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), ok: false, reason: "下载失败 HTTP 404" } };
  let calls = 0;
  const out = await localizeMarkdownImagesDetailed("![海报](" + REMOTE + ")", {
    wsRoot,
    map,
    now: NOW,
    saveArtifact: async () => { calls += 1; return { url: LOCAL, local: true }; },
  });
  assert.equal(calls, 0, "24h 内的失败缓存不能反复重试");
  assert.ok(out.text.includes(IMAGE_UNAVAILABLE_NOTE));
  assert.ok(!out.text.includes(REMOTE));
});

test("失败缓存过期：允许重新尝试一次", async (t) => {
  const wsRoot = tempRoot(t);
  const map = { [REMOTE]: { local: "", size: 0, at: new Date(NOW.getTime() - FAILURE_TTL_MS - 1000).toISOString(), ok: false, reason: "旧的失败" } };
  let calls = 0;
  const out = await localizeMarkdownImagesDetailed("![海报](" + REMOTE + ")", {
    wsRoot,
    map,
    now: NOW,
    saveArtifact: async () => { calls += 1; return { url: LOCAL, local: true }; },
  });
  assert.equal(calls, 1);
  assert.match(out.text, /!\[海报\]\(\/api\/ws\/file/);
});

test("单条消息最多下载 3 张：超出部分直接文字说明", async (t) => {
  const wsRoot = tempRoot(t);
  const urls = [1, 2, 3, 4, 5].map((n) => `https://vendor.example.com/p${n}.png`);
  const text = urls.map((u, i) => `![图${i}](${u})`).join("\n");
  let calls = 0;
  const out = await localizeMarkdownImagesDetailed(text, {
    wsRoot,
    map: {},
    now: NOW,
    saveArtifact: async ({ url }) => {
      calls += 1;
      return { url: `/api/ws/file?path=${encodeURIComponent(`生成物/图片/${url.slice(-5)}`)}`, local: true };
    },
  });
  assert.equal(DEFAULT_MAX_PER_MESSAGE, 3);
  assert.equal(calls, 3, "默认只下 3 张");
  assert.equal(out.attempted, 3);
  assert.equal(out.skipped, 2);
  const notes = out.text.split(IMAGE_UNAVAILABLE_NOTE).length - 1;
  assert.equal(notes, 2, "超出的两张各留一行说明");
  assert.ok(!out.text.includes("vendor.example.com"), "输出里不许残留远端 URL");
});

test("异常降级：下载器抛错也只换文字，不抛给调用方", async (t) => {
  const wsRoot = tempRoot(t);
  const map = {};
  const out = await localizeMarkdownImagesDetailed("前文 ![海报](" + REMOTE + ") 后文", {
    wsRoot,
    map,
    now: NOW,
    saveArtifact: async () => { throw new Error("连接被重置"); },
  });
  assert.ok(out.text.includes("前文"));
  assert.ok(out.text.includes("后文"));
  assert.ok(out.text.includes(IMAGE_UNAVAILABLE_NOTE));
  assert.ok(!out.text.includes(REMOTE));
  assert.equal(map[REMOTE].ok, false);
  assert.match(map[REMOTE].reason, /连接被重置/);
});

test("没注入下载器：按失败降级，不留远端地址", async () => {
  const out = await localizeMarkdownImagesDetailed("![海报](" + REMOTE + ")", { map: {}, now: NOW });
  assert.ok(out.text.includes(IMAGE_UNAVAILABLE_NOTE));
  assert.ok(!out.text.includes(REMOTE));
});

test("读路径缓存版：只查缓存，命中换本地、未命中换文字，永不联网", async (t) => {
  const wsRoot = tempRoot(t);
  const map = {
    [REMOTE]: { local: LOCAL, size: 1, at: NOW.toISOString(), ok: true, reason: "" },
    [REMOTE_2]: { local: "", size: 0, at: NOW.toISOString(), ok: false, reason: "下载失败" },
  };
  const out = localizeMarkdownImagesCached(
    `![好的](${REMOTE})\n![坏的](${REMOTE_2})\n![没缓存](https://vendor.example.com/new.png)`,
    { wsRoot, map, now: NOW },
  );
  assert.match(out, /!\[好的\]\(\/api\/ws\/file/);
  assert.equal(out.split(IMAGE_UNAVAILABLE_NOTE).length - 1, 2);
  assert.ok(!out.includes("platform-outputs"));
  assert.ok(!out.includes("vendor.example.com"));
});

test("真实缓存文件：写入 记忆/运行时/外链图归档.json，结构是 url → {local,size,at,ok,reason}", async (t) => {
  const wsRoot = tempRoot(t);
  const out = await localizeMarkdownImages("![海报](" + REMOTE + ")", {
    wsRoot,
    now: NOW,
    saveArtifact: okSave(),
  });
  assert.ok(out.includes(LOCAL));
  const file = path.join(wsRoot, ARCHIVE_REL);
  assert.ok(fs.existsSync(file), "成功归档要落缓存文件");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed[REMOTE].ok, true);
  assert.equal(parsed[REMOTE].local, LOCAL);
  assert.ok("size" in parsed[REMOTE] && "at" in parsed[REMOTE] && "reason" in parsed[REMOTE]);
  // 读回也走同一结构
  const read = readImageArchive({ wsRoot });
  assert.equal(read[REMOTE].local, LOCAL);
});
