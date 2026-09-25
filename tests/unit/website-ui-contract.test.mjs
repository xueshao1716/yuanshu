import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=name=>fs.readFileSync(new URL(`../../frontend/src/components/website/${name}`,import.meta.url),'utf8');
test('website editor has explicit selection editing, safe previews and legacy entry',()=>{
  assert.ok(read('WebsiteBoard.tsx').includes('旧版作品与草稿'));
  const workspace=read('WebsiteWorkspace.tsx');
  for(const contract of ['targetId','baseVersion','采用此版本','sandbox=""','websites.cancel','beforeunload']) assert.ok(workspace.includes(contract),contract);
  for(const contract of ['savedSnapshot.current=JSON.stringify(canvasDocument(editor))','JSON.stringify(canvasDocument(e))!==savedSnapshot.current','load(draft.doc,true)','showModal()','onCancel={()=>setPreview(null)}']) assert.ok(workspace.includes(contract),contract);
  const canvas=read('WebsiteCanvas.tsx');
  for(const contract of ['storageManager: false','allowScripts: false','allowUnsafeAttr: false','UndoManager.clear','parser:']) assert.ok(canvas.includes(contract),contract);
});
test('website entry starts AI from an idea with optional template and name',()=>{
  const board=read('WebsiteBoard.tsx');
  for(const contract of ["useState('')",'generate:true','model:model.value','开始 AI 设计','网站名称（选填）','参考模板（选填）','<details','WorkshopModelPicker'])assert.ok(board.includes(contract),contract);
  assert.ok(board.indexOf('<form')<board.indexOf('site-template-grid'));
  assert.ok(!board.includes('disabled={busy||!templates.length}'));
  assert.ok(!board.includes('用此模板开始'));
});
test('generation progress precedes the canvas and supports checkpoint resume and creative redesign',()=>{
  const workspace=read('WebsiteWorkspace.tsx'),panel=read('WebsiteRunPanel.tsx');
  assert.ok(workspace.indexOf('<WebsiteRunPanel')<workspace.indexOf('<WebsiteCanvas'));
  for(const contract of ['resume:true',"mode:creative?'creative':'edit'",'重新创意设计'])assert.ok(workspace.includes(contract),contract);
  for(const contract of ['onResume','继续本次任务','checkpoint','actualModel'])assert.ok(panel.includes(contract),contract);
});
