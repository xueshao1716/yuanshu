fn main() {
    let manifest = tauri_build::AppManifest::new()
        .commands(&["ensure_local_service", "enter_local_workspace"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build app permissions");
}
