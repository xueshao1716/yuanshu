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
  for (const required of ["['sandbox-mode', sessionId]", 'key={currentSessionId}', 'disabled={!!busy || active}', 'inFlight.current', 'mounted.current', 'role="alert"', '重新读取', '请先选择一个会话', '界面/API 记录', '<MaintenanceModePanel']) assert.ok(panel.includes(required), required);
});
test('maintenance UI is read-only and cannot claim permissions', () => {
  const panel = read('frontend/src/components/engine/MaintenanceModePanel.tsx');
  for (const required of ["['maintenance-status', sessionId]", 'defaultDurationMs', 'maxDurationMs', '超维模式', '不可启用', 'Pi', 'role="alert"']) assert.ok(panel.includes(required), required);
  assert.ok(!panel.includes('MaintenanceApi.request'));
  assert.ok(!panel.includes('MaintenanceApi.grant'));
});
