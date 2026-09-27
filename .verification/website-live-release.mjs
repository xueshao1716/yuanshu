import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base='http://127.0.0.1:8787';
const token=fs.readFileSync('.token','utf8').trim();
const headers={Authorization:`Bearer ${token}`};
const version=await(await fetch(base+'/api/frontend-version',{headers})).json();
console.log({version});
assert.ok(JSON.stringify(version).includes('2.116.1'));
const response=await fetch(base+'/');assert.equal(response.status,200);
const index=await response.text(),disk=fs.readFileSync('frontend/dist/index.html','utf8');
assert.equal(index,disk);
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext();
 await context.addInitScript(({token})=>{if(window===window.top){localStorage.setItem('yuanshu_access_token',token);localStorage.setItem('pi_workshop_tab','ui');}},{token});
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/#/workshop');
 await page.getByLabel('描述你的想法').waitFor();
 await page.getByRole('button',{name:'开始 AI 设计',exact:true}).waitFor();
 const loaded=await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/WebsiteBoard-.*\.js/.test(n)));
 assert.ok(loaded.length>0);
 const chunk=await(await fetch(loaded[0])).text();assert.ok(chunk.includes('开始 AI 设计'));
 assert.deepEqual(errors,[]);
 console.log({liveWorkshop:true,indexSha256:crypto.createHash('sha256').update(index).digest('hex'),loaded,errors});
}finally{await browser.close();}
