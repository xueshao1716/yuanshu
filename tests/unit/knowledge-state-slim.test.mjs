import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {knowledgeStorage} from '../../engine/knowledge/storage.mjs';

// 2026-11-18 真机：state.json 涨到 8.39MB（上限 8MB 只剩 147 字节），每次事务整份解析/序列化/落盘，
// 主线程每 5 秒卡 0.3–3.7 秒。大头是已提交任务里留着的 candidate/validation——条目正文早已落到 entries/ 和 journal/。
test('已提交任务不再背着 candidate/validation：下一次事务就把存量瘦下来，其余状态原样',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-slim-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  initFileLock({dir:path.join(root,'locks')});const io=knowledgeStorage(root);
  const job=(id,state)=>({id,workspace:io.workspace,state,revision:3,generation:1,entryId:state==='committed'?'e'.repeat(64):undefined,
    candidate:{kind:'source',text:'很长的原文'.repeat(200)},validation:{state:'ready',entry:{text:'很长的原文'.repeat(200)},conflicts:['x']}});
  const committed='a'.repeat(64),review='b'.repeat(64);
  // 模拟存量：绕过事务直接写一份胖状态
  await io.transaction(data=>{data.worker={failures:0};});
  const fat=io.readState();fat.jobs[committed]=job(committed,'committed');fat.jobs[review]=job(review,'review_required');
  io.write('state.json',fat);const fatBytes=fs.statSync(io.file('state.json')).size;

  await io.transaction(data=>data.policy);
  const disk=io.readState();
  assert.equal(disk.jobs[committed].candidate,undefined);
  assert.equal(disk.jobs[committed].validation,undefined);
  assert.equal(disk.jobs[committed].entryId,'e'.repeat(64));
  assert.equal(disk.jobs[committed].state,'committed');
  // 待审的还要靠 candidate/validation 做决定，不能动
  assert.ok(disk.jobs[review].candidate);assert.deepEqual(disk.jobs[review].validation.conflicts,['x']);
  assert.ok(fs.statSync(io.file('state.json')).size<fatBytes*0.6);

  // 瘦过之后的空事务不再改写文件
  const before=fs.statSync(io.file('state.json'),{bigint:true});
  await io.transaction(data=>data.policy);
  assert.equal(fs.statSync(io.file('state.json'),{bigint:true}).mtimeNs,before.mtimeNs);
});

test('同一事务里刚提交的任务也直接落成瘦的',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-slim2-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  initFileLock({dir:path.join(root,'locks')});const io=knowledgeStorage(root);
  const id='c'.repeat(64);
  await io.transaction(data=>{data.jobs[id]={id,workspace:io.workspace,state:'committed',revision:1,generation:1,entryId:'d'.repeat(64),
    candidate:{text:'x'},validation:{state:'ready'}};});
  const disk=io.readState().jobs[id];
  assert.equal(disk.candidate,undefined);assert.equal(disk.validation,undefined);assert.equal(disk.entryId,'d'.repeat(64));
});

test('方法条目检索时要拿 candidate 重跑核验：方法类已提交任务保留 candidate，只去 validation',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-slim3-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  initFileLock({dir:path.join(root,'locks')});const io=knowledgeStorage(root);
  const id='f'.repeat(64);
  await io.transaction(data=>{data.jobs[id]={id,workspace:io.workspace,state:'committed',revision:1,generation:1,entryId:'d'.repeat(64),
    candidate:{kind:'method',text:'x'},validation:{state:'ready'}};});
  const disk=io.readState().jobs[id];
  assert.equal(disk.candidate.kind,'method');assert.equal(disk.validation,undefined);
});
