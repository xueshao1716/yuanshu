// 一句话打开页面：意图解析 + 与前端标签一致性（2026-11-01）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseOpenIntent, navPayload, TARGETS, parseParams, navHref, trimParticles } from "../../engine/intent-router.mjs";
import { ROUTE_LABELS } from "../../engine/route-labels.mjs";

const root = path.resolve(import.meta.dirname, "../..");

test("打开任务清单 → tasks", () => {
  const r = parseOpenIntent("打开任务清单");
  assert.equal(r.route, "tasks");
  assert.equal(r.label, "任务");
});

test("看看定时任务 / 列出待办 都能到 tasks", () => {
  assert.equal(parseOpenIntent("看看定时任务").route, "tasks");
  assert.equal(parseOpenIntent("列出待办").route, "tasks");
});

test("去事务台看看 → gateway", () => {
  assert.equal(parseOpenIntent("去事务台看看").route, "gateway");
  assert.equal(parseOpenIntent("打开路由器").route, "gateway");
});

test("没有打开类动词就不算导航（别把普通对话切成跳页）", () => {
  assert.equal(parseOpenIntent("任务做完了"), null);
  assert.equal(parseOpenIntent("这个任务好难"), null);
  assert.equal(parseOpenIntent(""), null);
});

test("长句里带打开动词也能识别", () => {
  assert.equal(parseOpenIntent("帮我打开插件商店，我想装个东西").route, "plugins");
});

test("更长的词优先：任务清单不会误判成别的", () => {
  const r = parseOpenIntent("打开任务清单");
  assert.equal(r.matched, "任务清单");
});

test("navPayload 给前端的话", () => {
  const p = navPayload(parseOpenIntent("打开资产"));
  assert.equal(p.route, "assets");
  assert.match(p.text, /正在打开资产/);
  assert.equal(navPayload(null), null);
});

test("服务端标签与 frontend/src/nav.ts 一致（防漂移）", () => {
  const nav = fs.readFileSync(path.join(root, "frontend/src/nav.ts"), "utf8");
  const block = nav.slice(nav.indexOf("ROUTE_LABELS = {"), nav.indexOf("} as const"));
  const pairs = [...block.matchAll(/^\s*(\w+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 20, "解析到的标签太少，格式可能变了");
  for (const [k, v] of pairs) {
    assert.equal(ROUTE_LABELS[k], v, `路由 ${k} 的标签不一致`);
  }
});

test("每个 TARGETS 的 route 都有标签", () => {
  for (const t of TARGETS) assert.ok(ROUTE_LABELS[t.route], `缺标签：${t.route}`);
});

test('时间词解析：今天/昨天/本周/本月/最近N天', () => {
  assert.equal(parseParams('打开任务清单里今天的').day, 'today');
  assert.equal(parseParams('看看昨天的').day, 'yesterday');
  assert.equal(parseParams('本周的活').day, 'week');
  assert.equal(parseParams('这个月的').day, 'month');
  assert.equal(parseParams('最近3天的').day, 'recent3');
  assert.equal(parseParams('打开任务清单').day, undefined);
});

test('关键词解析：关于/包含 X', () => {
  assert.equal(parseParams('打开任务清单关于交付门的').q, '交付门', '句尾「的」要被裁掉');
  assert.equal(parseParams('找包含 auth 的记录').q, 'auth');
  assert.equal(parseParams('打开资产').q, undefined);
});

test('navHref 把条件拼进 hash', () => {
  assert.equal(navHref('tasks', { day: 'today' }), '#/tasks?day=today');
  assert.equal(navHref('tasks', {}), '#/tasks');
  assert.match(navHref('assets', { day: 'recent7', q: '海报' }), /q=%E6%B5%B7%E6%8A%A5/);
});

test('意图里带 params 与 href', () => {
  const intent = parseOpenIntent('打开任务清单里今天的');
  assert.equal(intent.route, 'tasks');
  assert.equal(intent.params.day, 'today');
  assert.equal(intent.href, '#/tasks?day=today');
  const payload = navPayload(intent);
  assert.equal(payload.href, '#/tasks?day=today');
  assert.match(payload.text, /day=today/);
});

test('关键词裁掉句尾助词', () => {
  assert.equal(trimParticles('交付门的'), '交付门');
  assert.equal(trimParticles('海报那件事里的'), '海报那件事');
  assert.equal(trimParticles('发布'), '发布');
  assert.equal(parseParams('关于的').q, undefined, '裁空了就不该带 q');
});
