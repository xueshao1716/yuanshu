import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('computer tool is wired to both engines and local approval',()=>{
  const server=read('server.mjs');
  for(const snippet of ['COMPUTER_TOOL_SCHEMA,','computer_use: (args, ctx) => computerTool(computerUse, args, ctx)','...createComputerRoutes(',"pending?.toolName === 'computer-use'"]) assert.ok(server.includes(snippet),snippet);
  assert.ok(server.includes('initComputerTool((Type, sessionId) => createPiComputerTool(Type, () => computerUse, sessionId))'));
  assert.equal(server.split('initSessionManager({').length-1,1,'never reset session dependencies when adding a tool');
  assert.ok(read('engine/session-manager.mjs').includes('customTools.push(computerToolFactory('));
  assert.ok(read('engine/session-manager.mjs').includes('() => sm.getSessionId()'));
  assert.ok(read('engine/unified-chat.mjs').includes('defaultExecutor: (name, args, ctx) => _executeUnifiedTool(name, args, ctx)'));
});
test('system UI exposes scoped grant, clear support boundary and stop',()=>{
  const panel=read('frontend/src/components/ComputerUsePanel.tsx');
  for(const word of ['立即停止','仅授权 10 分钟','操作会话','目标窗口','屏幕文字','/api/computer/stop','/api/computer/grant'])assert.ok(panel.includes(word),word);
  assert.ok(read('frontend/src/pages/System.tsx').includes('<ComputerUsePanel />'));
  assert.ok(panel.includes('selectSession(active.sessionId)'));
  assert.ok(panel.includes("location.hash = '#/chat'"));
  assert.ok(panel.includes('电脑操作（受控试用）'));
  assert.ok(panel.includes('尚未完成真实桌面兼容性验收'));
});
