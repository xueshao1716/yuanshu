import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './fixtures/composer-gallery-server.mjs';

for(const width of [1440,390]) test(`computer controls: scoped grant, rejection and stop at ${width}px`,async t=>{
  const {page,errors}=await setup(t,width);
  let enabled=false, pending=[], stale=false;const writes=[];
  const window={id:'window-one',title:'隔离验收 · 记事本',process:'notepad'};
  await page.route('**/api/computer/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p.endsWith('/windows'))return route.fulfill({json:{windows:[window]}});
    if(p.endsWith('/grant')){
      writes.push(route.request().postDataJSON());enabled=true;
      pending=[{id:'confirm-one',sessionId:'isolated',reason:'替换隔离测试文字，不操作真实桌面'}];
    }
    if(p.endsWith('/stop')){enabled=false;pending=[];}
    return route.fulfill({json:{supported:true,enabled,busy:false,grant:enabled?{sessionId:'isolated',window,expiresAt:Date.now()+600000}:null,pending}});
  });
  await page.route('**/api/agent/confirm',route=>{
    assert.equal(route.request().postDataJSON().ok,false);pending=[];
    return route.fulfill({json:stale?{ok:false,error:'确认不存在或已过期'}:{ok:true,outcome:'rejected'}});
  });
  await page.goto(new URL('/#/system',page.url()).href);
  const panel=page.locator('[data-slot="computer-use"]');
  await panel.getByText('未授权 · 默认关闭',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'选择会话与窗口',exact:true}).click();
  const grant=panel.getByRole('button',{name:'授权本次桌面操作 10 分钟'});
  assert.equal(await grant.isEnabled(),false);
  await panel.getByLabel('操作会话',{exact:true}).selectOption('isolated');
  await panel.getByLabel('目标窗口',{exact:true}).selectOption('window-one');
  await grant.click();await panel.getByText('本次桌面授权已开',{exact:true}).waitFor();
  assert.deepEqual(writes,[{windowId:'window-one',sessionId:'isolated'}]);
  stale=true;
  await panel.getByRole('button',{name:'拒绝本次',exact:true}).click();
  await panel.getByRole('alert').filter({hasText:'确认不存在或已过期'}).waitFor();
  await panel.getByRole('button',{name:'立即停止',exact:true}).click();
  await panel.getByText('未授权 · 默认关闭',{exact:true}).waitFor();
  await panel.scrollIntoViewIfNeeded();
  const size=await panel.evaluate(el=>({w:el.clientWidth,scroll:el.scrollWidth,doc:document.documentElement.scrollWidth,viewport:innerWidth}));
  assert.ok(size.scroll<=size.w+1 && size.doc<=size.viewport+1,JSON.stringify(size));
  await page.screenshot({path:`tmp/computer-use-${width}.png`});
  assert.deepEqual(errors,[]);
});
