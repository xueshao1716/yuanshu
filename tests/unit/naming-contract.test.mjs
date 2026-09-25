// 命名契约测试（docs/NAMING.md）
//
// 锁三件事：
//   1) 版本号只有一个来源，任何一处漂移都当场失败（历史上散在 9 个文件、两条线各走各的）
//   2) 产物名格式稳定，且永不重名（以前聊天里所有视频都叫「元枢视频-N.mp4」）
//   3) 前端镜像实现与后端权威实现的类型表/扩展名表逐项一致（两份表最容易悄悄漂）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCT_VERSION, VERSION_TAG } from "../../engine/version.mjs";
import {
  artifactBaseName, artifactFileName, artifactKindLabel, artifactExtension,
} from "../../engine/workspace-api.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const META = JSON.parse(read("version.json"));

test('release locks track product version without changing dependency versions', () => {
  for (const file of ['package-lock.json', 'frontend/package-lock.json', 'app/package-lock.json', 'mcp-server/package-lock.json']) {
    const lock = JSON.parse(read(file));
    assert.equal(lock.version, META.version, file);
    assert.equal(lock.packages[''].version, META.version, file);
  }
  const cargo = read('app/src-tauri/Cargo.lock').split('[[package]]').find(block => block.includes('name = "yuanshu"'));
  assert.ok(cargo.includes(`version = "${META.version}"`));
});

test("版本号唯一来源：所有声明都必须等于 version.json", () => {
  assert.match(META.version, /^\d+\.\d+\.\d+$/, "version.json 的 version 必须是 x.y.z");

  // JSON 顶层版本
  for (const file of ["package.json", "app/package.json", "frontend/package.json", "mcp-server/package.json", "app/src-tauri/tauri.conf.json"]) {
    const v = JSON.parse(read(...file.split("/"))).version;
    assert.equal(v, META.version, `${file} 的 version 与 version.json 不一致（跑 npm run version:bump sync）`);
  }
  // TOML
  assert.match(read("app", "src-tauri", "Cargo.toml"), new RegExp(`^version = "${META.version.replace(/\./g, "\\.")}"`, "m"),
    "app/src-tauri/Cargo.toml 的 version 与 version.json 不一致");
  // 代码里的 serverInfo
  assert.ok(read("engine", "mcp-server.mjs").includes(`version: "${META.version}"`), "engine/mcp-server.mjs 的 serverInfo.version 不一致");
  assert.ok(read("mcp-server", "index.mjs").includes(`version: "${META.version}"`), "mcp-server/index.mjs 的 version 不一致");
});

test("MCP 协议版本不能被产品版本污染（那是协议规格，不是我们的版本）", () => {
  const mcp = read("engine", "mcp-server.mjs");
  const protocol = mcp.match(/protocolVersion:\s*rpc\.params\?\.protocolVersion \|\| "([^"]+)"/);
  assert.ok(protocol, "必须保留 protocolVersion 的读取");
  assert.notEqual(protocol[1], META.version, "protocolVersion 是 MCP 协议版本，绝不能跟着产品版本一起改");
  assert.match(protocol[1], /^\d{4}-\d{2}-\d{2}$/, "MCP 协议版本形如 2024-11-05");
});

test("导出常量与 version.json 一致", () => {
  assert.equal(PRODUCT_VERSION, META.version);
  assert.equal(VERSION_TAG, `v${META.version}`);
});

test("产物名遵守契约：摘要_类型_时间戳-id_v版本.扩展名，且逐一可区分", () => {
  // Naming follows the host's local calendar, not a fixed China timezone.
  const now = new Date(2026, 8, 14, 18, 12, 30, 456);
  const name = artifactFileName({ prompt: "拳手在雨夜的车站等到天亮", type: "video", now, uniqueId: "a1b2c3d4" });
  assert.equal(name, `拳手在雨夜的车站等到天亮_视频_20260914-181230-456-a1b2c3d4_${VERSION_TAG}.mp4`);
});

test("同一时刻同一提示词也必须产出不同文件名（曾经所有视频都叫元枢视频-N）", () => {
  const now = new Date("2026-09-14T18:12:30.456+08:00");
  const a = artifactFileName({ prompt: "同一段话", type: "video", now });
  const b = artifactFileName({ prompt: "同一段话", type: "video", now });
  assert.notEqual(a, b, "随机 id 保证重名不可能；否则下载会互相覆盖");
});

test("类型标签与扩展名覆盖视频/音乐/文本/图片/文档，未知类型不崩", () => {
  const cases = [
    ["video", "视频", ".mp4"], ["music", "音乐", ".mp3"], ["audio", "音频", ".wav"],
    ["text", "文本", ".txt"], ["novel", "文本", ".txt"], ["image", "图片", ".png"],
    ["document", "文档", ".md"], ["ppt", "演示", ".pptx"], ["html", "网页", ".html"],
  ];
  for (const [kind, label, ext] of cases) {
    assert.equal(artifactKindLabel(kind), label, `${kind} 的类型标签`);
    assert.equal(artifactExtension(kind), ext, `${kind} 的扩展名`);
  }
  assert.equal(artifactKindLabel("压根不存在的类型"), "产物");
  assert.equal(artifactExtension("压根不存在的类型"), "");
  assert.ok(artifactFileName({ prompt: "x", type: "music" }).endsWith(".mp3"));
});

test("提示词为空或全是非法字符时不留空段，也不含文件系统非法字符", () => {
  const now = new Date("2026-09-14T00:00:00.000Z");
  const empty = artifactBaseName({ prompt: "", type: "video", now, uniqueId: "id1" });
  assert.match(empty, /^元枢_视频_/, `空提示词要回退成「元枢」，实际: ${empty}`);
  // 前后端兜底值必须一致，否则同一份契约会产出两种名字
  assert.match(read("frontend", "src", "lib", "artifact-name.ts"), /fallback = '元枢'/, "前端兜底值必须是元枢");
  const dirty = artifactFileName({ prompt: 'a/b\\c:d*e?f"g<h>i|j', type: "image", now, uniqueId: "id2" });
  assert.ok(!/[\\/:*?"<>|]/.test(dirty), `不得含非法字符: ${dirty}`);
  assert.ok(dirty.length <= 120, `名字不能过长: ${dirty.length}`);
});

test("前端镜像实现的类型表/扩展名/格式必须与后端一致（两份表最容易悄悄漂）", () => {
  const fe = read("frontend", "src", "lib", "artifact-name.ts");
  const be = read("engine", "workspace-api.mjs");

  // 两张表里的每一对 key: value 都要在两个文件里同时出现
  const pairs = (src, constName) => {
    const block = src.match(new RegExp(`${constName}[^=]*=\\s*\\{([\\s\\S]*?)\\}`));
    assert.ok(block, `找不到 ${constName}`);
    const out = {};
    for (const m of block[1].matchAll(/(\w+):\s*'([^']*)'|(\w+):\s*"([^"]*)"/g)) {
      out[m[1] || m[3]] = m[2] ?? m[4];
    }
    return out;
  };
  // 后端是 `image: "图片"`，前端是 `image: '图片'`，两边都解析
  const beLabels = pairs(be, "ARTIFACT_KIND_LABELS");
  const feLabels = pairs(fe, "ARTIFACT_KIND_LABELS");
  assert.deepEqual(feLabels, beLabels, "前后端的类型标签表必须逐项一致");

  const beExt = pairs(be, "ARTIFACT_KIND_EXTENSIONS");
  const feExt = pairs(fe, "ARTIFACT_KIND_EXTENSIONS");
  assert.deepEqual(feExt, beExt, "前后端的扩展名表必须逐项一致");

  // 逗号）与格式顺序也必须一致
  assert.match(fe, /_v?\$\{VERSION_TAG\}|\$\{VERSION_TAG\}/, "前端产物名必须带版本段");
  for (const part of ["artifactSlug", "artifactKindLabel", "stamp", "VERSION_TAG"]) {
    assert.ok(fe.includes(part), `前端命名必须包含 ${part}，否则与后端格式不一致`);
  }
});

test("CHANGELOG 必须留一个空的 [Unreleased] 给下次收版，且当前版本有条目", () => {
  const cl = read("CHANGELOG.md");
  // 收版时如果把 [Unreleased] 换掉却没留新的，下一次 bump 就无处可收——
  // 2026-09-14 收 2.8.0 时正是这么漏的，靠 bump 时才发现。
  assert.match(cl, /^## \[Unreleased\]\s*$/m, "CHANGELOG 顶部必须保留一个空的 ## [Unreleased]");
  assert.ok(cl.includes(`## [${META.version}]`), `CHANGELOG 必须有当前版本 ## [${META.version}] 的条目`);
});

test("前端源码不得硬编码版本号（文案里的版本必须来自注入）", () => {
  // 原先两条用户可见文案写死了壳版本：「请先安装元枢 0.2.4 手机客户端」、
  // 「请确认客户端已更新到 0.2.4」。版本一升，这些话就变成假话——
  // 而且因为没人记得改，它会一直挂着旧数字，正是"版本号一直不动"最直观的表现。
  const offenders = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      text.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/\b\d+\.\d+\.\d+\b/g)) {
          const v = m[0];
          if (v.startsWith("127.0.0")) continue;        // 回环 IP，不是版本
          if (v === "0.0.0" && line.includes("unknown")) continue; // 读不到 version.json 时的显式占位
          offenders.push(`${path.relative(ROOT, full)}:${i + 1} ${v}`);
        }
      });
    }
  };
  walk(path.join(ROOT, "frontend", "src"));
  assert.deepEqual(offenders, [],
    `前端源码里不得写死版本号，请改用从 artifact-name 导入的 PRODUCT_VERSION：\n  ${offenders.join("\n  ")}`);
});

test("前端不得再出现硬编码的通用下载名", () => {
  const message = read("frontend", "src", "components", "Message.tsx");
  assert.ok(!/元枢视频-\$\{/.test(message), "Message.tsx 不得再回退成「元枢视频-N」");
  const fileLink = read("frontend", "src", "components", "FileLink.tsx");
  assert.ok(!/downloadApiFile\(href,\s*undefined/.test(fileLink), "FileLink 不能再把文件名传 undefined（会兜底成字面量 download）");
  const themes = read("frontend", "src", "pages", "Themes.tsx");
  // 只管下载文件名。Themes.tsx 里还有 `pi-theme-changed` 这个内部 CustomEvent 名，
  // 三个文件用法一致、用户看不见，不在命名契约范围内（契约管的是产物名）。
  assert.ok(!/a\.download\s*=\s*`pi-theme-/.test(themes), "主题下载文件名不得再用 pi- 前缀");
  assert.match(themes, /a\.download\s*=\s*`yuanshu-theme-/, "主题下载文件名应为 yuanshu-theme-*");
});
