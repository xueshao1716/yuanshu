import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
test('sandbox client carries explicit session on reads and writes', () => {
  const api = read('frontend/src/api.ts');
  assert.ok(api.split('\n').some(line => line.includes('/api/sandbox/mode?session=') && line.includes('encodeURIComponent(sessionId)')));
  assert.ok(api.split('\n').some(line => line.includes('/api/sandbox/mode') && line.includes('body: { sessionId, preset, reason }')));
});
test('sandbox panel isolates cache, remounts, locks concurrent changes and handles errors', () => {
  const panel = read('frontend/src/components/engine/SandboxModePanel.tsx');
  for (const required of ["['sandbox-mode', sessionId]", 'key={currentSessionId}', 'disabled={!!busy || active}', 'role="alert"', '重新读取', '请先选择一个会话', '界面/API 记录']) assert.ok(panel.includes(required), required);
  // 2026-10（1cf67db1）：沙箱与超维拆成两张独立卡片，各自直接挂在系统页，不再互嵌
  assert.ok(!panel.includes('<MaintenanceModePanel'), '沙箱面板不得再内嵌超维面板（已拆分）');
  // 2026-10 功能板块整理：两张卡片集中到授权中心「本会话执行权限」，系统页不再重复放
  const grants = read('frontend/src/pages/Grants.tsx');
  assert.ok(grants.includes('<SandboxModePanel') && grants.includes('<MaintenanceModePanel'), '授权中心必须分别渲染沙箱与超维两张卡片');
  const system = read('frontend/src/pages/System.tsx');
  assert.ok(!system.includes('<SandboxModePanel') && !system.includes('<MaintenanceModePanel'), '系统页不得重复渲染沙箱/超维面板');
});
test('maintenance UI requests human approval but cannot directly grant permissions', () => {
  const panel = read('frontend/src/components/engine/MaintenanceModePanel.tsx');
  for (const required of ["['maintenance-status', sessionId]", 'defaultDurationMs', 'maxDurationMs', '超维模式', '不可启用', 'Pi', 'role="alert"']) assert.ok(panel.includes(required), required);
  for (const required of ['MaintenanceApi.request', 'ConfirmApi.answer', 'data.canConfirm', 'data?.pending?.map', '批准本次超维授权', '远程页面只能请求或取消']) assert.ok(panel.includes(required), required);
  assert.ok(!panel.includes('MaintenanceApi.grant'));
  assert.ok(!panel.includes('MaintenanceApi.renew'));
  const server = read('server.mjs');
  assert.ok(server.split('\n').some(line => line.includes("pending?.toolName === 'maintenance'") && line.includes('!isLocalMaintenanceApproval(req)') && line.includes('403')));
});
