// Local fixtures only: no production state, credentials, provider or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {draft,enabledPolicy} from '../helpers/cultivation-fixture.mjs';

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
    const errors=[],writes=[],counts=new Map();let populated=false,revision=1,failOverview=false,motherLearning=false,expired=false;
    const designs=['A','B'].map((n,i)=>({id:`design-${n}`,parentId:null,author:{actorId:'隔离测试小语'},
      design:{...draft(),name:`测试个体 ${n}`,appearance:{description:`测试形象 ${n}`,asset:{id:`asset-${n}`,version:1}}}}));
    const agents=designs.map((d,i)=>({id:`agent-${i}`,mentorId:'fixture-mother',designId:d.id,history:[d.id],status:'ready',cancellation:'confirmed'}));
    const overview=()=>({revision,state:populated?'ready':'waiting_for_design',policy:{...enabledPolicy(),motherLearning,
      ...(expired?{expiresAt:'2000-01-01T00:00:00.000Z'}:{})},
      agentCount:populated?2:0,designCount:populated?2:0,executorAvailable:true,motherIdentityAvailable:true,
      humanGrantAvailable:true,usage:{spent:0,reserved:0,unknown:0,currency:'USD',modelRequests:0},admission:{state:'idle'},taskStatus:{started:true,active:0}});
    await page.clock.install();
    await page.routeWebSocket('**/*',ws=>ws.close());
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url()),p=url.pathname;
      if(url.origin!==origin)return route.abort();
      if(!p.startsWith('/api/'))return route.continue();
      counts.set(p,(counts.get(p)||0)+1);
      if(request.method()!=='GET'){
        writes.push(p);
        if(p==='/api/cultivation/grants/challenge')return route.fulfill({json:{id:'fixture-challenge',message:'fixture-only',expiresAt:Date.now()+30000}});
        return route.fulfill({status:403,json:{error:'fixture_signature_expired'}});
      }
      if(p==='/api/cultivation/overview'&&failOverview)return route.fulfill({status:503,json:{error:'fixture_temporarily_unavailable'}});
      if(p==='/api/cultivation/media'){
        assert.equal(url.searchParams.get('agentId'),'agent-0');assert.equal(url.searchParams.get('id'),'asset-A');
        return route.fulfill({status:409,json:{error:'fixture_asset_revoked'}});
      }
      const index=agents.findIndex(a=>p===`/api/cultivation/agents/${a.id}`);
      const json=p==='/api/cultivation/overview'?overview()
        :p==='/api/cultivation/agents'?{items:populated?agents:[],nextCursor:null,supported:true}
        :p==='/api/cultivation/designs'?{items:populated?designs:[],nextCursor:null,supported:true}
        :p==='/api/cultivation/runs'||p==='/api/cultivation/experience'?{items:[],nextCursor:null,supported:true}
        :index>=0?{agent:agents[index],design:designs[index],revision,initialization:'complete'}
        :p==='/api/sessions'?{sessions:[{id:'fixture',name:'测试会话',group:'workspace'}]}
        :p==='/api/models'?{models:[],cwd:'fixture'}
        :p==='/api/persona'?{definition:{name:'测试角色'},source:'file',problems:[],revision:'r1',history:[]}
        :p==='/api/genome'?{genes:{},proposals:[],snapshots:[],reviews:[]}
        :p==='/api/persona/confirmations'?{items:[],canApprove:false}
        :p==='/api/time/tasks'?{tasks:[]}
        :p==='/api/run/overview'?{active:[],recent:[],health:{status:'idle',activeCount:0,failedCount:0}}
        :p.endsWith('/messages')?{messages:[],truncated:false}:{};
      return route.fulfill({json});
    });
    await page.addInitScript(()=>{
      localStorage.setItem('yuanshu_access_token','isolated-cultivation-test');
      localStorage.setItem('pi_last_session','fixture');localStorage.setItem('yuanshu_companion_hidden','true');
    });
    await page.goto(origin+'/#/soul');
    await page.getByRole('heading',{name:'灵魂培养中心',exact:true}).waitFor();
    const open=async id=>{
      if(width<640)await page.locator('.soul-mobile-nav select').selectOption(id);
      else await page.getByRole('navigation',{name:'培养分区'}).getByRole('button',{name:id==='cultivation'?/智能体培养/:/身份与表达/}).click();
    };
    const tab=name=>page.getByRole('button',{name,exact:true}).click();
    const fit=async()=>{
      const s=await page.locator('.soul-page').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth,doc:document.documentElement.scrollWidth,width:innerWidth}));
      assert.ok(s.scroll<=s.client+1&&s.doc<=s.width+1,JSON.stringify(s));
    };
    await open('cultivation');
    await page.getByText('等待小语提交设计。尚无个体、课程或运行结果。',{exact:true}).waitFor();
    await fit();populated=true;await tab('刷新记录');
    await tab('测试个体 A · 就绪');await page.locator('.cultivation-design:visible dd').filter({hasText:'测试形象 A'}).waitFor();
    assert.equal(counts.get('/api/cultivation/media')||0,0,'media is not fetched without a click');
    await tab('载入图片预览');await page.getByRole('alert').filter({hasText:'fixture_asset_revoked'}).waitFor();
    await tab('测试个体 B · 就绪');await page.locator('.cultivation-design:visible dd').filter({hasText:'测试形象 B'}).waitFor();
    assert.equal(await page.getByRole('alert').filter({hasText:'fixture_asset_revoked'}).count(),0,'asset errors cannot leak between individuals');
    await fit();await page.screenshot({path:path.join(root,`tmp/cultivation-${width}.png`),fullPage:true});
    await tab('授权与资源');
    const motherState=page.locator('.soul-facts > div').filter({has:page.getByText('母体自主采用经验',{exact:true})}).locator('dd');
    assert.equal(await motherState.innerText(),'未授权');
    motherLearning=true;revision++;await tab('刷新记录');await page.getByText('已事先授权',{exact:true}).waitFor();
    expired=true;revision++;await tab('刷新记录');await page.getByText('暂不可用（已过期）',{exact:true}).waitFor();
    expired=false;revision++;await tab('刷新记录');await page.getByText('已事先授权',{exact:true}).waitFor();
    await fit();await page.screenshot({path:path.join(root,`tmp/cultivation-authorization-${width}.png`),fullPage:true});
    await page.getByText('编辑资源与运行时段',{exact:true}).click();
    await page.getByText(/motherLearning 默认关闭/).waitFor();
    await page.getByText(/主人逐条批准的分享不受此开关撤销/).waitFor();
    await page.getByText(/不能因重新开启授权而自动恢复/).waitFor();
    await page.getByRole('alert').filter({hasText:'设置已更新'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'核对并申请签名',exact:true}).isDisabled(),true);
    await tab('重新载入当前设置');
    const settings=page.getByRole('textbox',{name:'授权设置',exact:true});
    await settings.fill('{');await tab('核对并申请签名');
    await page.getByRole('alert').filter({hasText:'设置不是有效的 JSON'}).waitFor();
    await tab('重新载入当前设置');const saved=await settings.inputValue();
    revision++;await tab('刷新记录');await page.getByRole('alert').filter({hasText:'设置已更新'}).waitFor();
    assert.equal(await settings.inputValue(),saved);assert.equal(await page.getByRole('button',{name:'核对并申请签名',exact:true}).isDisabled(),true);
    await tab('重新载入当前设置');await tab('核对并申请签名');await tab('生成授权请求');
    await page.getByRole('textbox',{name:'一次性签名',exact:true}).fill('synthetic-invalid-signature');
    await tab('确认并执行更新培养授权');await page.getByRole('status').filter({hasText:'签名已作废'}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'一次性签名',exact:true}).count(),0);
    await tab('返回，不操作');await fit();
    failOverview=true;await tab('刷新记录');await page.getByText(/fixture_temporarily_unavailable/).first().waitFor();
    failOverview=false;await tab('刷新记录');
    await tab('运行时间线');await page.getByText('还没有运行记录。',{exact:true}).waitFor();
    await tab('学习证据');await fit();await open('identity');
    await page.waitForTimeout(100);
    const before=[...counts].filter(([p])=>p.startsWith('/api/cultivation/'));
    await page.clock.runFor(95000);await page.waitForTimeout(100);
    for(const [p,n]of before)assert.equal(counts.get(p),n,`hidden polling: ${p}`);
    assert.deepEqual(writes,['/api/cultivation/grants/challenge','/api/cultivation/policy']);
    assert.deepEqual(errors,[]);console.log(`${width}px cultivation: empty, media isolation, mother authorization off/on/expired, stale draft, failed signature, errors, unmount polling and fit passed`);
    await context.close();
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
