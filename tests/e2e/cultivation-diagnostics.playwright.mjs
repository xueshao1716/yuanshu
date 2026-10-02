// Isolated UI fixture: no production APIs, credentials, authorization or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {draft} from '../helpers/cultivation-fixture.mjs';
import {defaultPolicy} from '../../engine/cultivation/policy.mjs';
import {knowledgeFixture} from './knowledge-fixture.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),dist=path.join(root,'tmp/verification-dist');
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(dist,pathname==='/'?'index.html':decodeURIComponent(pathname.slice(1)));
  if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.YUANSHU_CHROME_PATH?{executablePath:process.env.YUANSHU_CHROME_PATH}:{})});
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
    page.setDefaultTimeout(10000);
    const counts=new Map(),writes=[],errors=[];let revision=1,failCheck=false;
    const shared=knowledgeFixture();shared.failModels=false;
    shared.policy={...shared.policy,model:'fixture/text',allowedModels:['fixture/text','fixture/cultivation'],
      rates:{'fixture/text':{input:1,output:2,currency:'USD'},'fixture/cultivation':{input:3,output:4,currency:'USD'}}};
    const design={id:'fixture-design',parentId:null,author:{actorId:'隔离测试小语'},design:{...draft(),name:'隔离设计'}};
    await page.routeWebSocket('**/*',ws=>ws.close());
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),p=url.pathname;
      if(url.origin!==origin)return route.abort();
      if(!p.startsWith('/api/'))return route.continue();
      counts.set(p,(counts.get(p)||0)+1);
      if(p.startsWith('/api/knowledge/'))return shared.respond(route);
      if(req.method()!=='GET'){writes.push(p);return route.fulfill({status:405,json:{error:'fixture_readonly'}});}
      if(p==='/api/cultivation/preflight'){
        assert.equal(url.searchParams.get('designId'),'fixture-design');
        if(failCheck)return route.fulfill({status:503,json:{error:'cultivation_state_changing'}});
        const action=url.searchParams.get('action'),designCheck=action==='design.check';
        return route.fulfill({json:{action,revision,ready:false,retryable:false,scope:'configuration_only',
          checkedAt:'2026-10-02T12:00:00.000Z',warnings:[],nextAction:'请核对培养开关，不要重复注册。',
          blockedBy:[{code:'cultivation_policy_disabled',field:'policy.enabled',message:'培养权限未启用',nextAction:'请核对培养开关，不要重复注册。'},
            ...(designCheck?[{code:'cultivation_price_unknown',field:'knowledge.rates',message:'模型价格尚未核对',nextAction:'请核对共享价格。'}]:[])]}});
      }
      const json=p==='/api/cultivation/overview'?{revision,state:'designs_available',policy:defaultPolicy(),designCount:1,agentCount:0,
        motherIdentityAvailable:true,executorAvailable:true,humanGrantAvailable:false,sessionGrantAvailable:false,usage:null,admission:null}
        :p==='/api/cultivation/designs'?{items:[design],nextCursor:null,supported:true}
        :p==='/api/cultivation/models'?{available:true,revision,models:Array.from({length:21},(_,i)=>({key:`fixture/model-${i}`,label:`隔离模型 ${i}`,cultivationAuthorized:false,sharedAuthorized:false,health:'not_checked'}))}
        :p==='/api/cultivation/denials'?{items:[{requestId:'fixture-request',action:'agent.register',error:'cultivation_policy_disabled',count:4,expectedRevision:1,lastAt:'2026-10-02T12:00:00.000Z'}],retained:1,limit:200}
        :p.startsWith('/api/cultivation/')?{items:[],nextCursor:null,supported:true}
        :p==='/api/sessions'?{sessions:[{id:'fixture',name:'测试会话',group:'workspace'}]}
        :p==='/api/models'?{models:[],cwd:'fixture'}
        :p==='/api/persona'?{definition:{name:'测试角色'},source:'file',problems:[],revision:'r1',history:[]}
        :p==='/api/genome'?{genes:{},proposals:[],snapshots:[],reviews:[]}
        :p==='/api/time/tasks'?{tasks:[]}
        :p==='/api/run/overview'?{active:[],recent:[],health:{status:'idle',activeCount:0,failedCount:0}}
        :p.endsWith('/messages')?{messages:[],truncated:false}:{};
      return route.fulfill({json});
    });
    await page.addInitScript(()=>{
      localStorage.setItem('yuanshu_access_token','isolated-diagnostics-test');
      localStorage.setItem('pi_last_session','fixture');localStorage.setItem('yuanshu_companion_hidden','true');
    });
    await page.goto(origin+'/#/soul');
    await page.getByRole('heading',{name:'灵魂培养中心',exact:true}).waitFor();
    if(width<640)await page.locator('.soul-mobile-nav select').selectOption('cultivation');
    else await page.getByRole('navigation',{name:'培养分区'}).getByRole('button',{name:/智能体培养/}).click();
    await page.getByRole('button',{name:'授权与资源',exact:true}).click();
    assert.equal(counts.get('/api/cultivation/models')||0,0);
    assert.equal(counts.get('/api/cultivation/denials')||0,0);
    assert.equal(counts.get('/api/knowledge/policy')||0,0,'shared settings load on demand');
    await page.getByLabel('用哪份设计开始').selectOption('fixture-design');
    const readiness=page.getByRole('region',{name:'设计运行准备检查'});
    await readiness.getByRole('button',{name:'重新检查运行条件'}).click();
    await readiness.getByRole('status').filter({hasText:'运行前还有 2 项待核对'}).waitFor();
    await readiness.getByText(/不调用模型/).waitFor();
    failCheck=true;await readiness.getByRole('button',{name:'重新检查运行条件'}).click();
    await readiness.getByRole('alert').filter({hasText:'检查未完成'}).waitFor();
    assert.equal(await readiness.getByRole('status').count(),0);
    failCheck=false;await readiness.getByRole('button',{name:'重新检查运行条件'}).click();
    await readiness.getByRole('status').filter({hasText:'运行前还有 2 项待核对'}).waitFor();
    await page.locator('summary').filter({hasText:'共享模型与额度设置',exact:true}).click();
    await page.locator('summary').filter({hasText:'授权与用量设置',exact:true}).click();
    await page.getByLabel('核对哪个模型的价格').selectOption('fixture/cultivation');
    await page.getByLabel('输入价格（USD / 百万 token）',{exact:true}).fill('5');
    await page.getByRole('button',{name:'保存授权与限额',exact:true}).click();
    await page.getByRole('status').filter({hasText:'设置已保存'}).waitFor();
    assert.deepEqual(shared.policy.allowedModels,['fixture/text','fixture/cultivation']);
    assert.equal(shared.policy.rates['fixture/cultivation'].input,5);
    assert.equal(shared.policy.model,'fixture/text');
    assert.equal(shared.writes.length,1,'only explicit shared save mutates the fixture');
    const sharedSize=await page.locator('.soul-page').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth,doc:document.documentElement.scrollWidth,width:innerWidth}));
    assert.ok(sharedSize.scroll<=sharedSize.client+1&&sharedSize.doc<=sharedSize.width+1,JSON.stringify(sharedSize));
    await readiness.scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,`tmp/cultivation-readiness-${width}.png`),fullPage:true});
    await page.locator('summary').filter({hasText:'共享模型与额度设置',exact:true}).click();
    await page.locator('summary').filter({hasText:'操作检查与近期拒绝'}).click();
    const checks=page.getByRole('region',{name:'培养操作检查'});
    await checks.getByLabel('设计稿').selectOption('fixture-design');
    await checks.getByRole('button',{name:'重新检查',exact:true}).click();
    await checks.getByRole('status').filter({hasText:'发现 1 项阻碍'}).waitFor();
    await checks.locator('summary').filter({hasText:'模型标识与授权范围'}).click();
    await checks.getByText('fixture/model-0',{exact:true}).waitFor();
    await checks.getByRole('navigation',{name:'模型目录分页'}).getByRole('button',{name:'下一页',exact:true}).click();
    await checks.getByText('fixture/model-20',{exact:true}).waitFor();
    await checks.getByLabel('查找模型').fill('model-20');
    await checks.locator('summary').filter({hasText:'近期被拒操作',exact:true}).click();
    await checks.getByText(/同请求记录 4 次/).waitFor();
    const sizes=await page.locator('.soul-page').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth,doc:document.documentElement.scrollWidth,width:innerWidth}));
    assert.ok(sizes.scroll<=sizes.client+1&&sizes.doc<=sizes.width+1,JSON.stringify(sizes));
    const small=await checks.locator('button,summary,select,input').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().height>0&&n.getBoundingClientRect().height<43).map(n=>n.textContent));
    assert.deepEqual(small,[],'diagnostic controls retain touch target size');
    await checks.scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,`tmp/cultivation-diagnostics-${width}.png`),fullPage:true});
    failCheck=true;await checks.getByRole('button',{name:'重新检查',exact:true}).click();
    await checks.getByRole('alert').filter({hasText:'检查未完成'}).waitFor();
    assert.equal(await checks.getByRole('status').filter({hasText:'发现 1 项阻碍'}).count(),0);
    failCheck=false;await checks.getByRole('button',{name:'重新检查',exact:true}).click();
    await checks.getByRole('status').filter({hasText:'发现 1 项阻碍'}).waitFor();
    revision++;await page.getByRole('button',{name:'刷新记录',exact:true}).click();
    await checks.getByRole('status').filter({hasText:'数据已变化'}).waitFor();
    await readiness.getByRole('status').filter({hasText:'运行前还有'}).waitFor({state:'detached'});
    assert.equal(await checks.getByRole('button',{name:'重新检查',exact:true}).isDisabled(),true);
    await page.clock.install();await page.goto(origin+'/#/chat');await page.waitForTimeout(100);
    const before=[...counts].filter(([p])=>p.startsWith('/api/cultivation/'));
    await page.clock.runFor(95000);await page.waitForTimeout(100);
    for(const [p,n]of before)assert.equal(counts.get(p),n,`hidden diagnostics polling: ${p}`);
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
    console.log(`${width}px diagnostics: blockers, exact model identifiers, pagination, rejection counts, errors, stale results, zero writes, fit and hidden polling passed`);
    await context.close();
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
