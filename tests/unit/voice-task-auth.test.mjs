import test from 'node:test'
import assert from 'node:assert/strict'
const mod = await import('../../engine/voice-task-auth.mjs').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {} })
test('task HTTP authorization requires bearer, trusted mutation origin, and rejects query fallback', () => {
  assert.equal(typeof mod.createVoiceTaskAuthorizer,'function')
  const authorize=mod.createVoiceTaskAuthorizer({getToken:()=> 'secret', origins:['https://chat.test']})
  const req=(method,headers)=>({method,headers,url:'/api/voice/tasks?token=secret'})
  assert.equal(authorize(req('GET',{})),false)
  assert.equal(authorize(req('GET',{authorization:'Bearer wrong'})),false)
  assert.equal(authorize(req('GET',{authorization:'Bearer secret'})),true)
  assert.equal(authorize(req('GET',{authorization:'Bearer secret',origin:'https://evil.test'})),false)
  assert.equal(authorize(req('POST',{authorization:'Bearer secret'})),false)
  assert.equal(authorize(req('POST',{authorization:'Bearer secret',origin:'https://chat.test'})),true)
  assert.equal(authorize(req('POST',{authorization:'Bearer secret',origin:'null'})),false)
})
