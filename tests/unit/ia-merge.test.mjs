import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = f => fs.readFileSync(new URL(`../../frontend/src/${f}`, import.meta.url), 'utf8');

test('相近页面并入同一板块：旧路由保留为深链别名并归属所在板块', () => {
  const nav = read('nav.ts');
  const more = nav.match(/RAIL_MORE\s*=\s*\[([^\]]*)\]/)[1];
  for (const gone of ['lingxi', 'sessiondb', 'downloads', 'mcp']) assert.ok(!more.includes(`'${gone}'`), `${gone} 不应再单列在更多`);
  for (const [alias, owner] of [['sessiondb', 'board'], ['downloads', 'assets'], ['lingxi', 'apps'], ['mcp', 'engine']]) {
    assert.ok(nav.includes(`${alias}: '${owner}'`), `${alias} 必须归属 ${owner}`);
  }
  const layout = read('AppLayout.tsx');
  for (const page of ['BoardSessionsPage', 'AssetsDownloadsPage', 'AppsLingxiPage', 'EngineMcpPage']) assert.ok(layout.includes(page), `缺少别名组件 ${page}`);
  assert.ok(layout.includes('railOwner(route)'), '导航高亮必须按所属板块计算');
});

test('MCP/沙箱/超维各只在一处：MCP 在能力页，沙箱与超维在授权中心', () => {
  assert.ok(read('pages/Engine.tsx').includes('<McpPanel'), '能力页必须承载 MCP');
  assert.ok(!read('pages/System.tsx').includes('<McpPanel'), '系统页不得再放 MCP');
  assert.ok(!fs.existsSync(new URL('../../frontend/src/pages/McpPage.tsx', import.meta.url)), '独立 MCP 页已删除');
  const grants = read('pages/Grants.tsx');
  assert.ok(grants.includes('<SandboxModePanel') && grants.includes('<MaintenanceModePanel'));
});
