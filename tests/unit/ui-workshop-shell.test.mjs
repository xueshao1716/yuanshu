import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('canvas bootstrap isolates project/version drafts and refreshes cached AI auth/model',async()=>{
  const source=fs.readFileSync(new URL('../../public/workshop-ui/yuanshu-bootstrap.js',import.meta.url),'utf8');
  const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
  const values=new Map([['yuanshu_access_token','new-token'],['pi_web_token','old-token']]);
  const calls=[];
  const run=search=>{const w={location:{search,origin:'https://local.test'},localStorage:{getItem:k=>values.get(k)},fetch:async(...args)=>{calls.push(args)}};vm.runInNewContext(source,{window:w,URL,URLSearchParams,Headers});return w};
  const first=run(`?project=${a}&version=${b}`),second=run(`?project=${b}&version=${a}`);
  assert.notEqual(first.yuanshuCanvasScope,second.yuanshuCanvasScope);assert.equal(run('').yuanshuCanvasScope,'');
  assert.equal(first.yuanshuCanvasNeedsRestore,true);
  values.set('m3e:doc'+first.yuanshuCanvasScope,'{}');
  assert.equal(run(`?project=${a}&version=${b}`).yuanshuCanvasNeedsRestore,false);
  first.yuanshuWorkshopModel='test/current';
  await first.fetch('/api/workshop-ui/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'cached/old'}),headers:{Authorization:'Bearer old'}});
  assert.equal(JSON.parse(calls[0][1].body).model,'test/current');assert.equal(calls[0][1].headers.get('Authorization'),'Bearer new-token');
  await first.fetch('https://elsewhere.test/api/workshop-ui/v1/chat/completions',{body:'{}'});
  assert.equal(calls[1][1].headers,undefined);
});

test('canvas adapters wait for editor hydration and ignore default/key-order-only changes',()=>{
  const base=new URL('../../public/workshop-ui/',import.meta.url);
  const source=fs.readFileSync(new URL('yuanshu-bootstrap.js',base),'utf8');
  const w={location:{search:'',origin:'https://local.test'},localStorage:{getItem:()=>null},fetch:async()=>{}};
  vm.runInNewContext(source,{window:w,URL,URLSearchParams,Headers});
  assert.equal(typeof w.yuanshuCanvasComparable,'function');
  const normalize=w.yuanshuCanvasComparable;
  assert.equal(normalize('{"title":"A","groups":[]}'),normalize('{"groups":[],"dynamicColor":false,"title":"A"}'));
  assert.notEqual(normalize('{"title":"A"}'),normalize('{"title":"B"}'));
  for(const file of ['yuanshu-shell.js','yuanshu-project.js']) {
    const code=fs.readFileSync(new URL(file,base),'utf8');
    assert.ok(code.includes("window.addEventListener('yuanshu-canvas-ready', init, {once:true})"));
  }
  assert.ok(fs.readFileSync(new URL('_next/static/chunks/042i1k4w8mtp9.js',base),'utf8').includes('window.yuanshuCanvasReady=true'));
});

test('save moves the canvas to its new version and restores the old version draft',async()=>{
  const source=fs.readFileSync(new URL('../../public/workshop-ui/yuanshu-project.js',import.meta.url),'utf8');
  const old={groups:[{id:'old'}]},edited={groups:[{id:'edited'}]},values=new Map([['m3e:doc:p:v1',JSON.stringify(edited)]]);
  const elements={},nodes=()=>({setAttribute(){},disabled:false});let navigated;
  const document={createElement:nodes,getElementById:id=>elements[id],documentElement:{classList:{add(){}}}};
  const ctx={window:{yuanshuCanvasReady:true,yuanshuCanvasScope:':p:v1',yuanshuCanvasComparable:t=>t,addEventListener(){}},document,
    location:{search:'?project=p&version=v1',href:'https://local.test/editor?project=p&version=v1',replace:url=>{navigated=String(url)}},
    localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},sessionStorage:{setItem(){}},
    URL,URLSearchParams,AbortSignal,MutationObserver:class {observe(){}},
    fetch:async(url,options)=>({ok:true,json:async()=>options.method==='GET'?{versions:[{id:'v1',doc:old}]}:{id:'v2',doc:edited}})};
  const created=[];document.createElement=()=>{const node=nodes();created.push(node);return node};
  vm.runInNewContext(source,ctx);await new Promise(resolve=>setImmediate(resolve));
  await created.find(node=>node.id==='yuanshu-save').onclick();
  assert.equal(values.get('m3e:doc:p:v1'),JSON.stringify(old));
  assert.equal(values.get('m3e:doc:p:v2'),JSON.stringify(edited));
  assert.equal(new URL(navigated).searchParams.get('version'),'v2');
});
