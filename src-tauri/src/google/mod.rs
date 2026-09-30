//! Google authorization for Drive's `drive.file` scope. Tokens stay in Rust or the
//! platform's account store; they never reach the webview or a checkpoint.
use crate::error::Result;
use serde::Serialize;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[cfg(target_os = "android")]
mod android;
#[cfg(not(target_os = "android"))]
mod desktop;
#[cfg(not(target_os = "android"))]
mod keychain;

#[cfg(target_os = "android")]
pub use android::{plugin, Platform};
#[cfg(not(target_os = "android"))]
pub use desktop::Platform;

pub const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    pub configured: bool,
    pub connected: bool,
    pub connecting: bool,
    pub error: Option<String>,
}

pub struct GoogleAuth {
    platform: Platform,
    access: Mutex<Option<(String, Instant)>>,
    error: std::sync::Mutex<Option<String>>,
}

impl GoogleAuth {
    pub fn new(platform: Platform) -> Self {
        Self { platform, access: Mutex::new(None), error: std::sync::Mutex::new(None) }
    }

    fn set_error(&self, error: Option<String>) {
        *self.error.lock().unwrap_or_else(|e| e.into_inner()) = error;
    }

    pub fn status(&self) -> GoogleStatus {
        GoogleStatus {
            configured: self.platform.configured(),
            connected: self.platform.connected(),
            connecting: self.platform.connecting(),
            error: self.error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        }
    }

    /// Interactive: opens the browser (desktop) or Google's account sheet (Android).
    pub async fn connect(&self) -> Result<()> {
        self.set_error(None);
        let result = self.platform.connect().await;
        match &result {
            Ok((token, lifetime)) => {
                *self.access.lock().await = Some((token.clone(), Instant::now() + *lifetime));
            }
            Err(error) => self.set_error(Some(error.0.clone())),
        }
        result.map(|_| ())
    }

    pub async fn token(&self) -> Result<String> {
        let mut access = self.access.lock().await;
        if let Some((token, expires)) = access.as_ref() {
            if *expires > Instant::now() {
                return Ok(token.clone());
            }
        }
        match self.platform.refresh().await {
            Ok((token, lifetime)) => {
                // Renew a minute early so a request never starts with an expiring token.
                let lifetime = lifetime.saturating_sub(Duration::from_secs(60));
                *access = Some((token.clone(), Instant::now() + lifetime));
                self.set_error(None);
                Ok(token)
            }
            Err(error) => {
                self.set_error(Some(error.0.clone()));
                Err(error)
            }
        }
    }

    pub async fn invalidate(&self) {
        if let Some((token, _)) = self.access.lock().await.take() {
            self.platform.revoke_cached(&token).await;
        }
    }

    pub async fn disconnect(&self) -> Result<()> {
        self.invalidate().await;
        self.set_error(None);
        self.platform.disconnect().await
    }
}
