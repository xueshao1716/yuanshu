import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {knowledgeStorage} from '../../engine/knowledge-storage.mjs';
test('no-op transactions do not rewrite shared state and mutations remain fenced on disk',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-storage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 initFileLock({dir:path.join(root,'locks')});const io=knowledgeStorage(root);
 await io.transaction(data=>{data.worker={failures:0,cooldownUntil:0};});
 const before=fs.statSync(io.file('state.json'),{bigint:true});
 await io.transaction(data=>data.policy);const after=fs.statSync(io.file('state.json'),{bigint:true});
 assert.equal(after.ino,before.ino);assert.equal(after.mtimeNs,before.mtimeNs);
 await io.transaction(data=>{data.worker.failures++;});assert.equal(io.readState().worker.failures,1);
});
