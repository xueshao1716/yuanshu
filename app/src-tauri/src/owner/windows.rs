use super::{now,protocol};
use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD as B64};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{sync::mpsc,thread,time::Duration};
use ::windows::{core::{w,PCWSTR,GUID},Win32::{Foundation::HWND,Networking::WindowsWebServices::*,UI::WindowsAndMessaging::*}};

pub fn available()->bool{unsafe{WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable().map(|v|v.as_bool()).unwrap_or(false)}}
fn error(e: ::windows::core::Error)->String{
    match e.code().0 as u32{0x800704c7|0x80090036|0x800705b4=>"OWNER_CANCELLED",_=>"HELLO_UNAVAILABLE"}.into()
}
// The SDK's timeout is advisory. Explicitly cancel our own request at deadline.
struct Deadline{done:Option<mpsc::Sender<()>>,worker:Option<thread::JoinHandle<()>>}
impl Deadline{fn start(id:GUID,ms:u64)->Self{
    let (tx,rx)=mpsc::channel();let worker=thread::spawn(move||{
        if matches!(rx.recv_timeout(Duration::from_millis(ms)),Err(mpsc::RecvTimeoutError::Timeout)){unsafe{let _=WebAuthNCancelCurrentOperation(&id);}}
    });Self{done:Some(tx),worker:Some(worker)}
}}
impl Drop for Deadline{fn drop(&mut self){if let Some(tx)=self.done.take(){let _=tx.send(());}if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn review_box(hwnd:HWND,text:&str)->Result<(),String>{
    let wide:Vec<u16>=text.encode_utf16().chain(Some(0)).collect();
    // Review is not authorization: only the following WebAuthn UV signature is.
    let result=unsafe{MessageBoxW(Some(hwnd),PCWSTR(wide.as_ptr()),w!("元枢 · 核对本次本人确认"),MB_OKCANCEL|MB_ICONINFORMATION|MB_DEFBUTTON2)};
    if result==IDOK{Ok(())}else{Err("OWNER_CANCELLED".into())}
}
unsafe fn copy(ptr:*const u8,len:u32,max:usize)->Result<Vec<u8>,String>{
    if ptr.is_null()||len==0||len as usize>max{return Err("OWNER_INVALID".into())}
    Ok(unsafe{std::slice::from_raw_parts(ptr,len as usize)}.to_vec())
}
fn client(kind:&str,challenge:&[u8])->Vec<u8>{serde_json::to_vec(&json!({"type":kind,"challenge":B64.encode(challenge),"origin":protocol::ORIGIN,"crossOrigin":false})).unwrap()}
fn client_info(data:&mut [u8])->WEBAUTHN_CLIENT_DATA{WEBAUTHN_CLIENT_DATA{dwVersion:1,cbClientDataJSON:data.len() as u32,pbClientDataJSON:data.as_mut_ptr(),pwszHashAlgId:w!("SHA-256")}}
pub fn pair(handle:isize,workspace:&str)->Result<Value,String>{
    if !available(){return Err("HELLO_UNAVAILABLE".into())}
    let hwnd=HWND(handle as *mut _);
    review_box(hwnd,&format!("为当前 Windows 账户设置元枢本人确认。\n工作区：{workspace}\n\n接下来使用 Windows Hello。不会开启学习，不会修改人格或基因，也不会上传私钥。\n取消不会配对。"))?;
    let mut cancel=unsafe{WebAuthNGetCancellationId()}.map_err(error)?;
    let mut data=client("webauthn.create",format!("{workspace}:{cancel:?}:{}",now()).as_bytes());
    let client=client_info(&mut data);let mut user_id=Sha256::digest(workspace.as_bytes()).to_vec();
    let rp=WEBAUTHN_RP_ENTITY_INFORMATION{dwVersion:1,pwszId:w!("yuanshu.localhost"),pwszName:w!("元枢本人确认"),..Default::default()};
    let user=WEBAUTHN_USER_ENTITY_INFORMATION{dwVersion:1,cbId:user_id.len() as u32,pbId:user_id.as_mut_ptr(),pwszName:w!("Yuanshu owner"),pwszDisplayName:w!("元枢设备主人"),..Default::default()};
    let mut parameter=WEBAUTHN_COSE_CREDENTIAL_PARAMETER{dwVersion:1,pwszCredentialType:w!("public-key"),lAlg:-7};
    let parameters=WEBAUTHN_COSE_CREDENTIAL_PARAMETERS{cCredentialParameters:1,pCredentialParameters:&mut parameter};
    let options=WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS{dwVersion:2,dwTimeoutMilliseconds:60000,dwAuthenticatorAttachment:WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM,
        dwUserVerificationRequirement:WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,dwAttestationConveyancePreference:WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,pCancellationId:&mut cancel,..Default::default()};
    let _deadline=Deadline::start(cancel,60000);
    let ptr=unsafe{WebAuthNAuthenticatorMakeCredential(hwnd,&rp,&user,&parameters,&client,Some(&options))}.map_err(error)?;
    if ptr.is_null(){return Err("OWNER_INVALID".into())}
    let result=unsafe{copy((*ptr).pbAuthenticatorData,(*ptr).cbAuthenticatorData,4096)};
    unsafe{WebAuthNFreeCredentialAttestation(Some(ptr));}
    let row=json!({"version":1,"workspace":workspace,"authenticatorData":B64.encode(result?)});
    protocol::credential_id(&row,workspace)?;Ok(row)
}
pub fn sign(handle:isize,workspace:&str,request:&Value,mut credential:Vec<u8>)->Result<String,String>{
    if !available(){return Err("HELLO_UNAVAILABLE".into())}
    let command=protocol::review(workspace,request,now())?;let hwnd=HWND(handle as *mut _);
    review_box(hwnd,&format!("请核对下面的完整操作；确认后还需要 Windows Hello。\n工作区：{workspace}\n{}\n\n取消不会执行。",serde_json::to_string_pretty(&command).map_err(|_|"OWNER_INVALID")?))?;
    protocol::review(workspace,request,now())?;
    let remaining=request["expiresAt"].as_u64().ok_or("OWNER_INVALID")?.saturating_sub(now());
    if remaining==0{return Err("OWNER_EXPIRED".into())}
    let mut cancel=unsafe{WebAuthNGetCancellationId()}.map_err(error)?;
    let mut data=client("webauthn.get",request["message"].as_str().ok_or("OWNER_INVALID")?.as_bytes());let client=client_info(&mut data);
    let mut cred=WEBAUTHN_CREDENTIAL{dwVersion:1,cbId:credential.len() as u32,pbId:credential.as_mut_ptr(),pwszCredentialType:w!("public-key")};
    let options=WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS{dwVersion:3,dwTimeoutMilliseconds:remaining as u32,CredentialList:WEBAUTHN_CREDENTIALS{cCredentials:1,pCredentials:&mut cred},
        dwAuthenticatorAttachment:WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM,dwUserVerificationRequirement:WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,pCancellationId:&mut cancel,..Default::default()};
    let _deadline=Deadline::start(cancel,remaining);
    let ptr=unsafe{WebAuthNAuthenticatorGetAssertion(hwnd,w!("yuanshu.localhost"),&client,Some(&options))}.map_err(error)?;
    if ptr.is_null(){return Err("OWNER_INVALID".into())}
    let result=(||unsafe{
        let auth=copy((*ptr).pbAuthenticatorData,(*ptr).cbAuthenticatorData,1024)?;
        let signature=copy((*ptr).pbSignature,(*ptr).cbSignature,80)?;
        let id=copy((*ptr).Credential.pbId,(*ptr).Credential.cbId,1024)?;
        if id!=credential||auth.len()!=37||auth[..32]!=Sha256::digest(protocol::RP.as_bytes())[..]||auth[32]&0xc5!=5{return Err("OWNER_INVALID".to_string())}
        Ok(B64.encode(serde_json::to_vec(&json!({"credentialId":B64.encode(id),"authenticatorData":B64.encode(auth),"clientData":B64.encode(&data),"signature":B64.encode(signature)})).map_err(|_|"OWNER_INVALID")?))
    })();
    unsafe{WebAuthNFreeAssertion(ptr);}protocol::review(workspace,request,now())?;result
}
