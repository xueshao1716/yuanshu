use std::sync::atomic::{AtomicBool, Ordering};
static STARTING: AtomicBool = AtomicBool::new(false);
struct StartupGuard;
impl Drop for StartupGuard {
    fn drop(&mut self) { STARTING.store(false, Ordering::Release); }
}

#[tauri::command]
pub async fn ensure_local_service() -> Result<(), String> {
    if STARTING.swap(true, Ordering::AcqRel) { return Err("START_BUSY".into()); }
    let guard = StartupGuard;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        ensure_service()
    }).await.map_err(|_| "START_FAILED".to_string())?
}

#[cfg(target_os = "windows")]
fn ensure_service() -> Result<(), String> {
    use std::{process::{Command, Stdio}, time::{Duration, Instant}, thread, io::Read};
    use std::os::windows::process::CommandExt;
    let system_root = std::env::var_os("SystemRoot").ok_or("SYSTEM_ROOT_MISSING")?;
    let executable = std::path::PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = Command::new(executable)
        .args(["-NoProfile", "-NonInteractive", "-Command", include_str!("ensure-service.ps1")])
        .creation_flags(0x08000000)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "START_HELPER_FAILED")?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = String::new();
                if let Some(stdout) = child.stdout.take() {
                    stdout.take(4096).read_to_string(&mut output).map_err(|_| "START_HELPER_FAILED")?;
                }
                return parse_result(status.success(), &output);
            }
            Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err("START_HELPER_FAILED".into()); }
            Ok(None) if Instant::now() >= deadline => {
                // Kill only our bounded helper, never the backend or watchdog.
                let _ = child.kill(); let _ = child.wait(); return Err("HEALTH_TIMEOUT".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn ensure_service() -> Result<(), String> { Err("PLATFORM_UNSUPPORTED".into()) }

fn parse_result(success: bool, output: &str) -> Result<(), String> {
    let code = output.trim();
    if success && code == "READY" { return Ok(()); }
    match code {
        "TASK_UNAVAILABLE" | "TASK_DISABLED" | "TASK_START_DENIED" | "HEALTH_TIMEOUT" => Err(code.into()),
        _ => Err("START_HELPER_FAILED".into()),
    }
}

#[tauri::command]
pub fn enter_local_workspace(window: tauri::WebviewWindow) -> Result<(), String> {
    window.navigate("http://127.0.0.1:8787/".parse().map_err(|_| "NAVIGATION_FAILED")?)
        .map_err(|_| "NAVIGATION_FAILED".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_success_enters_workspace() {
        assert!(parse_result(true, "READY\r\n").is_ok());
        assert!(parse_result(false, "READY").is_err());
        assert!(parse_result(true, "").is_err());
        assert_eq!(parse_result(true, "TASK_DISABLED"), Err("TASK_DISABLED".into()));
        assert_eq!(parse_result(false, "secret error content"), Err("START_HELPER_FAILED".into()));
    }
}
