import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { voiceRuntimeFixture } from '../../helpers/voice-runtime-fixture.mjs'
import { createVoiceTaskRuntime } from '../../../engine/voice-task-runtime.mjs'
import { createVoiceTaskApi } from '../../../engine/voice-task-api.mjs'
import { createVoiceTaskAuthorizer } from '../../../engine/voice-task-auth.mjs'
import { createVoiceAdmission } from '../../../engine/chat-voice-admission.mjs'
import { createVoiceTicketHandler } from '../../../engine/chat-voice-api.mjs'
import { attachChatVoice } from '../../../engine/chat-voice-bridge.mjs'
import { canAccessSessionOrigin } from '../../../engine/session-manager.mjs'
import { json, readBody } from '../../../engine/http-utils.mjs'
import { createSessionBus } from '../../../engine/session-bus.mjs'
import { extractMessages, resolveLeafId } from '../../../engine/session-utils.mjs'

// Real transport, PCM processing, durable runtime and session files; only the
// paid speech provider and execution model are replaced with isolated adapters.
export async function startChatVoiceFixture(t, { shell = false } = {}) {
  const cleanups = []
  const bus = createSessionBus({ json })
  const f = voiceRuntimeFixture({ after: fn => cleanups.push(fn) }, createVoiceTaskRuntime)
  const runtime = f.make({ notify: sessionId => bus.busPush(sessionId, 'session_updated', { sessionId }) })
  let server, bridge
  t.after(async()=>{
    runtime.close(); bridge?.close(); await server?.close()
    // Stop HTTP polling before releasing the runtime and deleting its files.
    for (const cleanup of cleanups.reverse()) await cleanup()
  })
  const providers = [], origins = [], readSession = id => canAccessSessionOrigin(id) ? [{role:'user',content:'隔离测试聊天'}] : null
  const admission = createVoiceAdmission({getToken:()=> 'fixture-only',readSession})
  const ticket = createVoiceTicketHandler({admission,origins})
  const api = createVoiceTaskApi({runtime,authorize:createVoiceTaskAuthorizer({getToken:()=> 'fixture-only',origins}),readBody,json})
  const connect = () => {
    const p = new EventEmitter(); p.readyState=1; p.bufferedAmount=0; p.sent=[]; p.audioBytes=0
    p.event = e => p.emit('message',Buffer.from(JSON.stringify(e)))
    p.send = raw => {
      const e=JSON.parse(raw); p.sent.push(e)
      if(e.type==='session.update') queueMicrotask(()=>p.event({type:'session.updated'}))
      if(e.type==='input_audio_buffer.append') {
        p.audioBytes+=Buffer.from(e.audio,'base64').length
        if(!p.transcribed) {
          p.transcribed=true
          p.event({type:'conversation.item.input_audio_transcription.completed',transcript:'帮我生成一份通话任务测试报告'})
          p.event({type:'response.created',response:{id:'fixture-audio'}})
          p.event({type:'response.audio.delta',response_id:'fixture-audio',item_id:'audio1',delta:Buffer.alloc(4800).toString('base64')})
          p.event({type:'response.done',response:{id:'fixture-audio'}})
        }
      }
      if(e.type==='response.create') queueMicrotask(()=>{
        p.event({type:'response.created',response:{id:'reply-'+p.sent.length}})
        p.event({type:'response.done',response:{id:'reply-'+p.sent.length}})
      })
    }
    p.terminate=()=>{p.dead=true}; providers.push(p); queueMicrotask(()=>p.emit('open')); return p
  }
  const root=fileURLToPath(new URL('../../../',import.meta.url)), frontend=root+'frontend/'
  const dist=path.resolve(root,process.env.YUANSHU_VOICE_DIST||'tmp/verification-dist')
  const require=createRequire(new URL('../../../frontend/package.json',import.meta.url))
  const {createServer}=await import(pathToFileURL(require.resolve('vite')).href)
  const entry=(shell ? frontend+'src/main.tsx' : fileURLToPath(new URL('./chat-voice-ui.tsx',import.meta.url))).replaceAll('\\','/')
  const previous=process.cwd(); process.chdir(frontend)
  try { server=await createServer({root:frontend,configFile:frontend+'vite.config.ts',logLevel:'error',
    server:{host:'127.0.0.1',port:0,strictPort:false,open:false,fs:{allow:[root]}},
    plugins:[{name:'isolated-chat-voice',configResolved(config){config.server.proxy={};config.server.hmr=false},configureServer(vite){
      vite.middlewares.use(async(req,res,next)=>{
        const url=new URL(req.url,'http://localhost')
        if(url.pathname==='/api/voice/ticket') return ticket(req,res)
        if(url.pathname==='/api/voice/tasks') return req.method==='GET'?api.list(res,req,url):api.submit(res,req)
        const stop=url.pathname.match(/^\/api\/voice\/tasks\/([^/]+)\/stop$/)
        if(stop) return api.stop(res,req,stop[1])
        if(url.pathname==='/api/test/session') return json(res,200,{id:f.id})
        if(url.pathname==='/api/test/messages') return json(res,200,{messages:f.rows().filter(r=>r.message?.voiceDeliveryId).map(r=>r.message)})
        if(url.pathname===`/api/sessions/${f.id}/stream`) return bus.handleSessionStream(res,req,url,f.id)
        if(url.pathname===`/api/sessions/${f.id}/messages`) {
          const entries=f.rows()
          return json(res,200,{messages:extractMessages(entries,resolveLeafId(entries)),truncated:false})
        }
        if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/static/')) return json(res,404,{error:'fixture_only'})
        if(shell && (url.pathname==='/__voice'||url.pathname.startsWith('/assets/'))) {
          const file=path.resolve(dist,url.pathname==='/__voice'?'index.html':url.pathname.slice(1))
          if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)) return json(res,404,{error:'build_fixture_first'})
          res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream')
          return res.end(fs.readFileSync(file))
        }
        if(url.pathname!=='/__voice') return next()
        const html=await vite.transformIndexHtml(url.pathname,'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/'+entry+'"></script></body></html>')
        res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html)
      })
    }}]}) } finally {process.chdir(previous)}
  await server.listen(); const origin='http://127.0.0.1:'+server.httpServer.address().port;origins.push(origin)
  bridge=attachChatVoice({server:server.httpServer,admission,readSession,origins,connect,runtime,canAccess:canAccessSessionOrigin})
  runtime.start()
  return {...f, runtime, server, origin, providers, bus}
}
