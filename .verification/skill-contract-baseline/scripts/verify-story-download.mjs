import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { createStoryOrchestrator } from '../engine/story-orchestrator.mjs'
const require=createRequire(import.meta.url)
const pw=require(path.join(process.env.APPDATA,'npm/node_modules/camoufox-cli/node_modules/playwright-core'))
const browserRoot=path.join(process.env.LOCALAPPDATA,'ms-playwright')
const executablePath=fs.readdirSync(browserRoot).filter(x=>x.startsWith('chromium-')).reverse().flatMap(x=>['chrome-win64/chrome.exe','chrome-win/chrome.exe'].map(y=>path.join(browserRoot,x,y))).find(x=>fs.existsSync(x))
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-story-ui-'))
console.log('artifacts',artifacts)
const browser=await pw.chromium.launch({headless:true,executablePath})
const token=fs.readFileSync(new URL('../.token',import.meta.url),'utf8').trim()
try {
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,serviceWorkers:'block'})
  await ctx.addInitScript(({token,session})=>{localStorage.setItem('yuanshu_access_token',token);if(session)localStorage.setItem('pi_last_session',session)},{token,session:process.env.YUANSHU_TEST_SESSION})
  const p=await ctx.newPage()
  p.setDefaultTimeout(15000)
  const errors=[]
  p.on('pageerror',e=>errors.push(e.message))
  if(process.env.YUANSHU_TEST_SESSION) {
  await p.goto('http://127.0.0.1:8787/#/chat')
  await p.getByRole('combobox',{name:'消息输入框'}).waitFor()
  console.log('chat ready')
  await p.getByRole('button',{name:/#1 /}).first().waitFor()
  const expand=p.getByRole('button',{name:/展开全部/})
  if(await expand.count()) await expand.click()
  const download=p.getByRole('button',{name:/下载.+\.mp4/}).first()
  if(!await download.count()) {
    const turn=p.getByRole('button',{name:/#1 /}).first()
    if(await turn.count()) await turn.click()
  }
  console.log('video buttons',await p.getByRole('button',{name:/下载/}).allTextContents())
  if(await download.count()) {
    const [file]=await Promise.all([p.waitForEvent('download'),download.first().click()])
    const failure=await file.failure()
    if(failure) throw new Error(failure)
    await file.saveAs(path.join(artifacts,file.suggestedFilename()))
    console.log('real video saved',file.suggestedFilename(),fs.statSync(path.join(artifacts,file.suggestedFilename())).size)
  } else throw new Error('The expected historical video is not visible')
  }
  // UI requests use the real story store/orchestrator with deterministic model adapters in a temporary directory.
  // No real story project or paid generation request is changed by this walkthrough.
  for(const [label,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
    await p.setViewportSize(viewport)
    const root=fs.mkdtempSync(path.join(artifacts,`${label}-store-`))
    let failNext=false
    const adapter={generate:async({prompt})=>{
      if(failNext){failNext=false;throw new Error('测试通道中断')}
      return {status:'succeeded',output:{type:'text',text:prompt.includes('已生成前文')?'她从蓝色信封取出钥匙，走向下一扇门。':'她把钥匙藏进蓝色信封。'}}
    }}
    const backend=createStoryOrchestrator({root,adapters:{novel:adapter,image:adapter,video:adapter},getDefaultModel:()=>({provider:'fixture',id:'story-model'})})
    await p.route('**/api/story/**',async route=>{
      const request=route.request(),url=new URL(request.url()),parts=url.pathname.split('/'),id=parts[4],op=parts[5],body=request.postDataJSON() || {}
      try {
        let data
        if(!id) data=request.method()==='POST'?{project:await backend.create(body)}:{projects:await backend.list()}
        else if(op==='assist') data={assist:{characters:[{name:'阿宁',appearance:'黑短发，左脸有痣'}],wardrobe:[{name:'蓝衣',description:'银扣'}],style:{visual:'胶片'},scene:{title:'雨夜开场',summary:'寻找旧日的钥匙'},beat:{kind:'novel',prompt:body.idea.includes('下一段')?'她带着信封寻找下一扇门':'她推开门，把钥匙藏进蓝色信封'}},model:{provider:'fixture',id:'planner'}}
        else if(op==='run') data=await backend.runGeneration(id,body)
        else if(op==='run-preview') data=await backend.previewRun(id,body)
        else data={project:request.method()==='PATCH'?await backend.patch(id,body):await backend.get(id)}
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)})
      }catch(e){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:e.message})})}
    })
    await p.goto('http://127.0.0.1:8787/#/story')
    await p.reload()
    await p.getByLabel('描述你的故事').fill('阿宁雨夜寻找钥匙，沿着线索慢慢前进')
    await p.screenshot({path:path.join(artifacts,`${label}-start.png`)})
    await p.getByRole('button',{name:'让 AI 搭好开场'}).click()
    await p.getByRole('button',{name:'采用并保存设定'}).click()
    await p.getByText('人物、服装、风格和本段内容已一起保存').waitFor()
    const [created]=await backend.list()
    assert.equal(created.bible.characters[0].appearance,'黑短发，左脸有痣')
    assert.equal(created.bible.wardrobe[0].description,'银扣')
    await p.getByRole('button',{name:'检查生成输入'}).click()
    await p.getByText('以下是实际将使用的设定与要求').waitFor()
    assert.equal((await backend.get(created.id)).scenes[0].outputs.length,0)
    await p.getByRole('button',{name:'生成当前段落'}).click()
    await p.getByText('她把钥匙藏进蓝色信封。',{exact:true}).waitFor()
    await p.getByRole('button',{name:'从此处继续 · AI 构思下一段'}).click()
    await p.getByRole('button',{name:'采用并保存设定'}).click()
    await p.getByText('人物、服装、风格和本段内容已一起保存').waitFor()
    assert.equal(await p.locator('.story-prose').filter({hasText:'她把钥匙藏进蓝色信封。'}).count(),0,'new shot must not display previous output')
    failNext=true
    await p.getByRole('button',{name:'生成当前段落'}).click()
    await p.locator('.story-error').filter({hasText:'测试通道中断'}).waitFor()
    await p.getByRole('button',{name:'生成当前段落'}).click()
    await p.getByText('她从蓝色信封取出钥匙，走向下一扇门。',{exact:true}).waitFor()
    await p.getByLabel('选择输出类型').selectOption('video')
    await p.getByRole('button',{name:'生成当前视频'}).waitFor()
    const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)
    assert.equal(overflow,false,`${label} page must fit viewport`)
    await p.locator('.story-workbench').evaluate(el=>el.scrollTop=0)
    await p.screenshot({path:path.join(artifacts,`${label}-editor.png`)})
    console.log(`${label}: draft/save/preview/generation/failure/retry/continuation/type selection passed; no horizontal overflow`)
    await p.unroute('**/api/story/**')
  }
  console.log('page errors',errors)
  console.log('artifacts',artifacts)
} finally { await browser.close() }
