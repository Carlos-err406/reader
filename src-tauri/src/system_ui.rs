//! Immersive reading on Android: hide the system bars. Desktop uses window fullscreen instead.
#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{Manager, Wry};

    pub struct Handle(pub PluginHandle<Wry>);

    pub fn plugin() -> TauriPlugin<Wry> {
        Builder::new("system-ui")
            .setup(|app, api| {
                app.manage(Handle(api.register_android_plugin("org.reader.books", "SystemUiPlugin")?));
                Ok(())
            })
            .build()
    }

    pub struct Updater(pub PluginHandle<Wry>);

    /// In-app updates (AppUpdatePlugin.kt). Registered as "app-update" so the webview can listen
    /// for download progress.
    pub fn updater() -> TauriPlugin<Wry> {
        Builder::new("app-update")
            .setup(|app, api| {
                app.manage(Updater(api.register_android_plugin("org.reader.books", "AppUpdatePlugin")?));
                Ok(())
            })
            .build()
    }
}
#[cfg(target_os = "android")]
pub use android::updater;

/// Android: download, verify and install the newest release APK. Rust looks the release up
/// itself, so the webview can't point the installer at anything else. Returns "installing"
/// once Android's installer is open, or "permission" if Reader must be allowed to install first.
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    on_progress: tauri::ipc::Channel<serde_json::Value>,
) -> crate::error::Result<String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let Some(release) = crate::updates::check().await? else {
            return Err(crate::error::Error::new("Reader is up to date"));
        };
        let handle = app.state::<android::Updater>().0.clone();
        let reply = tauri::async_runtime::spawn_blocking(move || {
            handle.run_mobile_plugin::<serde_json::Value>(
                "install",
                // The channel serialises to its id, which the Kotlin side sends progress to.
                serde_json::json!({ "url": release.url, "sha256": release.sha256, "size": release.size, "version": release.version, "onProgress": on_progress }),
            )
        })
        .await
        .map_err(|e| crate::error::Error::new(e.to_string()))?
        .map_err(|e| crate::error::Error::new(e.to_string()))?;
        Ok(reply["state"].as_str().unwrap_or("installing").to_owned())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, on_progress);
        Err(crate::error::Error::new("Desktop updates install through the updater"))
    }
}
#[cfg(target_os = "android")]
pub use android::plugin;

#[tauri::command]
pub async fn set_immersive(on: bool, app: tauri::AppHandle) -> crate::error::Result<()> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let handle = app.state::<android::Handle>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            handle.run_mobile_plugin::<serde_json::Value>("setImmersive", serde_json::json!({ "on": on }))
        })
        .await
        .map_err(|e| crate::error::Error::new(e.to_string()))?
        .map_err(|e| crate::error::Error::new(e.to_string()))?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = (on, app);
    Ok(())
}
