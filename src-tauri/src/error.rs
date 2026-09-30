use serde::{Serialize, Serializer};
use std::fmt;

/// Every failure crosses the IPC boundary as a user-readable message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

pub type Result<T> = std::result::Result<T, Error>;

/// Shown for connection failures; the sync panel treats it as "offline", not as a fault.
pub const OFFLINE: &str = "Offline. Reader will sync when the connection returns.";

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self(format!("Database error: {error}"))
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self(format!("Invalid data: {error}"))
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self(format!("I/O error: {error}"))
    }
}

impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::new("Google Drive timed out. Reader will retry.")
        } else if error.is_connect() {
            Self::new(OFFLINE)
        } else {
            Self(format!("Network error: {error}"))
        }
    }
}

impl From<tauri::Error> for Error {
    fn from(error: tauri::Error) -> Self {
        Self(error.to_string())
    }
}

macro_rules! bail {
    ($($arg:tt)*) => {
        return Err($crate::error::Error(format!($($arg)*)))
    };
}
pub(crate) use bail;
