import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWindowsAdapter } from '../../engine/computer-use/windows.mjs';

function fixture(reply='{"ok":true}') {
  const calls=[];
  const spawn=(file,args,opts)=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.emit('close',1);};
    let input='';child.stdin.on('data',x=>input+=x);child.stdin.on('finish',()=>{calls.push({file,args,opts,input});queueMicrotask(()=>{child.stdout.write(reply);child.emit('close',0);});});return child;
  };
  return {adapter:createWindowsAdapter({platform:'win32',spawn}),calls};
}
test('native adapter sends data via stdin, never shell commands or command-line text',async()=>{
  const f=fixture();await f.adapter.act({text:'secret; $(danger)',action:'type'});
  assert.equal(f.calls[0].opts.windowsHide,true);assert.equal(f.calls[0].opts.shell,false);
  assert.ok(!f.calls[0].args.join(' ').includes('secret'));
  assert.equal(JSON.parse(f.calls[0].input).text,'secret; $(danger)');
});
test('unsupported host and native failure fail closed',async()=>{
  assert.equal(createWindowsAdapter({platform:'linux'}).supported,false);
  await assert.rejects(()=>createWindowsAdapter({platform:'linux'}).windows(),/Windows/);
  await assert.rejects(()=>fixture('{"error":"blocked"}').adapter.windows(),/blocked/);
  await assert.rejects(()=>fixture('invalid json').adapter.windows(),/响应/);
});
test('pre-aborted action never spawns a native process',async()=>{
  const f=fixture();await assert.rejects(()=>f.adapter.act({},{signal:AbortSignal.abort()}));assert.equal(f.calls.length,0);
});
