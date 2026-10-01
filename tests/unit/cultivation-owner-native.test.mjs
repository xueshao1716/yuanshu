import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';
test('desktop owner bridge is restricted and has real platform verification',()=>{
  const bridge=read('app/src-tauri/src/owner/mod.rs'),native=read('app/src-tauri/src/owner/windows.rs');
  for(const name of ['owner_confirmation_status','owner_confirmation_pair','owner_confirmation_sign']){
    assert.ok(bridge.includes(name),name);assert.ok(read('app/src-tauri/build.rs').includes(name));
  }
  for(const term of ['WebAuthNAuthenticatorMakeCredential','WebAuthNAuthenticatorGetAssertion','WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED','WebAuthNCancelCurrentOperation'])assert.ok(native.includes(term),term);
  const cap=JSON.parse(read('app/src-tauri/capabilities/owner-confirmation.json')||'{}');
  assert.deepEqual(cap.platforms,['windows']);assert.equal(cap.local,false);
  assert.deepEqual(cap.windows,['main']);assert.equal(cap.remote.urls.length,2);
  assert.ok(read('app/src-tauri/src/owner/storage.rs').includes('create_new(true)'));
});
test('owner provider never mislabels unsupported platforms or hides challenge errors',()=>{
  assert.ok(read('server.mjs').includes("process.platform!=='win32'"));
  assert.ok(read('frontend/src/soul/cultivation/Authorization.tsx').includes("stage==='native'"));
});

test('uncertain native submission cannot immediately obtain a second authorization',()=>{
  const source=read('frontend/src/soul/cultivation/Authorization.tsx');
  assert.ok(source.includes('submitted.current'),'remember that submission may have committed');
  assert.ok(source.includes('busy||submitted.current||!ownerInvoke()'),'disable repeat submission until refreshed and reopened');
});
