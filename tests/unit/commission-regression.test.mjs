// 设计委托自动对比的单元测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { annotateRegressions } from "../../engine/design-commission.mjs";

function makePng(w, h, fn) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = fn(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const body = Buffer.concat([Buffer.from(t, "latin1"), d]);
    const tab = [];
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tab[n] = c >>> 0 }
    let crc = 0xffffffff;
    for (const byte of body) crc = tab[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const cb = Buffer.alloc(4); cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, cb]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "comm-"));
const chess = (x, y) => (((x >> 2) + (y >> 2)) % 2 ? [240, 240, 240] : [10, 10, 10]);
const flat = () => [128, 128, 128];

test("退化：同名产物这版糊了 → 产出 warn issue 并标记在产物上", () => {
  const root = ws();
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.writeFileSync(path.join(root, "a/base.png"), makePng(32, 32, chess));
  fs.writeFileSync(path.join(root, "a/cand.png"), makePng(32, 32, flat));
  const files = [{ name: "主图", url: "/a/cand.png" }];
  const issues = annotateRegressions({
    files, prevFiles: [{ name: "主图", url: "/a/base.png" }], wsRoot: root,
    resolve: (u) => path.join(root, String(u).replace(/^\//, "")),
  });
  assert.equal(files[0].compare.verdict, "rollback");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "regression");
  assert.match(issues[0].message, /主图.*退化/);
});

test("没退化：同名产物对比通过 → 不产出 issue", () => {
  const root = ws();
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.writeFileSync(path.join(root, "a/base.png"), makePng(32, 32, flat));
  fs.writeFileSync(path.join(root, "a/cand.png"), makePng(32, 32, chess));
  const files = [{ name: "主图", url: "/a/cand.png" }];
  const issues = annotateRegressions({
    files, prevFiles: [{ name: "主图", url: "/a/base.png" }], wsRoot: root,
    resolve: (u) => path.join(root, String(u).replace(/^\//, "")),
  });
  assert.equal(files[0].compare.verdict, "keep");
  assert.equal(issues.length, 0);
});

test("没有上一版 / 名字对不上 → 跳过（不误报）", () => {
  const root = ws();
  const files = [{ name: "主图", url: "/x.png" }];
  assert.equal(annotateRegressions({ files, prevFiles: [], resolve: (u) => u }).length, 0);
  assert.equal(annotateRegressions({ files, prevFiles: [{ name: "别的", url: "/y.png" }], resolve: (u) => u }).length, 0);
  assert.equal(files[0].compare, undefined);
});

test("路径解析失败也不炸：compare 标 unknown", () => {
  const root = ws();
  const files = [{ name: "主图", url: "/nope.png" }];
  const issues = annotateRegressions({ files, prevFiles: [{ name: "主图", url: "/missing.png" }], wsRoot: root, resolve: (u) => path.join(root, String(u).replace(/^\//, "")) });
  assert.equal(issues.length, 0);
  assert.equal(files[0].compare.verdict, "unknown");
});
