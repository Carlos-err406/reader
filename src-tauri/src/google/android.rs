//! Google Play services owns the account grant (AuthorizationClient). Rust asks the
//! Kotlin `GoogleAuthPlugin` for short-lived access tokens.
use crate::error::{Error, Result};
use crate::store::Store;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime, Wry};

pub struct Handle(pub PluginHandle<Wry>);

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new("google-auth")
        .setup(|app, api| {
            let handle = api.register_android_plugin("org.reader.books", "GoogleAuthPlugin")?;
            app.manage(Handle(handle));
            Ok(())
        })
        .build()
}

#[derive(Deserialize)]
struct Token {
    token: String,
}

pub struct Platform {
    handle: PluginHandle<Wry>,
    store: Arc<Store>,
    connecting: AtomicBool,
}

impl Platform {
    pub fn new<R: Runtime>(app: &tauri::AppHandle<R>, store: Arc<Store>) -> Self {
        let handle = app.state::<Handle>().0.clone();
        Self { handle, store, connecting: AtomicBool::new(false) }
    }

    pub fn configured(&self) -> bool {
        true
    }

    pub fn connecting(&self) -> bool {
        self.connecting.load(Ordering::SeqCst)
    }

    pub fn connected(&self) -> bool {
        self.store.meta("google_connected").ok().flatten().as_deref() == Some("1")
    }

    async fn authorize(&self, interactive: bool) -> Result<(String, Duration)> {
        let handle = self.handle.clone();
        let token = tauri::async_runtime::spawn_blocking(move || {
            handle.run_mobile_plugin::<Token>("authorize", json!({ "interactive": interactive }))
        })
        .await
        .map_err(|_| Error::new("Google authorization was interrupted"))?
        .map_err(|e| {
            let message = e.to_string();
            // Background refreshes report a lost connection the same way HTTP does.
            if !interactive && message.contains("couldn't reach Google") {
                Error::new(crate::error::OFFLINE)
            } else {
                Error::new(message)
            }
        })?;
        // Play services does not report a lifetime; access tokens last an hour.
        Ok((token.token, Duration::from_secs(50 * 60)))
    }

    pub async fn connect(&self) -> Result<(String, Duration)> {
        self.connecting.store(true, Ordering::SeqCst);
        let result = self.authorize(true).await;
        self.connecting.store(false, Ordering::SeqCst);
        if result.is_ok() {
            self.store.set_meta("google_connected", "1")?;
        }
        result
    }

    pub async fn refresh(&self) -> Result<(String, Duration)> {
        if !self.connected() {
            return Err(Error::new("Connect Google Drive first"));
        }
        self.authorize(false).await
    }

    pub async fn revoke_cached(&self, token: &str) {
        let handle = self.handle.clone();
        let token = token.to_owned();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            handle.run_mobile_plugin::<serde_json::Value>("clearToken", json!({ "token": token }))
        })
        .await;
    }

    pub async fn disconnect(&self) -> Result<()> {
        self.store.set_meta("google_connected", "0")
    }
}
