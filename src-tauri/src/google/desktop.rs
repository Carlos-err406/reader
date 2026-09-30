//! Installed-app OAuth: system browser, PKCE, state and a one-shot loopback callback.
//! The refresh token lives in the OS keychain.
use super::DRIVE_SCOPE;
use crate::error::{bail, Error, Result};
use base64::{engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;


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

/// The link scheme Reader registers with macOS (tauri.conf.json, deep-link plugin). The browser
/// asks "Open Reader?" and brings the app back after signing in.
pub const APP_SCHEME: &str = "org.reader.books";

/// The page the browser shows after Google sends the user back: Reader's look, light and dark.
fn callback_page(ok: bool, message: &str) -> String {
    let icon = STANDARD.encode(include_bytes!("../../icons/128x128@2x.png"));
    let escape = |text: &str| text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let (title, detail) = if ok {
        ("Google Drive connected", "Sync is turning on. You can close this tab and go back to Reader.")
    } else {
        ("Couldn't connect Google Drive", message)
    };
    let back = if ok {
        format!(
            r#"<a class="button" href="{APP_SCHEME}://connected">Open Reader</a>
<script>setTimeout(function () {{ location.href = "{APP_SCHEME}://connected"; }}, 400);</script>"#
        )
    } else {
        "<p class=\"hint\">Go back to Reader and choose <b>Turn on sync with Google Drive</b>.</p>".to_owned()
    };
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · Reader</title>
<style>
:root {{ color-scheme: light dark; --bg: #f6f2ea; --card: #fbf8f2; --ink: #1d1b18; --muted: #6d665c; --line: #e2dacb; --accent: #1f3a5f; --on-accent: #fff; --ok: #3f8f5a; --bad: #b3412e; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #141312; --card: #1a1917; --ink: #e8e3da; --muted: #9c958a; --line: #2d2b27; --accent: #8fb3e6; --on-accent: #10213a; --bad: #e0664f; }} }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 24px; }}
main {{ width: min(420px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 36px 32px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,.08); }}
img {{ display: block; width: 72px; height: 72px; margin: 0 auto; }}
.state {{ display: inline-flex; align-items: center; gap: 8px; margin-top: 18px; font-weight: 600; font-size: 20px; font-family: Georgia, "Iowan Old Style", serif; }}
.dot {{ width: 10px; height: 10px; border-radius: 50%; background: var(--{dot}); }}
p {{ margin: 10px 0 0; color: var(--muted); }}
.button {{ display: inline-block; margin-top: 24px; padding: 10px 22px; border-radius: 999px; background: var(--accent); color: var(--on-accent); text-decoration: none; font-weight: 600; }}
.hint {{ margin-top: 20px; font-size: 14px; }}
</style></head>
<body><main>
<img src="data:image/png;base64,{icon}" alt="Reader">
<div class="state"><span class="dot"></span>{title}</div>
<p>{detail}</p>
{back}
</main></body></html>"#,
        title = escape(title),
        detail = escape(detail),
        dot = if ok { "ok" } else { "bad" },
    )
}

async fn respond(socket: &mut tokio::net::TcpStream, status: &str, page: &str) {
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
        let token = super::keychain::read()?;
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

        // Keep the browser's connection open until the sign-in is complete, so its page tells
        // the truth: connected, or the actual problem.
        let (mut socket, code) = tokio::time::timeout(Duration::from_secs(300), async {
            loop {
                let (mut socket, _) = listener.accept().await?;
                let mut head = vec![0u8; 8192];
                let n = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut head)).await.unwrap_or(Ok(0))?;
                let Some(callback) = callback_query(&String::from_utf8_lossy(&head[..n])) else {
                    respond(&mut socket, "404 Not Found", "").await;
                    continue;
                };
                let param = |name: &str| callback.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
                if param("state").as_deref() != Some(state.as_str()) {
                    respond(&mut socket, "400 Bad Request", &callback_page(false, "This sign-in link is out of date.")).await;
                    continue;
                }
                return match param("code") {
                    Some(code) if param("error").is_none() => Ok((socket, code)),
                    _ => {
                        let page = callback_page(false, "Access to Google Drive wasn't allowed.");
                        respond(&mut socket, "400 Bad Request", &page).await;
                        Err(Error::new("Google authorization was not granted"))
                    }
                };
            }
        })
        .await
        .map_err(|_| Error::new("Google sign-in timed out. Try again."))??;

        let result = async {
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
            super::keychain::write(&refresh)?;
            *self.refresh_token.lock().unwrap_or_else(|e| e.into_inner()) = Some(Some(refresh));
            Ok((tokens.access_token, Duration::from_secs(tokens.expires_in)))
        }
        .await;
        match &result {
            Ok(_) => respond(&mut socket, "200 OK", &callback_page(true, "")).await,
            Err(error) => respond(&mut socket, "500 Internal Server Error", &callback_page(false, &error.0)).await,
        }
        result
    }

    pub async fn refresh(&self) -> Result<(String, Duration)> {
        let Some(refresh) = self.saved()? else { bail!("Connect Google Drive first") };
        let tokens = self.exchange(&[("grant_type", "refresh_token"), ("refresh_token", &refresh)]).await?;
        Ok((tokens.access_token, Duration::from_secs(tokens.expires_in)))
    }

    pub async fn revoke_cached(&self, _token: &str) {}

    pub async fn disconnect(&self) -> Result<()> {
        super::keychain::remove()?;
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
    fn callback_pages_escape_messages_and_link_back_to_the_app() {
        let ok = callback_page(true, "");
        assert!(ok.contains("Google Drive connected"));
        assert!(ok.contains(&format!("{APP_SCHEME}://connected")));
        assert!(ok.contains("data:image/png;base64,iVBOR"));
        let bad = callback_page(false, "<script>alert(1)</script>");
        assert!(bad.contains("&lt;script&gt;"));
        assert!(!bad.contains("<script>alert"));
        assert!(!bad.contains("://connected"));
    }

    #[test]
    fn accepts_only_the_callback_path() {
        let url = callback_query("GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        assert_eq!(url.query_pairs().count(), 2);
        assert!(callback_query("GET /favicon.ico HTTP/1.1\r\n").is_none());
        assert!(callback_query("POST /callback?code=a HTTP/1.1\r\n").is_none());
    }
}
