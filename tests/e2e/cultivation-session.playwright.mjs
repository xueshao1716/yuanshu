// Isolated web fixtures: no production credentials, policies or paid model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {draft} from '../helpers/cultivation-fixture.mjs';
import {defaultPolicy} from '../../engine/cultivation/policy.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),dist=path.join(root,'tmp/verification-dist');
const server=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(dist,name==='/'?'index.html':decodeURIComponent(name.slice(1)));
  if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.YUANSHU_CHROME_PATH?{executablePath:process.env.YUANSHU_CHROME_PATH}:{})});
  for(const width of [390,1440])for(const scenario of ['approve','cancel','cancel-retry','expired','unknown','lost-response','stale','read-failed','mismatch','switch']) {
    const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
    page.setDefaultTimeout(10000);
    const writes=[],errors=[];let revision=1,policy=defaultPolicy(),approved=false,releaseProof,markProofRequested,dialogs=0,submitted=false,recheck=false;
    const proofGate=new Promise(resolve=>releaseProof=resolve);
    const proofStarted=new Promise(resolve=>markProofRequested=resolve);
    const design={id:'actual-design',parentId:null,author:{actorId:'fixture-mother'},design:{...draft(),name:'测试设计'}};
    page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',async dialog=>{
      assert.ok(dialog.message().includes('fixture-model'));
      assert.ok(dialog.message().includes('不开放电脑'));
      dialogs++;
      if(scenario==='cancel'||scenario==='cancel-retry'&&dialogs===1)await dialog.dismiss();else await dialog.accept();
    });
    await page.routeWebSocket('**/*',ws=>ws.close());
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),p=url.pathname;
      if(url.origin!==origin)return route.abort();
      if(!p.startsWith('/api/'))return route.continue();
      if(req.method()!=='GET') {
        const body=req.postDataJSON();writes.push({path:p,body});
        if(p==='/api/cultivation/grants/session/challenge') {
          assert.equal(body.sessionId,'fixture');assert.equal(body.path,'/policy');
          return route.fulfill({json:{id:'one-time',sessionId:'fixture',commandHash:'a'.repeat(64),expiresAt:Date.now()+60000}});
        }
        if(p==='/api/agent/confirm') {
          assert.equal(body.sessionId,'fixture');assert.equal(body.id,'one-time');
          approved=body.ok;
          return route.fulfill({json:{ok:scenario!=='expired'}});
        }
        if(p==='/api/cultivation/grants/session/confirm') {
          assert.equal(approved,true);markProofRequested();
          if(scenario==='switch')await proofGate;
          return route.fulfill({json:{id:'one-time',sessionId:'fixture',token:'fixture-proof',expiresAt:Date.now()+60000}});
        }
        if(p==='/api/cultivation/policy') {
          submitted=true;
          assert.equal(approved,true);assert.equal(req.headers()['x-cultivation-session-id'],'fixture');
          assert.equal(JSON.parse(req.headers()['x-cultivation-session-proof']).token,'fixture-proof');
          assert.equal(body.expectedRevision,1);
          const next=body.payload.policy;
          assert.deepEqual(next.models,['fixture-model']);assert.deepEqual(next.tools,[]);
          assert.equal(next.dailyRequests,1);assert.equal(next.dailyBudgetCents,50);
          assert.equal(next.allowRemote,true);assert.equal(next.motherLearning,false);assert.equal(next.recursive,false);
          if(scenario==='unknown')return route.abort('failed');
          policy=scenario==='mismatch'?{...next,enabled:false}:next;revision++;
          if(scenario==='lost-response')return route.abort('failed');
          return route.fulfill({json:{revision,result:{}}});
        }
        throw new Error(`unexpected write: ${p}`);
      }
      if(p==='/api/cultivation/overview'&&submitted&&scenario==='read-failed'&&!recheck)return route.abort('failed');
      const stale=submitted&&scenario==='stale'&&!recheck;
      const json=p==='/api/cultivation/overview'?{revision:stale?1:revision,state:'designs_available',policy:stale?defaultPolicy():policy,designCount:1,agentCount:0,
        motherIdentityAvailable:true,executorAvailable:true,humanGrantAvailable:false,sessionGrantAvailable:true,
        ownerConfirmation:{mode:'windows-hello',state:'unpaired',workspace:'a'.repeat(64)},usage:null,admission:null,taskStatus:null}
        :p==='/api/cultivation/designs'?{items:[design],nextCursor:null,supported:true}
        :p.startsWith('/api/cultivation/')?{items:[],nextCursor:null,supported:true}
        :p==='/api/sessions'?{sessions:[{id:'fixture',name:'当前会话',group:'workspace'},{id:'other',name:'其他会话',group:'workspace'}]}
        :p==='/api/models'?{models:[],cwd:'fixture'}
        :p==='/api/persona'?{definition:{name:'测试角色'},source:'file',problems:[],revision:'r1',history:[]}
        :p==='/api/genome'?{genes:{},proposals:[],snapshots:[],reviews:[]}
        :p==='/api/time/tasks'?{tasks:[]}
        :p==='/api/run/overview'?{active:[],recent:[],health:{status:'idle',activeCount:0,failedCount:0}}
        :p.endsWith('/messages')?{messages:[],truncated:false}:{};
      return route.fulfill({json});
    });
    await page.addInitScript(()=>{
      localStorage.setItem('yuanshu_access_token','fixture-only');
      localStorage.setItem('pi_last_session','fixture');localStorage.setItem('yuanshu_companion_hidden','true');
    });
    await page.goto(origin+'/#/soul');
    await page.getByRole('heading',{name:'灵魂培养中心',exact:true}).waitFor();
    if(width<640)await page.locator('.soul-mobile-nav select').selectOption('cultivation');
    else await page.getByRole('navigation',{name:'培养分区'}).getByRole('button',{name:/智能体培养/}).click();
    await page.getByRole('button',{name:'授权与资源',exact:true}).click();
    await page.getByLabel('用哪份设计开始').selectOption('actual-design');
    await page.getByLabel('确认记录归属').selectOption('');
    assert.equal(await page.getByRole('button',{name:'核对七天受限培养',exact:true}).isDisabled(),true);
    await page.getByLabel('确认记录归属').selectOption('fixture');
    await page.getByRole('button',{name:'核对七天受限培养',exact:true}).click();
    const area=page.getByRole('region',{name:'人工授权确认'});
    await area.getByRole('button',{name:'本次会话确认并执行',exact:true}).click();
    if(scenario==='approve'||scenario==='lost-response') {
      await area.waitFor({state:'detached'});assert.equal(policy.enabled,true);
    } else if(scenario==='cancel'||scenario==='cancel-retry') {
      await area.getByText('已取消本次培养授权，没有提交。',{exact:true}).waitFor();
      if(scenario==='cancel-retry') {
        await area.getByRole('button',{name:'本次会话确认并执行',exact:true}).click();
        await area.waitFor({state:'detached'});assert.equal(policy.enabled,true);
        assert.equal(dialogs,2);
      }
    }
    else if(scenario==='expired')await area.getByRole('status').filter({hasText:'确认已失效'}).waitFor();
    else if(scenario==='unknown') {
      await area.getByRole('status').filter({hasText:'提交结果尚待核对'}).waitFor();
      assert.equal(await area.getByRole('button',{name:'本次会话确认并执行',exact:true}).isDisabled(),true);
      await area.getByRole('button',{name:'重新核对实际状态',exact:true}).click();
      await area.getByRole('status').filter({hasText:'提交结果尚待核对'}).waitFor();
    } else if(['stale','read-failed','mismatch'].includes(scenario)) {
      await area.getByRole('status').filter({hasText:'提交结果尚待核对'}).waitFor();
      assert.equal(await area.getByRole('button',{name:'本次会话确认并执行',exact:true}).isDisabled(),true);
      recheck=true;
      await area.getByRole('button',{name:'重新核对实际状态',exact:true}).click();
      if(scenario==='mismatch')await area.getByRole('status').filter({hasText:'设置与本次确认不一致'}).waitFor();
      else await area.waitFor({state:'detached'});
    } else {
      await proofStarted;
      await page.getByLabel('确认记录归属').selectOption('other');
      const returned=page.waitForResponse(r=>r.url().endsWith('/api/cultivation/grants/session/confirm'));
      releaseProof();
      await returned;
      await page.getByRole('button',{name:'本次会话确认并执行',exact:true}).waitFor();
    }
    assert.equal(writes.filter(w=>w.path==='/api/cultivation/policy').length,['cancel','expired','switch'].includes(scenario)?0:1);
    const size=await page.locator('.soul-page').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth,doc:document.documentElement.scrollWidth,width:innerWidth}));
    assert.ok(size.scroll<=size.client+1&&size.doc<=size.width+1,JSON.stringify(size));
    if(scenario==='approve')await page.screenshot({path:path.join(root,`tmp/cultivation-session-${width}.png`),fullPage:true});
    if(scenario==='unknown')await area.screenshot({path:path.join(root,`tmp/cultivation-readback-${width}.png`)});
    assert.deepEqual(errors,[]);console.log(`${width}px session ${scenario}: passed`);
    await context.close();
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
