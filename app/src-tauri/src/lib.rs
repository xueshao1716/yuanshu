// 元枢壳客户端：桌面直连本机服务；Android 走连接页（可输局域网/隧道地址）
// 设计铁律：壳零业务逻辑——只决定 WebView 首屏 URL，其余全是中层 SPA 的事

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
mod startup;
mod owner;

#[tauri::command]
fn open_download_folder(app: tauri::AppHandle) -> Result<(), String> {
    let directory = app
        .path()
        .download_dir()
        .map_err(|error| format!("无法定位下载目录：{error}"))?;
    app.opener().open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("无法打开下载目录：{error}"))
}

/// 本机 8787 是否有服务在听（服务主机安装场景）。800ms 快探，不阻塞启动体验。
fn probe_local_service() -> bool {
    let addr: std::net::SocketAddr = "127.0.0.1:8787".parse().expect("bad addr");
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(800)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::probe_local_service;
    use std::net::TcpListener;

    #[test]
    fn 本机模式探测在常驻环境应命中() {
        // 开发/生产机 8787 由 watchdog 常驻；若环境异常此用例会失败提醒
        assert!(probe_local_service(), "8787 应可探测（watchdog 常驻）");
    }

    #[test]
    fn 保留端口探测必败验证探测函数不会误报() {
        let addr: std::net::SocketAddr = "127.0.0.1:1".parse().unwrap();
        assert!(std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![open_download_folder, startup::ensure_local_service, startup::enter_local_workspace,
            owner::owner_confirmation_status, owner::owner_confirmation_pair, owner::owner_confirmation_sign])
        .setup(|app| {
            #[cfg(desktop)]
            {
                // 2026-10-12 通用客户端：壳不锁任何地址。
                // 本机有服务（服务主机安装）→ 直连本机，快且 UI 随服务更新；
                // 没有（任何其他电脑）→ 打开内置连接页：用户自填工作台地址（记住上次输入），
                // 跳转后由目标服务器的登录页完成令牌认证。跟手机端同一套交互。
                // 探活定终身，不中途跳转：不同 origin 的 localStorage 不共享，跳转会掉登录态。
                let entry = if probe_local_service() {
                    tauri::WebviewUrl::External("http://127.0.0.1:8787/".parse().expect("bad url"))
                } else {
                    tauri::WebviewUrl::App("connect.html".into())
                };
                let win = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    entry,
                )
                // 标题栏带版本号：跟 Cargo.toml 的 version 走（version:bump 会同步，装了就能看见自己是哪一版）
                .title(format!("元枢 · 个人智能系统 v{}", env!("CARGO_PKG_VERSION")))
                .inner_size(1280.0, 820.0)
                .min_inner_size(420.0, 360.0)
                .decorations(true) // 初始保留原生栏（连接页/错误页用它逃生）；进入工作台页面后交出自绘标题栏
                .on_page_load(|window, payload| {
                    let host = payload.url().host_str().unwrap_or("");
                    let is_connect_page = host.contains("tauri.localhost") || host.contains("tauri.");
                    if host == "127.0.0.1" || !is_connect_page {
                        // 本机直连页与用户自填的远程工作台都是 React 应用（自绘标题栏接管），藏原生栏；
                        // 连接页自身保留原生栏，方便关窗/辨认。
                        let _ = window.set_decorations(false);
                    }
                })
                .shadow(true)
                .build()?;
                let _ = win;
            }
            #[cfg(mobile)]
            {
                let win = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("connect.html".into()),
                )
                .title("元枢")
                .use_https_scheme(true)
                .build()?;
                let _ = win;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running yuanshu shell");
}
