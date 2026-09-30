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
