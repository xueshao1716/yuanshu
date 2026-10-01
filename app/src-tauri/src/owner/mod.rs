mod protocol;
#[cfg(windows)] mod storage;
#[cfg(windows)] mod windows;
use serde_json::{json,Value};
use std::sync::atomic::{AtomicBool,Ordering};
static BUSY:AtomicBool=AtomicBool::new(false);
struct Guard;
impl Drop for Guard{fn drop(&mut self){BUSY.store(false,Ordering::Release);}}
fn begin()->Result<Guard,String>{if BUSY.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){Err("OWNER_BUSY".into())}else{Ok(Guard)}}
fn check(window:&tauri::WebviewWindow,workspace:&str)->Result<(),String>{
    let url=window.url().map_err(|_|"OWNER_ORIGIN")?;
    if !protocol::workspace_valid(workspace)||!protocol::allowed_origin(window.label(),url.as_str()){return Err("OWNER_ORIGIN".into())}Ok(())
}
pub fn now()->u64{std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d|d.as_millis() as u64).unwrap_or(0)}
#[tauri::command]
pub async fn owner_confirmation_status(window:tauri::WebviewWindow,workspace:String)->Result<Value,String>{
    check(&window,&workspace)?;
    #[cfg(windows)] return tauri::async_runtime::spawn_blocking(move||{
        let credential=storage::read(&storage::file(&workspace,false)?)?;
        if let Some(ref row)=credential{protocol::credential_id(row,&workspace)?;}
        Ok(json!({"available":windows::available(),"paired":credential.is_some()}))
    }).await.map_err(|_|"OWNER_STORAGE".to_string())?;
    #[cfg(not(windows))] Ok(json!({"available":false,"paired":false}))
}
#[tauri::command]
pub async fn owner_confirmation_pair(window:tauri::WebviewWindow,workspace:String)->Result<(),String>{
    check(&window,&workspace)?;let guard=begin()?;
    #[cfg(windows)] {
        let hwnd=window.hwnd().map_err(|_|"OWNER_ORIGIN")?.0 as isize;
        return tauri::async_runtime::spawn_blocking(move||{let _guard=guard;
            if storage::read(&storage::file(&workspace,false)?)?.is_some(){return Err("OWNER_EXISTS".into())}
            let row=windows::pair(hwnd,&workspace)?;
            protocol::credential_id(&row,&workspace)?;
            storage::write_new(&storage::file(&workspace,true)?,&row)
        }).await.map_err(|_|"OWNER_STORAGE".to_string())?;
    }
    #[cfg(not(windows))] {let _guard=guard;Err("HELLO_UNAVAILABLE".into())}
}
#[tauri::command]
pub async fn owner_confirmation_sign(window:tauri::WebviewWindow,workspace:String,request:Value)->Result<String,String>{
    check(&window,&workspace)?;protocol::review(&workspace,&request,now())?;let guard=begin()?;
    #[cfg(windows)] {
        let hwnd=window.hwnd().map_err(|_|"OWNER_ORIGIN")?.0 as isize;
        return tauri::async_runtime::spawn_blocking(move||{let _guard=guard;
            let row=storage::read(&storage::file(&workspace,false)?)?.ok_or("OWNER_STORAGE")?;
            let credential=protocol::credential_id(&row,&workspace)?;
            let signed=windows::sign(hwnd,&workspace,&request,credential)?;
            protocol::review(&workspace,&request,now())?;
            if storage::read(&storage::file(&workspace,false)?)?.as_ref()!=Some(&row){return Err("OWNER_STORAGE".into())}Ok(signed)
        }).await.map_err(|_|"OWNER_STORAGE".to_string())?;
    }
    #[cfg(not(windows))] {let _guard=guard;Err("HELLO_UNAVAILABLE".into())}
}
#[cfg(test)] mod tests{
    use super::*;
    #[test] fn single_operation_and_release_on_cancel(){let a=begin().unwrap();assert!(begin().is_err());drop(a);assert!(begin().is_ok());}
}
