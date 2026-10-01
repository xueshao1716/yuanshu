// Offline fixture only. Native calls are simulated; no Windows identity is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {baseFixture} from '../helpers/cultivation-observation-browser.mjs';
import {defaultPolicy} from '../../engine/cultivation/policy.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),dist=path.join(root,'tmp/verification-dist');
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(dist,pathname==='/'?'index.html':decodeURIComponent(pathname.slice(1)));
  if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.YUANSHU_CHROME_PATH?{executablePath:process.env.YUANSHU_CHROME_PATH}:{})});
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();
    let paired=false,challengeFailure=false,submitFailure=false,revision=0,policy=defaultPolicy();
    const writes=[],errors=[];page.setDefaultTimeout(10000);
    page.on('pageerror',e=>errors.push(e.message));await page.clock.install();await page.routeWebSocket('**/*',ws=>ws.close());
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),p=url.pathname;
      if(url.origin!==origin)return route.abort();
      if(!p.startsWith('/api/'))return route.continue();
      if(req.method()!=='GET'){
        writes.push(p);
        if(p.endsWith('/grants/challenge'))return route.fulfill(challengeFailure?{status:409,json:{error:'cultivation_revision_conflict'}}:{json:{id:'fixture-challenge',message:'synthetic-only',expiresAt:Date.now()+60000}});
        if(p==='/api/cultivation/policy'){
          assert.equal(JSON.parse(req.headers()['x-cultivation-proof']).signature,'synthetic-ui-proof');
          if(submitFailure)return route.fulfill({status:503,json:{error:'fixture_uncertain'}});
          const body=req.postDataJSON();assert.equal(body.expectedRevision,revision);policy=body.payload.policy;revision++;
          return route.fulfill({json:{revision}});
        }
        return route.fulfill({status:403,json:{error:'unexpected_fixture_write'}});
      }
      if(p==='/api/cultivation/overview')return route.fulfill({json:{...baseFixture(p),revision,policy,
        humanGrantAvailable:paired,ownerConfirmation:{mode:'windows-hello',state:paired?'paired':'unpaired',workspace:'a'.repeat(64)}}});
      return route.fulfill({json:baseFixture(p)});
    });
    await page.addInitScript(()=>{
      localStorage.setItem('yuanshu_access_token','synthetic-token');localStorage.setItem('pi_last_session','fixture');localStorage.setItem('yuanshu_companion_hidden','true');
    });
    const button=name=>page.getByRole('button',{name,exact:true});
    const owner=()=>page.getByRole('region',{name:'主人确认方式'});
    const auth=()=>page.getByRole('region',{name:'人工授权确认'});
    await page.goto(origin+'/#/soul');await page.getByRole('heading',{name:'灵魂培养中心',exact:true}).waitFor();
    if(width<640)await page.locator('.soul-mobile-nav select').selectOption('cultivation');
    else await page.getByRole('navigation',{name:'培养分区'}).getByRole('button',{name:/智能体培养/}).click();
    await button('授权与资源').click();await owner().getByText(/请使用新版 Windows/).waitFor();
    assert.equal(await button('核对七天受限学习').isDisabled(),true);assert.deepEqual(writes,[]);
    await page.evaluate(()=>{
      window.ownerFixture={available:false,paired:false,mode:'cancel',calls:[]};
      window.__TAURI__={core:{invoke:async(command,args)=>{
        const f=window.ownerFixture;f.calls.push({command,args});
        if(command==='owner_confirmation_status')return {available:f.available,paired:f.paired};
        if(command==='owner_confirmation_pair'){if(f.mode==='cancel')throw 'OWNER_CANCELLED';f.paired=true;return;}
        if(command==='owner_confirmation_sign'){
          if(f.mode==='cancel')throw 'OWNER_CANCELLED';if(f.mode==='expired')throw 'OWNER_EXPIRED';
          if(f.mode==='hold')return new Promise(resolve=>{f.release=()=>resolve('synthetic-ui-proof');});
          return 'synthetic-ui-proof';
        }
        throw 'unexpected native command';
      }}};
    });
    // Remount to discover the injected native bridge; all state is synthetic.
    await button('个体与设计').click();await button('授权与资源').click();
    await button('检查本机确认方式').click();await owner().getByText(/Windows Hello 尚不可用/).waitFor();
    assert.equal(await button('设置本人确认').count(),0);
    await page.evaluate(()=>{window.ownerFixture.available=true;});
    await button('检查本机确认方式').click();await button('设置本人确认').click();
    await owner().getByText(/本人验证已取消/).waitFor();assert.deepEqual(writes,[]);
    paired=true;await page.evaluate(()=>{window.ownerFixture.mode='success';});
    await button('设置本人确认').click();await owner().getByText(/本机已配对/).waitFor();
    assert.equal(policy.enabled,false);assert.deepEqual(writes,[]);
    await button('核对七天受限学习').click();await auth().waitFor();
    const reviewed=JSON.parse(await auth().locator('pre').innerText()).payload.policy;
    assert.equal(reviewed.dailyRequests,0);assert.equal(reviewed.dailyBudgetCents,0);assert.equal(reviewed.allowRemote,false);
    assert.deepEqual(reviewed.models,[]);assert.deepEqual(reviewed.tools,[]);assert.equal(reviewed.schedule,null);
    assert.deepEqual(reviewed.dataScopes,['knowledge:approved-cultivation']);assert.equal(reviewed.motherLearning,true);
    challengeFailure=true;await button('本人确认并执行').click();await auth().getByText(/cultivation_revision_conflict/).waitFor();
    assert.equal(await page.evaluate(()=>window.ownerFixture.calls.filter(c=>c.command==='owner_confirmation_sign').length),0);
    challengeFailure=false;await page.evaluate(()=>{window.ownerFixture.mode='cancel';});
    await button('本人确认并执行').click();await auth().getByText(/本人验证已取消/).waitFor();
    await page.evaluate(()=>{window.ownerFixture.mode='expired';});await button('本人确认并执行').click();await auth().getByText(/请求已过期/).waitFor();
    assert.equal(writes.filter(p=>p.endsWith('/policy')).length,0);
    const initial=writes.length;await page.evaluate(()=>{window.ownerFixture.mode='hold';});
    await button('本人确认并执行').evaluate(el=>{el.click();el.click();});
    await page.waitForFunction(()=>typeof window.ownerFixture.release==='function');
    assert.equal(writes.length,initial+1);assert.equal(await button('正在等待本人确认…').isDisabled(),true);
    submitFailure=true;await page.evaluate(()=>window.ownerFixture.release());await auth().getByText(/提交结果尚待核对/).waitFor();
    assert.equal(await button('本人确认并执行').isDisabled(),true);
    await button('关闭并核对记录').click();await button('刷新记录').click();
    submitFailure=false;await page.evaluate(()=>{window.ownerFixture.mode='success';});
    await button('核对七天受限学习').click();await button('本人确认并执行').click();await auth().waitFor({state:'detached'});
    assert.equal(policy.enabled,true);assert.equal(policy.motherLearning,true);assert.equal(revision,1);
    await button('暂停全部培养与学习').click();await auth().waitFor();
    assert.equal(JSON.parse(await auth().locator('pre').innerText()).payload.policy.motherLearning,false);
    const fit=await page.locator('.soul-page').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth,doc:document.documentElement.scrollWidth,width:innerWidth}));
    assert.ok(fit.scroll<=fit.client+1&&fit.doc<=fit.width+1,JSON.stringify(fit));
    await page.screenshot({path:path.join(root,`tmp/cultivation-owner-${width}.png`),fullPage:true});
    await button('返回，不操作').click();assert.equal(revision,1);assert.deepEqual(errors,[]);
    console.log(`${width}px: browser/no Hello, cancelled pair, pairing alone, challenge failure, cancelled/expired sign, double click, uncertain submit, read-back and pause scope passed; no real identity or API used`);
    await context.close();
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
