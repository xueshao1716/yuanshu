// Isolated fixtures only: refresh must never perform a write or a paid probe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

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
const items=Array.from({length:7},(_,i)=>({id:i+1,at:'2026-10-02T15:00:00.000Z',
  kind:['image','video','tts'][i%3],phase:['generate','poll','reply_stream'][i%3],
  provider:'fixture-provider',model:i===0?'long-model-'+('x'.repeat(100)):'fixture-model',
  status:[403,429,null][i%3],code:['access_denied','rate_limited','timeout'][i%3],
  message:['上游拒绝访问，请检查账号分组和模型权限。','上游限流，请稍后再试并核对通道额度。','请求超时，结果尚不确定；请先查询原任务，避免重复提交。'][i%3]}));
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.YUANSHU_CHROME_PATH?{executablePath:process.env.YUANSHU_CHROME_PATH}:{})});
  for(const width of [390,1440])for(const scenario of ['empty','records','read-error']) {
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();
    page.setDefaultTimeout(10000);
    const writes=[],errors=[];let reads=0,fail=scenario==='read-error';
    page.on('pageerror',error=>errors.push(error.message));
    await page.routeWebSocket('**/*',ws=>ws.close());
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),p=url.pathname;
      if(url.origin!==origin)return route.abort();
      if(!p.startsWith('/api/'))return route.continue();
      if(req.method()!=='GET'){writes.push(p);return route.fulfill({status:400,json:{error:'unexpected write'}});}
      if(p==='/api/models/media-observations') {
        reads++;
        if(fail)return route.fulfill({status:503,json:{error:'fixture unavailable'}});
        return route.fulfill({json:{scope:'process',startedAt:'2026-10-02T14:00:00Z',maxItems:80,retentionHours:24,items:scenario==='empty'?[]:items}});
      }
      return route.fulfill({json:p==='/api/models'?{models:[],current:null,cwd:'fixture'}
        :p==='/api/models/manage'?{providers:[]}:p==='/api/sessions'?{sessions:[]}
        :p==='/api/run/overview'?{active:[],recent:[]}:p==='/api/stats/providers'?{providers:[]}: {}});
    });
    await page.addInitScript(()=>{
      localStorage.setItem('yuanshu_access_token','fixture-only');
      localStorage.setItem('yuanshu_companion_hidden','true');
    });
    await page.goto(origin+'/#models');
    const area=page.getByRole('region',{name:'近期实际调用失败',exact:true});
    await area.waitFor();
    if(scenario==='read-error') {
      await area.getByRole('alert').waitFor();fail=false;
      await area.getByRole('button',{name:'重试读取',exact:true}).click();
    }
    if(scenario==='empty')await area.getByText('当前保留范围内暂无失败记录。',{exact:true}).waitFor();
    else {
      await area.locator('li').first().waitFor();assert.equal(await area.locator('li').count(),5);
      await area.getByRole('button',{name:'查看其余 2 条',exact:true}).click();
      assert.equal(await area.locator('li').count(),7);
      await area.getByRole('button',{name:'收起记录',exact:true}).click();
      assert.equal(await area.locator('li').count(),5);
      fail=true;await area.getByRole('button',{name:'刷新记录',exact:true}).click();
      await area.getByRole('alert').filter({hasText:'可能已过时'}).waitFor();
      assert.equal(await area.locator('li').count(),5);
      fail=false;await area.getByRole('button',{name:'重试读取',exact:true}).click();
      await area.getByRole('button',{name:'刷新记录',exact:true}).waitFor();
    }
    const before=reads;
    await area.getByRole('button',{name:'刷新记录',exact:true}).click();
    await area.getByRole('button',{name:'刷新记录',exact:true}).waitFor();
    assert.equal(reads,before+1);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
    const size=await area.evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth,doc:document.documentElement.scrollWidth,width:innerWidth,
      buttons:[...e.querySelectorAll('button')].map(b=>({w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height}))}));
    assert.ok(size.scroll<=size.client+1&&size.doc<=size.width+1,JSON.stringify(size));
    for(const b of size.buttons)assert.ok(b.w>=44&&b.h>=44,JSON.stringify(b));
    if(scenario!=='read-error')await area.screenshot({path:path.join(root,`tmp/media-observations-${scenario}-${width}.png`)});
    console.log(`${width}px media ${scenario}: passed (${reads} reads, zero writes)`);
    await context.close();
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
