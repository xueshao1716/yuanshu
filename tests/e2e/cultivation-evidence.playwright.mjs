// Serves only the isolated build. All API responses are synthetic and offline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {baseFixture,evidencePage,experience,observedAt} from '../helpers/cultivation-observation-browser.mjs';

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
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();
    const errors=[],writes=[],external=[],queries=[];
    const items=[experience('run-one',{resolved:true}),experience('run-two',{design:false}),experience('run-invalid',{invalid:true})];
    items[1].role='execution_record';items[1].outcome='failed';items[1].observation.generatedRole='execution_record';
    const unknown=experience('run-page-two');
    unknown.role='execution_record';unknown.outcome='unknown';unknown.observation.generatedRole='execution_record';
    let mode='empty';
    page.setDefaultTimeout(12000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.clock.install();
    await page.routeWebSocket('**/*',ws=>ws.close());
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url()),p=url.pathname;
      if(url.origin!==origin){external.push(url.origin);return route.abort();}
      if(!p.startsWith('/api/'))return route.continue();
      if(request.method()!=='GET'){writes.push(p);return route.fulfill({status:403,json:{error:'no_fixture_writes'}});}
      if(p==='/api/cultivation/experience'){
        queries.push(url.search);
        if(mode==='failure')return route.fulfill({status:503,json:{error:'fixture_evidence_unavailable'}});
        if(mode==='cursor-conflict'&&url.searchParams.has('cursor'))return route.fulfill({status:409,json:{error:'cultivation_cursor_stale'}});
        const json=mode==='empty'?evidencePage([]):mode==='legacy'?{items:items.map(({observation,...item})=>item),nextCursor:null,supported:true}
          :url.searchParams.has('cursor')?evidencePage([unknown]):evidencePage(items,'synthetic-page-two');
        return route.fulfill({json});
      }
      return route.fulfill({json:baseFixture(p)});
    });
    await page.addInitScript(()=>{
      localStorage.setItem('yuanshu_access_token','synthetic-evidence-token');
      localStorage.setItem('pi_last_session','fixture');localStorage.setItem('yuanshu_companion_hidden','true');
    });
    const button=name=>page.getByRole('button',{name,exact:true});
    const summary=()=>page.getByRole('region',{name:'本页证据摘要'});
    const open=async()=>{
      await page.goto(origin+'/#/soul');
      await page.getByRole('heading',{name:'灵魂培养中心',exact:true}).waitFor();
      if(width<640)await page.locator('.soul-mobile-nav select').selectOption('cultivation');
      else await page.getByRole('navigation',{name:'培养分区'}).getByRole('button',{name:/智能体培养/}).click();
      await button('学习证据').click();
    };
    const fit=async()=>{
      const s=await page.locator('.soul-page').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth,doc:document.documentElement.scrollWidth,width:innerWidth}));
      assert.ok(s.scroll<=s.client+1&&s.doc<=s.width+1,JSON.stringify(s));
    };
    const refresh=()=>button('刷新记录').click();
    const populated=async()=>{await page.locator('.cultivation-lineage dd').getByText('run-one',{exact:true}).waitFor();};
    const inspectLayout=async()=>{
      const measured=await page.locator('.cultivation-panel').evaluate(panel=>{
        const css=selector=>{const s=getComputedStyle(panel.querySelector(selector));return {color:s.color,fontSize:s.fontSize,lineHeight:s.lineHeight,columns:s.gridTemplateColumns};};
        return {theme:document.documentElement.dataset.theme,background:getComputedStyle(document.querySelector('.soul-page')).backgroundColor,
          body:css('.cultivation-evidence p'),label:css('.cultivation-lineage dt'),lineage:css('.cultivation-lineage'),
          buttons:[...panel.querySelectorAll('button')].filter(e=>e.getClientRects().length).map(e=>({text:e.textContent,height:e.getBoundingClientRect().height})),
          overflow:[...panel.querySelectorAll('.cultivation-evidence *')].filter(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1).map(e=>e.tagName)};
      });
      assert.deepEqual(measured.overflow,[]);
      assert.ok(measured.buttons.every(button=>button.height>=44));
      fs.writeFileSync(path.join(root,`tmp/cultivation-evidence-layout-${width}.json`),JSON.stringify(measured,null,2));
    };
    await open();await page.getByText(/本页暂无记录/).waitFor();
    assert.deepEqual(await summary().locator('dd').allTextContents(),['0','0','0']);await fit();
    mode='populated';await refresh();await populated();
    assert.deepEqual(await summary().locator('dd').allTextContents(),['3','1','1']);
    const first=page.locator('.cultivation-list > li').first();
    assert.match(await first.locator('.cultivation-evidence').innerText(),/曾退役/);
    assert.match(await first.locator('.cultivation-evidence').innerText(),/母体：曾采用/);
    const failed=page.locator('.cultivation-list > li').nth(1);
    assert.match(await failed.innerText(),/来源角色：执行记录/);
    assert.match(await failed.innerText(),/任务结果：执行失败，原因待核验/);
    assert.match(await failed.innerText(),/执行记录不是已核验知识/);
    await page.getByText(/实际引用不等于验证有效/).waitFor();
    assert.equal(await page.locator('.cultivation-lineage dd').getByText('未记录',{exact:true}).count(),1);
    const invalid=page.locator('.cultivation-list > li').nth(2);
    assert.match(await invalid.innerText(),/关联失效/);
    assert.equal(await invalid.locator('.cultivation-evidence h5').count(),0);
    assert.equal(await first.getByRole('link').getAttribute('href'),`#/apps?knowledge=${encodeURIComponent(items[0].knowledgeJobId)}`);
    await fit();await inspectLayout();await summary().scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,`tmp/cultivation-evidence-${width}.png`),fullPage:true});
    await first.getByText('查看采用记录与处理',{exact:true}).click();
    await first.getByRole('textbox',{name:'处理理由'}).fill('仅检查旧数据保护，不提交。');
    assert.equal(await first.getByRole('button',{name:'核对并采用',exact:true}).isEnabled(),true);
    mode='failure';await refresh();await page.getByRole('status').filter({hasText:'旧数据'}).waitFor();
    const stamp=await page.evaluate(value=>new Date(value).toLocaleString('zh-CN',{hour12:false}),observedAt);
    assert.ok((await page.getByRole('status').filter({hasText:'旧数据'}).innerText()).includes(stamp));
    assert.equal(await summary().count(),0);assert.equal(await page.getByText(/本页暂无记录/).count(),0);
    assert.equal(await first.getByRole('button',{name:'核对并采用',exact:true}).isDisabled(),true);
    await fit();await page.getByRole('status').filter({hasText:'旧数据'}).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,`tmp/cultivation-evidence-stale-${width}.png`),fullPage:true});
    mode='populated';await button('重新读取').click();await summary().waitFor();
    assert.equal(await page.getByRole('status').filter({hasText:'旧数据'}).count(),0);
    assert.equal(await first.getByRole('button',{name:'核对并采用',exact:true}).isEnabled(),true);
    await button('下一页').click();await page.locator('.cultivation-lineage dd').getByText('run-page-two',{exact:true}).waitFor();
    await page.getByText('任务结果：实际结果未知',{exact:true}).waitFor();
    assert.deepEqual(await summary().locator('dd').allTextContents(),['1','0','0']);
    assert.equal(await button('下一页').isDisabled(),true);
    await button('回到第一页').click();await populated();
    mode='cursor-conflict';await page.clock.runFor(3000);await button('下一页').click();
    await page.getByRole('alert').filter({hasText:'cultivation_cursor_stale'}).waitFor();
    await button('重新读取').click();await populated();await summary().waitFor();
    assert.equal(await button('回到第一页').isDisabled(),true);
    mode='legacy';await refresh();await page.getByText(/服务端未提供证据观察字段/).waitFor();
    assert.equal(await summary().count(),0);assert.equal(await page.locator('.cultivation-lineage').count(),0);
    await page.getByText(`个体 ${items[0].agentId}`,{exact:true}).waitFor();await fit();
    mode='failure';await page.reload();await open();
    await page.getByRole('alert').filter({hasText:'fixture_evidence_unavailable'}).waitFor();
    assert.equal(await summary().count(),0);assert.equal(await page.getByText(/本页暂无记录/).count(),0);
    mode='empty';await button('重新读取').click();await page.getByText(/本页暂无记录/).waitFor();
    mode='failure';await refresh();await page.getByRole('status').filter({hasText:'旧数据'}).waitFor();
    assert.equal(await summary().count(),0);assert.equal(await page.getByText(/本页暂无记录/).count(),0);
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
    // Existing index.html requests these fonts. They remain aborted by the route above.
    assert.ok(external.every(host=>host==='https://fonts.loli.net'),JSON.stringify(external));
    assert.ok(queries.some(q=>q.includes('cursor=synthetic-page-two')));
    console.log(`${width}px evidence: lineage, failed/unknown outcomes, latest decisions, invalid/empty/legacy, stale safety, recovery, paging conflict, fit; no writes or page errors`);
    await context.close();
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
