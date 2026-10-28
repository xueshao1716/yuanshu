// web_search 走 RSS：解析/中文/兜底（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import { webSearchTool, parseBingRss } from "../../engine/tools/unified-tools.mjs";

const RSS = `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0"><channel><title>必应：杭州 亚运会</title>
<item><title>杭州亚运会闭幕</title><link>https://example.com/a</link><description>杭州第19届亚运会闭幕式举行</description></item>
<item><title>亚运奖牌榜</title><link>https://example.com/b</link><description><![CDATA[中国队位列第一]]></description></item>
</channel></rss>`;

test("parseBingRss：解析 title/link/description，并去掉 CDATA 与标签", () => {
  const items = parseBingRss(RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "杭州亚运会闭幕");
  assert.equal(items[0].url, "https://example.com/a");
  assert.match(items[1].snippet, /中国队位列第一/);
});

test("中文查询走 RSS：结果和查询真的相关", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, text: async () => RSS };
  };
  const out = await webSearchTool("杭州 亚运会", fakeFetch);
  assert.match(calls[0], /format=rss/);
  assert.match(out, /杭州亚运会闭幕/);
  assert.match(out, /https:\/\/example\.com\/a/);
});

test("RSS 没结果 → 落到 HTML 兜底", async () => {
  const html = `<ol><li class="b_algo"><h2><a href="https://example.com/x">英文结果</a></h2><p>摘要</p></li></ol>`;
  let n = 0;
  const fakeFetch = async () => { n += 1; return n === 1 ? { ok: true, text: async () => "<rss></rss>" } : { ok: true, text: async () => html } };
  const out = await webSearchTool("some query", fakeFetch);
  assert.match(out, /英文结果/);
});

test("全都失败 → 返回人话，不抛异常", async () => {
  const fakeFetch = async () => { throw new Error("network down") };
  const out = await webSearchTool("x", fakeFetch);
  assert.match(out, /（搜索/);
});

test("空查询直接拒绝", async () => {
  assert.match(await webSearchTool("   "), /关键词为空/);
});
