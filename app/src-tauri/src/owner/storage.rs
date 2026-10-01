use std::path::{Path,PathBuf};
use serde_json::Value;
use std::io::{Read,Write};
fn safe(path:&Path,is_dir:bool)->Result<(),String>{
    let m=std::fs::symlink_metadata(path).map_err(|_|"OWNER_STORAGE")?;
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt;if m.file_attributes()&0x400!=0{return Err("OWNER_STORAGE".into())}}
    if m.file_type().is_symlink()||m.is_dir()!=is_dir||(!is_dir&&(!m.is_file()||m.len()>10000)){return Err("OWNER_STORAGE".into())}Ok(())
}
pub fn file_at(root: &Path,workspace: &str,create: bool)->Result<PathBuf,String>{
    if !root.is_absolute()||workspace.len()!=64||!workspace.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("OWNER_INVALID".into())}
    for ancestor in root.ancestors(){safe(ancestor,true)?;}
    let mut dir=root.to_path_buf();
    for part in ["Yuanshu","owner-confirmation"]{
        dir.push(part);
        match std::fs::symlink_metadata(&dir){
            Ok(_)=>safe(&dir,true)?,
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>if create {std::fs::create_dir(&dir).map_err(|_|"OWNER_STORAGE")?;safe(&dir,true)?;},
            Err(_)=>return Err("OWNER_STORAGE".into())
        }
    }
    let file=dir.join(format!("{workspace}.json"));
    match std::fs::symlink_metadata(&file){Ok(_)=>safe(&file,false)?,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>(),Err(_)=>return Err("OWNER_STORAGE".into())}Ok(file)
}
pub fn file(workspace:&str,create:bool)->Result<PathBuf,String>{
    file_at(&PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("OWNER_STORAGE")?),workspace,create)
}
pub fn read(path:&Path)->Result<Option<Value>,String>{
    match std::fs::symlink_metadata(path){Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err("OWNER_STORAGE".into()),Ok(_)=>safe(path,false)?}
    let mut data=String::new();std::fs::File::open(path).map_err(|_|"OWNER_STORAGE")?.take(10001).read_to_string(&mut data).map_err(|_|"OWNER_STORAGE")?;
    if data.len()>10000{return Err("OWNER_STORAGE".into())}Ok(Some(serde_json::from_str(&data).map_err(|_|"OWNER_STORAGE")?))
}
pub fn write_new(path: &Path,value: &Value)->Result<(),String>{
    let bytes=serde_json::to_vec(value).map_err(|_|"OWNER_STORAGE")?;
    if bytes.len()>10000{return Err("OWNER_STORAGE".into())}
    let mut f=std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e|if e.kind()==std::io::ErrorKind::AlreadyExists{"OWNER_EXISTS"}else{"OWNER_STORAGE"})?;
    f.write_all(&bytes).and_then(|_|f.sync_all()).map_err(|_|"OWNER_STORAGE".into())
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn traversal_and_overwrite_are_rejected(){
        let dir=std::env::temp_dir().join(format!("yuanshu-owner-storage-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&dir).unwrap();
        let workspace="a".repeat(64);
        let file=file_at(&dir,&workspace,false).unwrap();assert!(!file.exists());
        assert!(!dir.join("Yuanshu").exists());
        assert!(file_at(&dir,"../bad",true).is_err());
        assert!(file_at(Path::new("relative"),&workspace,true).is_err());
        let file=file_at(&dir,&workspace,true).unwrap();
        write_new(&file,&serde_json::json!({"test":1})).unwrap();
        assert!(write_new(&file,&serde_json::json!({"test":2})).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(),"{\"test\":1}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
