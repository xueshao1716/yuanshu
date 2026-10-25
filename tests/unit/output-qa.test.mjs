// 交付前预筛（搬 earshot 的"先测量筛、再让人/模型评"）+ 响度/同步证据
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseLoudness, checkOutput, evidenceNote, avDriftSec,
  AUDIO_LUFS_RANGE, TRUE_PEAK_MAX, MAX_AV_DRIFT_SEC, probeMedia,
} from "../../engine/output-qa.mjs";

test("解析 ffmpeg ebur128 输出：I / Peak / LRA", () => {
  const sample = `
[Parsed_ebur128_0 @ 000001] t: 12.0 M: -15.8 S: -16.1 I: -16.2 LUFS LRA: 3.4 LU
[Parsed_ebur128_0 @ 000001] True peak: Peak: -1.3 dBFS
`;
  const p = parseLoudness(sample);
  assert.equal(p.lufs, -16.2);
  assert.equal(p.truePeak, -1.3);
  assert.equal(p.lra, 3.4);
});

test("解析失败时返回 null，不编造数字", () => {
  assert.deepEqual(parseLoudness("nothing here"), { lufs: null, truePeak: null, lra: null });
});

test("文件不存在 / 0 字节直接判不合格", () => {
  const r1 = checkOutput("D:/definitely-not-here-xyz.mp4", { fileExists: () => false });
  assert.equal(r1.pass, false);
  assert.match(r1.fails.join(), /不存在/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-"));
  const empty = path.join(dir, "empty.png");
  fs.writeFileSync(empty, "");
  const r2 = checkOutput(empty);
  assert.equal(r2.pass, false);
  assert.match(r2.fails.join(), /0 字节/);
});

test("音画时长差算得出来，且超过阈值会被判出来", () => {
  assert.equal(avDriftSec({ hasAudio: true, hasVideo: true, audioDurationSec: 10.02, videoDurationSec: 10 }), 0.02);
  assert.equal(avDriftSec({ hasAudio: false, hasVideo: true }), null);
  const big = avDriftSec({ hasAudio: true, hasVideo: true, audioDurationSec: 10, videoDurationSec: 10 + MAX_AV_DRIFT_SEC + 1 });
  assert.ok(big > MAX_AV_DRIFT_SEC);
});

test("非媒体文件（海报/文档）只做存在性与大小检查", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa2-"));
  const png = path.join(dir, "poster.png");
  fs.writeFileSync(png, Buffer.alloc(2048));
  const r = checkOutput(png);
  assert.equal(r.pass, true);
  assert.equal(r.evidence.probe, undefined, "图片不该去跑 ffprobe");
});

test("交付说明那句话包含关键证据，不合格时说清原因", () => {
  const ok = evidenceNote({ pass: true, fails: [], warnings: [], evidence: { sizeBytes: 12 * 1024 * 1024, probe: { durationSec: 45.02, width: 1920, height: 1080, fps: 30 }, loudness: { ok: true, lufs: -16.2, truePeak: -1.3 }, avDriftSec: 0.02 } });
  assert.match(ok, /预筛通过/);
  assert.match(ok, /12\.0MB/);
  assert.match(ok, /1920×1080@30/);
  assert.match(ok, /-16\.2 LUFS/);

  const bad = evidenceNote({ pass: false, fails: ["真峰值 0.4 dBTP 超过 -1（会削波）"], warnings: [], evidence: {} });
  assert.match(bad, /预筛未过/);
  assert.match(bad, /削波/);
});

test("阈值是常量且合理（改阈值要显式改这里）", () => {
  assert.equal(AUDIO_LUFS_RANGE[0], -24);
  assert.equal(AUDIO_LUFS_RANGE[1], -10);
  assert.equal(TRUE_PEAK_MAX, -1);
  assert.equal(MAX_AV_DRIFT_SEC, 0.5);
});

test("ffprobe 不存在或路径错时如实报错，不抛异常", () => {
  const r = probeMedia("D:/nothing.mp4");
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === "string");
});

test("回归：只认 Summary 段，开头静音的瞬时 I: 不算整体响度", () => {
  const text = [
    "[Parsed_ebur128_0] t: 0.1 M: -120.7 S: -120.7 I: -70.0 LUFS LRA: 0.0 LU",
    "[Parsed_ebur128_0] t: 45.0 M: -16.6 S: -17.1 I: -16.2 LUFS LRA: 5.1 LU",
    "",
    "Summary:",
    "",
    "  Integrated loudness:",
    "    I:         -16.2 LUFS",
    "    Threshold: -26.3 LUFS",
    "",
    "  Loudness range:",
    "    LRA:         5.1 LU",
    "",
    "  True peak:",
    "    Peak:       -1.4 dBFS",
  ].join("\\n");
  const p = parseLoudness(text);
  assert.equal(p.lufs, -16.2, "必须是汇总里的整段响度，不是开头的 -70");
  assert.equal(p.truePeak, -1.4);
});
