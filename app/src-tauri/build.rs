fn main() {
    let manifest = tauri_build::AppManifest::new()
        .commands(&["ensure_local_service", "enter_local_workspace", "owner_confirmation_status", "owner_confirmation_pair", "owner_confirmation_sign"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build app permissions");
}
