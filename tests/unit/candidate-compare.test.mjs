// 候选对比：图片/HTML/代码的退化判定（2026-11-01）
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { compareCandidates, imageMetrics, htmlMetrics, codeMetrics, pngInfo, decodePngRgb } from "../../engine/candidate-compare.mjs";

// 造一张 w×h 的纯色/棋盘 PNG（8bit RGB，非隔行）
function makePng(w, h, colorFn) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0; // filter none
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = colorFn(x, y);
      const off = y * (w * 3 + 1) + 1 + x * 3;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const chess = (x, y) => (((x >> 2) + (y >> 2)) % 2 ? [240, 240, 240] : [10, 10, 10]);
const flat = () => [128, 128, 128];

test("PNG 解码：宽高与像素可读", () => {
  const png = makePng(16, 16, chess);
  const info = pngInfo(png);
  assert.equal(info.w, 16);
  assert.equal(info.h, 16);
  const dec = decodePngRgb(png);
  assert.equal(dec.rgb.length, 16 * 16 * 3);
});

test("图片指标：棋盘图对比度/边缘密度都高，纯色图都低", () => {
  const c = imageMetrics(makePng(16, 16, chess));
  const f = imageMetrics(makePng(16, 16, flat));
  assert.ok(c.std > f.std, "棋盘对比度应更高");
  assert.ok(c.edgeDensity > f.edgeDensity, "棋盘边缘更多");
  assert.equal(f.std, 0);
});

test("候选糊成一片 → rollback", () => {
  const r = compareCandidates({ kind: "image", baseline: makePng(32, 32, chess), candidate: makePng(32, 32, flat) });
  assert.equal(r.verdict, "rollback");
  assert.ok(r.degraded.some((d) => d.includes("对比度") || d.includes("细节")));
});

test("尺寸变化 → rollback", () => {
  const r = compareCandidates({ kind: "image", baseline: makePng(32, 32, chess), candidate: makePng(64, 32, chess) });
  assert.equal(r.verdict, "rollback");
  assert.ok(r.degraded.some((d) => d.includes("尺寸")));
});

test("候选更好 → keep", () => {
  const r = compareCandidates({ kind: "image", baseline: makePng(32, 32, flat), candidate: makePng(32, 32, chess) });
  assert.equal(r.verdict, "keep");
  assert.ok(r.improved.length >= 1);
});

test("HTML：图片/脚本变少 → rollback", () => {
  const base = '<html><body><img src="a.png"><img src="b.png"><script>x()</script><a href="https://x">l</a></body></html>';
  const cand = '<html><body><p>空</p></body></html>';
  const r = compareCandidates({ kind: "html", baseline: base, candidate: cand });
  assert.equal(r.verdict, "rollback");
  assert.ok(r.degraded.some((d) => d.includes("图片引用减少")));
});

test("HTML：外链变多也算退化", () => {
  const base = '<img src="1.png">';
  const cand = '<img src="https://a/x.png"><img src="https://b/y.png">';
  const r = compareCandidates({ kind: "html", baseline: base, candidate: cand });
  assert.ok(r.degraded.some((d) => d.includes("外链变多")));
});

test("代码：导出被删 → rollback", () => {
  const base = "export function a(){}\nexport const b = 1;\n";
  const cand = "export function a(){}\n";
  const r = compareCandidates({ kind: "code", baseline: base, candidate: cand });
  assert.equal(r.verdict, "rollback");
  assert.ok(r.degraded.some((d) => d.includes("导出被删") && d.includes("b")));
});

test("代码：新增导出 → keep", () => {
  const base = "export function a(){}\n";
  const cand = "export function a(){}\nexport function c(){}\n";
  const r = compareCandidates({ kind: "code", baseline: base, candidate: cand });
  assert.equal(r.verdict, "keep");
  assert.ok(r.improved.includes("新增导出"));
});

test("不可解析的候选 → rollback 并说明原因", () => {
  const r = compareCandidates({ kind: "image", baseline: makePng(8, 8, chess), candidate: Buffer.from("not a png") });
  assert.equal(r.verdict, "rollback");
  assert.match(r.degraded[0], /无法度量/);
});

test("HTML 指标：行数/外链统计", () => {
  const m = htmlMetrics('<a href="https://a"></a>\n<img src="b">');
  assert.equal(m.lines, 2);
  assert.equal(m.external, 1);
  assert.equal(m.imgs, 1);
});

test("代码指标：导出集合去重", () => {
  const m = codeMetrics("export function a(){}\nexport const a2 = 1;\nexport class C {}\n");
  assert.deepEqual(m.exports, ["C", "a", "a2"]);
});
