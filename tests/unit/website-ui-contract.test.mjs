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
