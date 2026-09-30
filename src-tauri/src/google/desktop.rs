//! Installed-app OAuth: system browser, PKCE, state and a one-shot loopback callback.
//! The refresh token lives in the OS keychain.
use super::DRIVE_SCOPE;
use crate::error::{bail, Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const KEYCHAIN_SERVICE: &str = "org.reader.books.google";
const KEYCHAIN_ACCOUNT: &str = "drive";

#[derive(Clone, Debug, PartialEq)]
pub struct Client {
    pub id: String,
    pub secret: Option<String>,
}

/// Accepts only Desktop OAuth client fields; never account grants.
pub fn parse_client(json: &str) -> Result<Client> {
    #[derive(Deserialize)]
    struct Installed {
        client_id: String,
        client_secret: Option<String>,
    }
    #[derive(Deserialize)]
    struct File {
        installed: Installed,
    }
    let file: File = serde_json::from_str(json).map_err(|_| Error::new("Expected a Google Desktop app client JSON"))?;
    if !file.installed.client_id.ends_with(".apps.googleusercontent.com") {
        bail!("Expected a Google Desktop app client JSON");
    }
    Ok(Client { id: file.installed.client_id, secret: file.installed.client_secret.filter(|s| !s.trim().is_empty()) })
}

/// `READER_GOOGLE_CLIENT_JSON` (a path), then `google-client.json` in the app config
/// directory, then client fields injected at build time. Nothing is committed.
pub fn load_client(config_dir: &Path) -> Result<Option<Client>> {
    if let Ok(path) = std::env::var("READER_GOOGLE_CLIENT_JSON") {
        return std::fs::read_to_string(&path)
            .map_err(|_| Error::new("Cannot read READER_GOOGLE_CLIENT_JSON"))
            .and_then(|json| parse_client(&json))
            .map(Some);
    }
    let local = config_dir.join("google-client.json");
    if local.exists() {
        return parse_client(&std::fs::read_to_string(local)?).map(Some);
    }
    Ok(option_env!("READER_GOOGLE_CLIENT_ID").map(|id| Client {
        id: id.to_owned(),
        secret: option_env!("READER_GOOGLE_CLIENT_SECRET").map(str::to_owned),
    }))
}

pub type Opener = Box<dyn Fn(&str) -> Result<()> + Send + Sync>;

pub struct Platform {
    client: Option<Client>,
    open: Opener,
    http: reqwest::Client,
    refresh_token: Mutex<Option<Option<String>>>,
    connecting: AtomicBool,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|_| Error::new("Keychain is unavailable"))
}

fn random(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

/// Returns the query of a `GET /callback?...` request line.
fn callback_query(head: &str) -> Option<url::Url> {
    let line = head.lines().next()?;
    let mut parts = line.split(' ');
    let (method, target) = (parts.next()?, parts.next()?);
    if method != "GET" || !target.starts_with("/callback?") {
        return None;
    }
    url::Url::parse(&format!("http://127.0.0.1{target}")).ok()
}

async fn respond(socket: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let page = format!(
        "<!doctype html><meta charset=utf-8><title>Reader</title><body style=\"font:16px system-ui;margin:3rem\">{body}</body>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
}

impl Platform {
    pub fn new(config_dir: &Path, open: Opener) -> Self {
        let client = load_client(config_dir).unwrap_or_else(|error| {
            log::error!("{error}");
            None
        });
        Self {
            client,
            open,
            http: reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("HTTP client"),
            refresh_token: Mutex::new(None),
            connecting: AtomicBool::new(false),
        }
    }

    pub fn configured(&self) -> bool {
        self.client.is_some()
    }

    pub fn connecting(&self) -> bool {
        self.connecting.load(Ordering::SeqCst)
    }

    fn saved(&self) -> Result<Option<String>> {
        let mut cache = self.refresh_token.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(token) = cache.as_ref() {
            return Ok(token.clone());
        }
        let token = match entry()?.get_password() {
            Ok(token) => Some(token),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => bail!("Could not read Google credentials from the keychain"),
        };
        *cache = Some(token.clone());
        Ok(token)
    }

    pub fn connected(&self) -> bool {
        self.saved().ok().flatten().is_some()
    }

    fn client(&self) -> Result<&Client> {
        self.client.as_ref().ok_or_else(|| {
            Error::new("Google sign-in is not configured. Add google-client.json (see docs/google-setup.md).")
        })
    }

    async fn exchange(&self, fields: &[(&str, &str)]) -> Result<TokenResponse> {
        let client = self.client()?;
        let mut form: Vec<(&str, &str)> = fields.to_vec();
        form.push(("client_id", &client.id));
        if let Some(secret) = &client.secret {
            form.push(("client_secret", secret));
        }
        let response = self.http.post("https://oauth2.googleapis.com/token").form(&form).send().await?;
        if !response.status().is_success() {
            bail!("Google authorization expired or failed. Reconnect Google Drive.");
        }
        response.json().await.map_err(|_| Error::new("Invalid Google token response"))
    }

    pub async fn connect(&self) -> Result<(String, Duration)> {
        if self.connecting.swap(true, Ordering::SeqCst) {
            bail!("Finish the Google sign-in that is already open in your browser");
        }
        let result = self.authorize().await;
        self.connecting.store(false, Ordering::SeqCst);
        result
    }

    async fn authorize(&self) -> Result<(String, Duration)> {
        let client = self.client()?.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr()?.port());
        let verifier = random(48);
        let state = random(32);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").expect("url");
        url.query_pairs_mut()
            .append_pair("client_id", &client.id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("response_type", "code")
            .append_pair("scope", DRIVE_SCOPE)
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent")
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        (self.open)(url.as_str())?;

        let code = tokio::time::timeout(Duration::from_secs(300), async {
            loop {
                let (mut socket, _) = listener.accept().await?;
                let mut head = vec![0u8; 8192];
                let n = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut head)).await.unwrap_or(Ok(0))?;
                let Some(callback) = callback_query(&String::from_utf8_lossy(&head[..n])) else {
                    respond(&mut socket, "404 Not Found", "Not found").await;
                    continue;
                };
                let param = |name: &str| callback.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
                if param("state").as_deref() != Some(state.as_str()) {
                    respond(&mut socket, "400 Bad Request", "Invalid authorization response").await;
                    continue;
                }
                return match param("code") {
                    Some(code) if param("error").is_none() => {
                        respond(&mut socket, "200 OK", "Google Drive connected. You can return to Reader.").await;
                        Ok(code)
                    }
                    _ => {
                        respond(&mut socket, "400 Bad Request", "Google authorization was not granted.").await;
                        Err(Error::new("Google authorization was not granted"))
                    }
                };
            }
        })
        .await
        .map_err(|_| Error::new("Google sign-in timed out. Try again."))??;

        let tokens = self
            .exchange(&[
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect),
                ("grant_type", "authorization_code"),
            ])
            .await?;
        let Some(refresh) = tokens.refresh_token else {
            bail!("Google did not return an offline grant. Reconnect and allow access.");
        };
        entry()?.set_password(&refresh).map_err(|_| Error::new("Could not save Google credentials in the keychain"))?;
        *self.refresh_token.lock().unwrap_or_else(|e| e.into_inner()) = Some(Some(refresh));
        Ok((tokens.access_token, Duration::from_secs(tokens.expires_in)))
    }

    pub async fn refresh(&self) -> Result<(String, Duration)> {
        let Some(refresh) = self.saved()? else { bail!("Connect Google Drive first") };
        let tokens = self.exchange(&[("grant_type", "refresh_token"), ("refresh_token", &refresh)]).await?;
        Ok((tokens.access_token, Duration::from_secs(tokens.expires_in)))
    }

    pub async fn revoke_cached(&self, _token: &str) {}

    pub async fn disconnect(&self) -> Result<()> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => bail!("Could not remove Google credentials from the keychain"),
        }
        *self.refresh_token.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_desktop_clients() {
        let desktop = r#"{"installed":{"client_id":"123-abc.apps.googleusercontent.com","client_secret":"s","project_id":"p"}}"#;
        assert_eq!(
            parse_client(desktop).unwrap(),
            Client { id: "123-abc.apps.googleusercontent.com".into(), secret: Some("s".into()) }
        );
        assert!(parse_client(r#"{"web":{"client_id":"x.apps.googleusercontent.com"}}"#).is_err());
        assert!(parse_client(r#"{"installed":{"client_id":"not-google"}}"#).is_err());
    }

    #[test]
    fn accepts_only_the_callback_path() {
        let url = callback_query("GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        assert_eq!(url.query_pairs().count(), 2);
        assert!(callback_query("GET /favicon.ico HTTP/1.1\r\n").is_none());
        assert!(callback_query("POST /callback?code=a HTTP/1.1\r\n").is_none());
    }
}
