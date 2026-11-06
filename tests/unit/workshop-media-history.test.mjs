import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readArtifactSidecar, writeArtifactSidecar } from "../../engine/workspace-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "frontend", "src");
const read = (...parts) => readFileSync(join(SRC, ...parts), "utf8");

test("旁路要记下完整提示词，列表不能把 json 当成作品", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-art-"));
  const file = join(dir, "青衣修士_120000-001.png");
  try {
    writeFileSync(file, "x");
    writeArtifactSidecar(file, { prompt: "青衣洗白了，交领右衽", type: "image" });
    assert.equal(readArtifactSidecar(file), "青衣洗白了，交领右衽");
    const src = readFileSync(join(ROOT, "engine", "workspace-api.mjs"), "utf8");
    const fn = src.slice(src.indexOf("export async function handleWsArtifacts"));
    assert.ok(fn.includes("readArtifactSidecar") || fn.includes(".json"), "列表要读旁路提示词");
    assert.ok(/endsWith\(["']\.json["']\)/.test(fn) || fn.includes(".json"), "json 旁路不得当作品列出");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("出图落盘必须带上 prompt，否则往期填不回提示词", () => {
  const src = readFileSync(join(ROOT, "engine", "media", "api.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function handleImageWithSave"));
  assert.ok(fn.includes("prompt"), "saveArtifact 得出图提示词");
});

test("绘画和视频工坊都要有往期记录，点开能回看", () => {
  const image = read("components", "panels", "GeneratePanel.tsx");
  const video = read("components", "panels", "VideoGeneratePanel.tsx");
  assert.ok(image.includes("MediaHistory") || image.includes("往期"), "绘画要有往期");
  assert.ok(video.includes("MediaHistory") || video.includes("往期"), "视频要有往期");
  const hist = read("components", "MediaHistory.tsx");
  assert.ok(hist.includes("WsApi.artifacts") || hist.includes("/api/ws/artifacts"), "往期扫生成物，不另起一本账");
  assert.ok(hist.includes("onPick"), "点一条要能回看/填回");
  assert.ok(hist.includes("min-h-11") || hist.includes("min-h-"), "触控够大");
});
