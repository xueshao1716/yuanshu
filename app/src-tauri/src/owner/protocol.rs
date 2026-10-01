use serde_json::Value;
use sha2::{Digest,Sha256};
use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD as B64};
pub const RP: &str="yuanshu.localhost";
pub const ORIGIN: &str="https://yuanshu.localhost";
pub fn workspace_valid(v:&str)->bool { v.len()==64&&v.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)) }
fn exact(v:&Value,keys:&[&str])->bool { v.as_object().is_some_and(|m|m.len()==keys.len()&&keys.iter().all(|k|m.contains_key(*k))) }
fn uuid(v:&Value)->bool {v.as_str().is_some_and(|s|s.len()==36&&s.bytes().enumerate().all(|(i,b)|if [8,13,18,23].contains(&i){b==b'-'}else{b.is_ascii_digit()||(b'a'..=b'f').contains(&b)}))}
pub fn allowed_origin(label: &str, url: &str) -> bool {
    let Ok(url)=tauri::Url::parse(url) else{return false};
    label=="main"&&url.scheme()=="http"&&matches!(url.host_str(),Some("localhost"|"127.0.0.1"))&&url.port()==Some(8787)&&url.username().is_empty()&&url.password().is_none()&&url.path()=="/"
}
// Commands contain bounded integers; rejecting floating point avoids differing
// JS/Rust JSON number renderings. Sort keys by UTF-16 as the service does.
fn canonical(v:&Value)->Result<String,String>{
    Ok(match v {
        Value::Object(map)=>{let mut keys:Vec<_>=map.keys().collect();keys.sort_by_key(|k|k.encode_utf16().collect::<Vec<_>>());
            let rows=keys.into_iter().map(|k|Ok(format!("{}:{}",serde_json::to_string(k).unwrap(),canonical(&map[k])?))).collect::<Result<Vec<_>,String>>()?;format!("{{{}}}",rows.join(","))},
        Value::Array(a)=>format!("[{}]",a.iter().map(canonical).collect::<Result<Vec<_>,_>>()?.join(",")),
        Value::Number(n)=>{let i=n.as_i64().filter(|i|i.unsigned_abs()<=9007199254740991).ok_or("OWNER_INVALID")?;i.to_string()},
        _=>v.to_string()
    })
}
fn mapped(command:&Value)->Result<Value,String>{
    if !exact(command,&["method","path","body"]){return Err("OWNER_INVALID".into())}
    let body=&command["body"];
    if !exact(body,&["requestId","expectedRevision","payload"])||!uuid(&body["requestId"])||body["expectedRevision"].as_u64().is_none()||!body["payload"].is_object(){return Err("OWNER_INVALID".into())}
    let mut payload=body["payload"].clone();
    let method=command["method"].as_str().unwrap_or("");let path=command["path"].as_str().unwrap_or("");
    let action=match (method,path){
        ("PUT","/policy")=>"policy.set".to_string(),("POST","/learning")=>"learning.decide".into(),
        ("POST","/assets/revoke")=>"asset.revoke".into(),("POST","/resources/reconcile")=>"resources.reconcile".into(),
        ("POST",_)=>{let parts:Vec<_>=path.split('/').collect();
            if parts.len()!=4||parts[0]!=""||!uuid(&Value::String(parts[2].into())){return Err("OWNER_INVALID".into())}
            let (prefix,key)=match (parts[1],parts[3]){("agents","pause"|"resume"|"archive"|"rollback")=>("agent","agentId"),("runs","cancel")=>("run","runId"),_=>return Err("OWNER_INVALID".into())};
            if payload.get(key).is_some(){return Err("OWNER_INVALID".into())}payload[key]=Value::String(parts[2].into());format!("{}.{}",prefix,parts[3])},
        _=>return Err("OWNER_INVALID".into())
    };
    Ok(serde_json::json!({"action":action,"requestId":body["requestId"],"expectedRevision":body["expectedRevision"],"payload":payload}))
}
pub fn review(workspace: &str, request: &Value, now: u64) -> Result<Value,String> {
    if !workspace_valid(workspace)||!exact(request,&["id","message","expiresAt","command"])||!uuid(&request["id"]){return Err("OWNER_INVALID".into())}
    let message=request["message"].as_str().filter(|s|s.len()<=4096).ok_or("OWNER_INVALID")?;
    let row:Value=serde_json::from_str(message).map_err(|_|"OWNER_INVALID")?;
    let command=mapped(&request["command"])?;let serialized=canonical(&command)?;
    if serialized.len()>6000||serialized.chars().any(|c|matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')){return Err("OWNER_INVALID".into())}
    if !exact(&row,&["domain","id","workspace","commandHash","at","expiresAt","epoch"])||row["domain"]!="yuanshu-cultivation-human-v1"||row["workspace"]!=workspace||row["id"]!=request["id"]||row["expiresAt"]!=request["expiresAt"]||row["epoch"].as_u64().is_none()||row["commandHash"]!=format!("{:x}",Sha256::digest(serialized.as_bytes())){return Err("OWNER_INVALID".into())}
    let at=row["at"].as_u64().ok_or("OWNER_INVALID")?;let expires=row["expiresAt"].as_u64().ok_or("OWNER_INVALID")?;
    if at>now||expires<=now||expires<=at||expires-at>60000{return Err("OWNER_EXPIRED".into())}Ok(command)
}
pub fn credential_id(row: &Value, workspace: &str) -> Result<Vec<u8>,String> {
    if !workspace_valid(workspace)||!exact(row,&["version","workspace","authenticatorData"])||row["version"]!=1||row["workspace"]!=workspace{return Err("OWNER_INVALID".into())}
    let encoded=row["authenticatorData"].as_str().filter(|s|s.len()<=6000).ok_or("OWNER_INVALID")?;
    let bytes=B64.decode(encoded).map_err(|_|"OWNER_INVALID")?;
    if bytes.len()<55||bytes.len()>4096||bytes[..32]!=Sha256::digest(RP.as_bytes())[..]||bytes[32]&0xc5!=0x45{return Err("OWNER_INVALID".into())}
    let n=u16::from_be_bytes([bytes[53],bytes[54]]) as usize;
    if n==0||n>1024||bytes.len()!=55+n+77{return Err("OWNER_INVALID".into())}
    let cose=&bytes[55+n..];
    // Windows returns the standard ES256 COSE key. Reject unexpected algorithms.
    if cose[..10]!=[0xa5,1,2,3,0x26,0x20,1,0x21,0x58,32]||cose[42..45]!=[0x22,0x58,32]{return Err("OWNER_INVALID".into())}
    Ok(bytes[55..55+n].to_vec())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest,Sha256};
    use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD as B64};
    #[test] fn exact_local_origin_only() {
        assert!(allowed_origin("main","http://127.0.0.1:8787/"));
        assert!(allowed_origin("main","http://localhost:8787/?soul=1"));
        for url in ["http://localhost:8788/","https://localhost:8787/","http://localhost:8787.evil/","http://user@localhost:8787/","http://localhost:8787/workshop/x"] { assert!(!allowed_origin("main",url)); }
        assert!(!allowed_origin("other","http://localhost:8787/"));
    }
    #[test] fn challenge_is_bound_and_expires() {
        let workspace="a".repeat(64);let id="00000000-0000-4000-8000-000000000001";
        let body=json!({"requestId":id,"expectedRevision":0,"payload":{"policy":{"enabled":false}}});
        let command=json!({"action":"policy.set","requestId":id,"expectedRevision":0,"payload":body["payload"]});
        let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&command).unwrap()));
        let row=json!({"domain":"yuanshu-cultivation-human-v1","id":id,"workspace":workspace,"commandHash":hash,"at":1000,"expiresAt":61000,"epoch":0});
        let request=json!({"id":id,"message":row.to_string(),"expiresAt":61000,"command":{"method":"PUT","path":"/policy","body":body}});
        assert_eq!(review(&workspace,&request,2000).unwrap(),command);
        assert!(review(&workspace,&request,61000).is_err());
        assert!(review(&"b".repeat(64),&request,2000).is_err());
        let mut changed=request.clone();changed["command"]["body"]["payload"]["policy"]["enabled"]=json!(true);
        assert!(review(&workspace,&changed,2000).is_err());
        changed=request.clone();changed["command"]["path"]=json!("/designs");assert!(review(&workspace,&changed,2000).is_err());
        changed=request;changed["actor"]=json!("owner");assert!(review(&workspace,&changed,2000).is_err());
    }
    #[test] fn registration_requires_uv_and_matching_workspace() {
        let workspace="a".repeat(64);let mut bytes=Sha256::digest(b"yuanshu.localhost").to_vec();
        bytes.extend([0x45,0,0,0,0]);bytes.extend([0;16]);bytes.extend([0,3,1,2,3]);
        bytes.extend([0xa5,1,2,3,0x26,0x20,1,0x21,0x58,32]);bytes.extend([1;32]);bytes.extend([0x22,0x58,32]);bytes.extend([2;32]);
        let row=json!({"version":1,"workspace":workspace,"authenticatorData":B64.encode(&bytes)});
        assert_eq!(credential_id(&row,&workspace).unwrap(),vec![1,2,3]);
        assert!(credential_id(&row,&"b".repeat(64)).is_err());
        bytes[32]=0x41;let mut bad=row;bad["authenticatorData"]=json!(B64.encode(bytes));assert!(credential_id(&bad,&workspace).is_err());
    }
}
