//! Reading aloud on Android, with the phone's text-to-speech engine (SpeechPlugin.kt). Desktop
//! webviews speak themselves (`speechSynthesis`), so these commands are only for Android.

#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{Manager, Wry};

    pub struct Handle(pub PluginHandle<Wry>);

    pub fn plugin() -> TauriPlugin<Wry> {
        Builder::new("speech")
            .setup(|app, api| {
                app.manage(Handle(api.register_android_plugin("org.reader.books", "SpeechPlugin")?));
                Ok(())
            })
            .build()
    }

    pub async fn call(app: tauri::AppHandle, method: &'static str, payload: serde_json::Value) -> crate::error::Result<serde_json::Value> {
        let handle = app.state::<Handle>().0.clone();
        tauri::async_runtime::spawn_blocking(move || handle.run_mobile_plugin::<serde_json::Value>(method, payload))
            .await
            .map_err(|e| crate::error::Error::new(e.to_string()))?
            .map_err(|e| crate::error::Error::new(e.to_string()))
    }
}
#[cfg(target_os = "android")]
pub use android::plugin;

/// Android's engines cap one utterance at 4000 characters; sentences are far shorter.
const MAX_TEXT: usize = 4000;
/// A chapter's sentences at most.
const MAX_TEXTS: usize = 20_000;

/// The phone's voices: id, a name to show and the language (BCP 47).
#[tauri::command]
pub async fn speech_voices(app: tauri::AppHandle) -> crate::error::Result<serde_json::Value> {
    #[cfg(target_os = "android")]
    {
        let reply = android::call(app, "voices", serde_json::json!({})).await?;
        Ok(reply["voices"].clone())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(crate::error::Error::new("Reading aloud uses the system's voices directly here"))
    }
}

/// Speaks `texts` in turn, replacing whatever was being said. Each is the utterance
/// `<utterance>:<index>`; its start and end are sent to `events`.
#[tauri::command]
pub async fn speech_speak(
    texts: Vec<String>,
    utterance: u32,
    voice: Option<String>,
    lang: Option<String>,
    rate: f32,
    events: tauri::ipc::Channel<serde_json::Value>,
    app: tauri::AppHandle,
) -> crate::error::Result<()> {
    if texts.len() > MAX_TEXTS || texts.iter().any(|t| t.chars().count() > MAX_TEXT) || !rate.is_finite() {
        return Err(crate::error::Error::new("Too much to read aloud at once"));
    }
    #[cfg(target_os = "android")]
    {
        // The channel serialises to its id, which the Kotlin side sends to.
        let payload = serde_json::json!({ "texts": texts, "utterance": utterance, "voice": voice, "lang": lang, "rate": rate.clamp(0.25, 4.0), "events": events });
        android::call(app, "speak", payload).await?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (utterance, voice, lang, events, app);
        Err(crate::error::Error::new("Reading aloud uses the system's voices directly here"))
    }
}

/// Opens the phone's screen for adding voices.
#[tauri::command]
pub async fn speech_install_voices(app: tauri::AppHandle) -> crate::error::Result<()> {
    #[cfg(target_os = "android")]
    {
        android::call(app, "installVoices", serde_json::json!({})).await?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(crate::error::Error::new("Add voices in the system's settings"))
    }
}

/// Stops speaking.
#[tauri::command]
pub async fn speech_stop(app: tauri::AppHandle) -> crate::error::Result<()> {
    #[cfg(target_os = "android")]
    android::call(app, "stop", serde_json::json!({})).await?;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}
