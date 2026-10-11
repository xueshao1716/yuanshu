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
  // 2026-10-11：ownerConfigProvider 支持全平台（win32=LOCALAPPDATA，其余=XDG 配置目录），
  // server 不再按平台关死文件凭据；显式 env（公钥文件/actor）仍优先
  const server = read('server.mjs');
  assert.ok(!server.includes("process.platform!=='win32'||process.env.YUANSHU_CULTIVATION_HUMAN_PUBLIC_KEY_FILE"), '不得再按平台关死 owner 文件凭据');
  assert.ok(server.includes('workspace=>ownerConfigProvider({workspace})'), 'env 显式 human 配置仍优先于文件凭据');
  assert.ok(read('engine/cultivation/owner-config.mjs').includes('XDG_CONFIG_HOME'), 'owner-config 必须支持 Linux/macOS XDG 配置目录');
  assert.ok(read('frontend/src/soul/cultivation/Authorization.tsx').includes("stage==='native'"));
});

test('android webview explains session confirmation without pretending biometric success is a server signature',()=>{
  const owner=read('frontend/src/soul/cultivation/owner.ts');
  const confirmation=read('frontend/src/soul/cultivation/OwnerConfirmation.tsx');
  const authorization=read('frontend/src/soul/cultivation/Authorization.tsx');
  assert.ok(owner.includes('YuanshuBridge'),'detect the Android bridge explicitly');
  assert.ok(confirmation.includes('安卓设备确认'),'show an Android-specific explanation');
  assert.ok(authorization.includes('设备凭据尚未绑定'),'do not offer a fake execute path');
  assert.ok(authorization.includes('本次不是培养策略操作'),'explain why this action needs the existing signature route');
  assert.ok(confirmation.includes('培养策略可直接使用上方会话确认，无需 Windows 配对'),'do not send Android policy approval back to Windows');
});

test('uncertain native submission cannot immediately obtain a second authorization',()=>{
  const source=read('frontend/src/soul/cultivation/Authorization.tsx');
  assert.ok(source.includes('submitted.current'),'remember that submission may have committed');
  assert.ok(source.includes('busy||android||submitted.current||!ownerInvoke()'),'disable repeat submission until refreshed and reopened');
});
