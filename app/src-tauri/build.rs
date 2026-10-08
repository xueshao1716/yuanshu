fn main() {
    // 2026-10-08 delay-load webauthn.dll：旧版 Windows（1903以下）没有 WebAuthNCancelCurrentOperation
    // 等入口，静态链接会导致 exe 启动即报「无法定位程序输入点」。改成延迟加载后，
    // 找不到 webauthn.dll 入口点不影响启动，只在实际调用 Windows Hello 时才失败。
    println!("cargo:rustc-link-arg=/DELAYLOAD:webauthn.dll");
    println!("cargo:rustc-link-arg=delayimp.lib");
    let manifest = tauri_build::AppManifest::new()
        .commands(&["ensure_local_service", "enter_local_workspace", "owner_confirmation_status", "owner_confirmation_pair", "owner_confirmation_sign"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build app permissions");
}
