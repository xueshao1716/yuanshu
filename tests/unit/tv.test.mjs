import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPublicUrl, normalizeSources, loadSources, saveSources, parsePlayGroups, rewritePlaylist, searchTv, safeFetch } from "../../engine/tv.mjs";

const pub = async () => [{ address: "93.184.216.34" }];

test("assertPublicUrl：内网/本机/解析到内网/非 http 一律拒绝", async () => {
  for (const u of ["http://127.0.0.1/a", "http://10.0.0.5/a", "http://192.168.1.2/", "http://localhost/x", "http://[::1]/", "ftp://a.com/", "file:///etc/passwd", "nope"])
    await assert.rejects(assertPublicUrl(u, pub), undefined, u);
  await assert.rejects(assertPublicUrl("http://evil.example/", async () => [{ address: "10.1.1.1" }]));
  assert.equal((await assertPublicUrl("https://cdn.example.com/a.m3u8", pub)).hostname, "cdn.example.com");
});

test("safeFetch：重定向到内网会被第二跳拦下", async () => {
  const f = async (u) => u.includes("start")
    ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8787/api/secret" } })
    : new Response("leak");
  await assert.rejects(safeFetch("https://a.example/start", { fetch: f, lookup: pub }), /内网/);
});

test("片源订阅：兼容 sources/api、数组/url、对象三种格式，去重并校验", () => {
  const a = normalizeSources({ sources: [{ name: "甲", api: "https://a.com/api.php/provide/vod" }, { name: "重", api: "https://a.com/api.php/provide/vod" }, { name: "坏", api: "javascript:1" }] });
  assert.equal(a.length, 1);
  assert.equal(normalizeSources([{ name: "乙", url: "http://b.com/x" }])[0].url, "http://b.com/x");
  assert.equal(normalizeSources({ k: { name: "丙", api: "https://c.com/x" } })[0].name, "丙");
  assert.throws(() => normalizeSources([{ name: "x", url: "ftp://x" }]), /没有可用/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tv-"));
  try {
    assert.deepEqual(loadSources(dir), []);
    saveSources(dir, a);
    assert.equal(loadSources(dir)[0].name, "甲");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("播放串解析：多线路，只留 m3u8/mp4，丢掉网页链接", () => {
  const g = parsePlayGroups("m3u8$$$web", "第1集$https://x.com/1/index.m3u8#第2集$https://x.com/2/index.m3u8?a=1$$$第1集$https://x.com/share/1.html");
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].episodes.map((e) => e.name), ["第1集", "第2集"]);
});

test("m3u8 改写：相对分片、绝对分片、密钥 URI 都走同源代理并带 token", () => {
  const out = rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg1.ts\nhttps://o.com/seg2.ts\n', "https://cdn.com/v/index.m3u8", "T");
  const lines = out.split("\n");
  assert.match(lines[1], /URI="\/api\/tv\/media\?url=https%3A%2F%2Fcdn\.com%2Fv%2Fkey\.bin&token=T"/);
  assert.match(lines[3], /^\/api\/tv\/media\?url=https%3A%2F%2Fcdn\.com%2Fv%2Fseg1\.ts&token=T$/);
  assert.match(lines[4], /url=https%3A%2F%2Fo\.com%2Fseg2\.ts/);
});

test("搜索：多源并行、同名合并、坏源只记失败不影响其它", async () => {
  const sources = normalizeSources([{ name: "甲", url: "https://a.com/api" }, { name: "乙", url: "https://b.com/api" }, { name: "坏", url: "https://c.com/api" }]);
  const f = async (u) => {
    if (u.startsWith("https://c.com")) return new Response("oops", { status: 500 });
    const id = u.startsWith("https://a.com") ? 1 : 2;
    return new Response(JSON.stringify({ list: [{ vod_id: id, vod_name: "流浪地球 ", vod_pic: "https://p/x.jpg", vod_remarks: "HD" }] }));
  };
  const r = await searchTv(sources, "流浪", { fetch: f, lookup: pub });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].variants.length, 2);
  assert.equal(r.failed.length, 1);
});
