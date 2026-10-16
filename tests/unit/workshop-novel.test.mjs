// workshop-novel 数据层单测：书架 CRUD + 防穿越（临时目录，不碰真实 novels/）
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 每个用例独立临时目录
let tmp = "";
process.env.PI_NOVELS_DIR = "";
const mod = await import("../../engine/workshop-novel.mjs");
import { defaultWorkspace } from "../../engine/workspace-default.mjs";
const src = fs.readFileSync(new URL("../../engine/workshop-novel.mjs", import.meta.url), "utf8");

test("novelsDir 不写死 D 盘路径，env 优先、否则工作空间/novels", () => {
  assert.ok(!src.includes("D:\\\\pi-workspace\\\\novels"), "不得硬编码 D:\\\\pi-workspace\\\\novels");
  assert.ok(!src.includes("D:/pi-workspace/novels"), "不得硬编码 D:/pi-workspace/novels");
  const custom = path.join(os.tmpdir(), "pi-novels-custom");
  const prev = process.env.PI_NOVELS_DIR;
  process.env.PI_NOVELS_DIR = custom;
  assert.equal(mod.novelsDir(), custom);
  if (prev === undefined) delete process.env.PI_NOVELS_DIR;
  else process.env.PI_NOVELS_DIR = prev;
  const viaRoot = mod.resolveNovelsDir({ env: {}, wsRoot: "E:\\ws" });
  assert.equal(viaRoot, path.join("E:\\ws", "novels"));
  const viaHome = mod.resolveNovelsDir({ env: {}, wsRoot: "" });
  assert.equal(viaHome, path.join(defaultWorkspace(), "novels"));
});

describe("workshop-novel 数据层", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "novel-test-"));
    process.env.PI_NOVELS_DIR = tmp;
  });
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test("createBook 建骨架（meta+truth+chapters）", () => {
    const r = mod.createBook({ title: "测试之书", genre: "scifi", protagonist: "陈默", setting: "末世废土", narrator: "第一人称" });
    assert.ok(r.ok && r.id);
    const bd = path.join(tmp, r.id);
    assert.ok(fs.existsSync(path.join(bd, "meta.json")));
    assert.ok(fs.existsSync(path.join(bd, "chapters")));
    for (const f of ["canon.md", "current_state.json", "pending_hooks.json", "chapter_summaries.json"]) {
      assert.ok(fs.existsSync(path.join(bd, "truth", f)), f);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(bd, "meta.json"), "utf8"));
    assert.equal(meta.title, "测试之书");
    assert.equal(meta.narrator, "第一人称");
  });

  test("createBook 缺书名报错 / 非法题材回退 xianxia", () => {
    assert.ok(mod.createBook({ title: "" }).error);
    const r = mod.createBook({ title: "题材兜底", genre: "hacker" });
    assert.ok(r.ok);
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, r.id, "meta.json"), "utf8"));
    assert.equal(meta.genre, "xianxia");
  });

  test("listBooks 按 createdAt 倒序、章节数正确", () => {
    mod.createBook({ title: "旧书" });
    const r2 = mod.createBook({ title: "新书" });
    // 给新书写一章
    fs.writeFileSync(path.join(tmp, r2.id, "chapters", "第001章.md"), "# 一", "utf8");
    const list = mod.listBooks();
    assert.equal(list.length, 2);
    assert.equal(list[0].title, "新书");
    assert.equal(list[0].chapters, 1);
    assert.equal(list[1].chapters, 0);
  });

  test("bookDetail 返回章节列表与 nextCh", () => {
    const r = mod.createBook({ title: "详情书" });
    const bd = path.join(tmp, r.id, "chapters");
    fs.writeFileSync(path.join(bd, "第001章.md"), "a", "utf8");
    fs.writeFileSync(path.join(bd, "第003章.md"), "b", "utf8"); // 故意跳号
    fs.writeFileSync(path.join(bd, "乱入.txt"), "c", "utf8");
    const d = mod.bookDetail(r.id);
    assert.equal(d.chapters.length, 2);
    assert.deepEqual(d.chapters.map(c => c.no), [1, 3]);
    assert.equal(d.nextCh, 4); // 取最大编号+1
    assert.ok(d.truth.canon.includes("硬事实"));
  });

  test("writeChapter 覆盖已有章节；穿越和不存在被拒", () => {
    const r = mod.createBook({ title: "改章书" });
    fs.writeFileSync(path.join(tmp, r.id, "chapters", "第001章.md"), "旧正文", "utf8");
    const w = mod.writeChapter(r.id, "第001章.md", "新正文");
    assert.ok(w.ok);
    assert.equal(mod.readChapter(r.id, "第001章.md").content, "新正文");
    assert.ok(mod.writeChapter(r.id, "../../../secret.md", "x").error);
    assert.ok(mod.writeChapter(r.id, "第009章.md", "还不存在").error);
    assert.ok(mod.writeChapter(r.id, "第001章.md", "x".repeat(200_001)).error);
  });

  test("bookDetail 章节带标题，取自首行标题", () => {
    const r = mod.createBook({ title: "带标题书" });
    fs.writeFileSync(path.join(tmp, r.id, "chapters", "第001章.md"), "# 第一章 三十丈下的哭声\n\n正文", "utf8");
    const d = mod.bookDetail(r.id);
    assert.equal(d.chapters[0].title, "三十丈下的哭声");
    assert.ok(d.chapters[0].chars > 0);
  });

  test("readChapter 读正文；非法 id/file 被拒（防穿越）", () => {
    const r = mod.createBook({ title: "阅读书" });
    fs.writeFileSync(path.join(tmp, r.id, "chapters", "第001章.md"), "正文内容", "utf8");
    const ok = mod.readChapter(r.id, "第001章.md");
    assert.equal(ok.content, "正文内容");
    // 目录穿越
    assert.ok(mod.readChapter("../etc", "第001章.md").error || !mod.readChapter("..\\..\\x", "第001章.md").ok);
    assert.ok(mod.readChapter(r.id, "../../../secret.md").error);
    assert.ok(mod.readChapter(r.id, "../../meta.json").error);
    assert.ok(mod.readBook === undefined); // 不存在的导出不应存在（防拼写漂移）
  });

  test("listBooks/bookDetail 对不存在目录返回空/错误，不抛异常", () => {
    process.env.PI_NOVELS_DIR = path.join(tmp, "不存在");
    assert.deepEqual(mod.listBooks(), []);
    assert.ok(mod.bookDetail("任何").error);
    process.env.PI_NOVELS_DIR = tmp;
  });

  test("管道节点目录覆盖产品化/五层/真相/写章/修订/导出", () => {
    const ids = mod.PIPELINE_NODES.map(n => n.id);
    for (const id of ["product", "voice", "world", "characters", "outline", "canon", "state", "hooks", "ledger", "subplots", "arcs", "matrix", "summaries", "write", "revise", "export"]) {
      assert.ok(ids.includes(id), `缺管道节点 ${id}`);
    }
  });

  test("createBook 铺齐管道文件，bookDetail 带节点进度", () => {
    const r = mod.createBook({ title: "管道书", protagonist: "阿宁" });
    const bd = path.join(tmp, r.id);
    for (const rel of ["product.md", "layers/voice.md", "layers/world.md", "layers/characters.md", "layers/outline.md", "truth/canon.md", "truth/particle_ledger.json", "truth/subplot_board.json", "truth/emotional_arcs.json", "truth/character_matrix.json"]) {
      assert.ok(fs.existsSync(path.join(bd, rel)), rel);
    }
    const d = mod.bookDetail(r.id);
    assert.ok(Array.isArray(d.pipeline));
    assert.equal(d.pipeline.length, mod.PIPELINE_NODES.length);
    const product = d.pipeline.find(n => n.id === "product");
    assert.equal(product.ready, false);
    const list = mod.listBooks();
    assert.equal(list[0].pipelineReady, 0);
    assert.ok(list[0].pipelineTotal >= 10);
  });

  test("readNode/writeNode 只认白名单，穿越被拒", () => {
    const r = mod.createBook({ title: "节点书" });
    const bad = mod.writeNode(r.id, "../../etc", "x");
    assert.ok(bad.error);
    const bad2 = mod.writeNode(r.id, "voice", "# 声音\n冷硬短句");
    assert.ok(bad2.ok);
    const got = mod.readNode(r.id, "voice");
    assert.ok(got.content.includes("冷硬短句"));
    const d = mod.bookDetail(r.id);
    assert.equal(d.pipeline.find(n => n.id === "voice").ready, true);
  });

  test("updateBook 改书名状态；deleteBook 删目录", () => {
    const r = mod.createBook({ title: "旧名" });
    const u = mod.updateBook(r.id, { title: "新名", status: "archived" });
    assert.ok(u.ok);
    const d = mod.bookDetail(r.id);
    assert.equal(d.meta.title, "新名");
    assert.equal(d.meta.status, "archived");
    const del = mod.deleteBook(r.id);
    assert.ok(del.ok);
    assert.ok(mod.bookDetail(r.id).error);
  });

  test("exportBook 按章号拼接正文", () => {
    const r = mod.createBook({ title: "导出书" });
    fs.writeFileSync(path.join(tmp, r.id, "chapters", "第001章.md"), "第一章", "utf8");
    fs.writeFileSync(path.join(tmp, r.id, "chapters", "第002章.md"), "第二章", "utf8");
    const exp = mod.exportBook(r.id);
    assert.ok(exp.ok);
    assert.ok(exp.content.includes("第一章"));
    assert.ok(exp.content.includes("第二章"));
    assert.ok(fs.existsSync(path.join(tmp, r.id, "export.md")));
  });

  test("作者意见 notes.md 可读写，详情带回", () => {
    const r = mod.createBook({ title: "意见书" });
    assert.equal(mod.bookDetail(r.id).notes, "");
    const w = mod.writeNotes(r.id, "偏日常，少装逼");
    assert.ok(w.ok);
    assert.equal(mod.bookDetail(r.id).notes, "偏日常，少装逼");
    assert.ok(mod.writeNotes("../x", "no").error);
  });
});

test("handleBookStudio 非法 id 返回 400，不得因 safeId 未定义抛 500", async () => {
  const { handleBookStudio } = await import("../../engine/workshop-novel-run.mjs");
  let status = 0;
  let body = null;
  const json = (_res, code, obj) => { status = code; body = obj; };
  await handleBookStudio({ json }, {}, { id: "bad id with space" });
  assert.equal(status, 400);
  assert.ok(body?.error);
});

test("workshop-novel-run 在本文件定义 safeId，不靠外部绑定", () => {
  const src = fs.readFileSync(new URL("../../engine/workshop-novel-run.mjs", import.meta.url), "utf8");
  assert.match(src, /function safeId\(/);
  assert.ok(!src.includes("import { bookDetail, novelsDir, readChapter, writeNotes, safeId }"), "不得从 workshop-novel 再 import safeId");
});

test("findSkillPath 能找到仓库内 novel-forge-v10", async () => {
  const { findSkillPath } = await import("../../engine/workshop.mjs");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const p = await findSkillPath({
    CONFIG: { cwd: root },
    getAgentDir: () => path.join(os.homedir(), ".pi", "agent"),
    DefaultResourceLoader: class {
      async reload() {}
      getSkills() { return { skills: [] }; }
    },
  }, "novel-forge-v10");
  assert.ok(p && String(p).replace(/\\/g, "/").includes("skills/novel-forge-v10"), p);
});
