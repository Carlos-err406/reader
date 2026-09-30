//! Google Drive transport with the `drive.file` scope. Every device writes only its own
//! immutable checkpoint files; books are content-addressed files shared by all devices.
use crate::error::{bail, Error, Result};
use crate::google::GoogleAuth;
use crate::library::sha256;
use crate::sync::engine::{Account, CheckpointFile, Transport};
use crate::sync::model::{canonical, is_sha256, Checkpoint, MAX_BOOK_BYTES, MAX_CHECKPOINT_BYTES};
use reqwest::{header, Method, StatusCode};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
const NAMESPACE: &str = "reader-sync-v1";
const SMALL: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFile {
    id: String,
    size: Option<String>,
    sha256_checksum: Option<String>,
    #[serde(default)]
    app_properties: HashMap<String, String>,
}

impl RemoteFile {
    fn size(&self) -> Option<u64> {
        self.size.as_deref().and_then(|s| s.parse().ok())
    }
}

fn drive_id(id: &str) -> bool {
    (1..=200).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub struct Drive {
    http: reqwest::Client,
    auth: Arc<GoogleAuth>,
}

impl Drive {
    pub fn new(auth: Arc<GoogleAuth>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(900))
            // Never forward the bearer token to another origin.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("HTTP client");
        Self { http, auth }
    }

    async fn send(
        &self,
        method: Method,
        url: &str,
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
        max: usize,
        allow: &[StatusCode],
    ) -> Result<(StatusCode, header::HeaderMap, Vec<u8>)> {
        let token = self.auth.token().await?;
        let mut request = self.http.request(method, url).bearer_auth(token);
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        let mut response = request.send().await?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            self.auth.invalidate().await;
            bail!("Reconnect Google Drive to sync");
        }
        if !status.is_success() && !allow.contains(&status) {
            match status.as_u16() {
                403 => bail!("Google Drive storage or permission denied"),
                429 | 500..=599 => bail!("Google Drive is busy ({status}). Reader will retry."),
                _ => bail!("Google Drive sync failed ({status})"),
            }
        }
        if response.content_length().is_some_and(|n| n as usize > max) {
            bail!("Google Drive response exceeds the sync limit");
        }
        let headers = response.headers().clone();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > max {
                bail!("Google Drive response exceeds the sync limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((status, headers, bytes))
    }

    async fn get_json(&self, url: &str) -> Result<serde_json::Value> {
        let (_, _, bytes) = self.send(Method::GET, url, &[], None, SMALL, &[]).await?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    async fn files(&self, kind: &str, extra: &str) -> Result<Vec<RemoteFile>> {
        let mut found = Vec::new();
        let mut token = String::new();
        let mut seen = std::collections::HashSet::new();
        loop {
            let mut url = url::Url::parse(&format!("{API}/files")).expect("url");
            url.query_pairs_mut()
                .append_pair(
                    "q",
                    &format!(
                        "trashed=false and appProperties has {{ key='syncApp' and value='{NAMESPACE}' }} and appProperties has {{ key='kind' and value='{kind}' }}{extra}"
                    ),
                )
                .append_pair("pageSize", "100")
                .append_pair("spaces", "drive")
                .append_pair("fields", "nextPageToken,files(id,size,sha256Checksum,appProperties)");
            if !token.is_empty() {
                url.query_pairs_mut().append_pair("pageToken", &token);
            }
            let page = self.get_json(url.as_str()).await?;
            let files: Vec<RemoteFile> = serde_json::from_value(page["files"].clone())
                .map_err(|_| Error::new("Invalid Drive file listing"))?;
            found.extend(files.into_iter().filter(|f| drive_id(&f.id)));
            if found.len() > 100_000 {
                bail!("Too many sync files");
            }
            token = page["nextPageToken"].as_str().unwrap_or_default().to_owned();
            if token.is_empty() {
                return Ok(found);
            }
            if !seen.insert(token.clone()) {
                bail!("Invalid Drive pagination");
            }
        }
    }

    async fn download(&self, id: &str, max: usize) -> Result<Vec<u8>> {
        let url = format!("{API}/files/{id}?alt=media");
        Ok(self.send(Method::GET, &url, &[], None, max, &[]).await?.2)
    }

    /// Resumable upload to a pre-generated id. A 409 means an earlier attempt may have
    /// finished; it only counts as success once Drive reports the same bytes.
    async fn upload(&self, id: &str, name: &str, mime: &str, bytes: Vec<u8>, properties: serde_json::Value) -> Result<()> {
        let hash = sha256(&bytes);
        let len = bytes.len();
        let mut app_properties = properties;
        app_properties["syncApp"] = NAMESPACE.into();
        app_properties["sha256"] = hash.clone().into();
        let metadata = json!({ "id": id, "name": name, "mimeType": mime, "appProperties": app_properties });
        let (status, headers, _) = self
            .send(
                Method::POST,
                &format!("{UPLOAD}?uploadType=resumable&fields=id"),
                &[
                    ("Content-Type", "application/json; charset=UTF-8".into()),
                    ("X-Upload-Content-Type", mime.into()),
                    ("X-Upload-Content-Length", len.to_string()),
                ],
                Some(serde_json::to_vec(&metadata)?),
                SMALL,
                &[StatusCode::CONFLICT],
            )
            .await?;
        if status != StatusCode::CONFLICT {
            let Some(session) = headers.get(header::LOCATION).and_then(|v| v.to_str().ok()) else {
                bail!("Google Drive did not start the upload");
            };
            if !session.starts_with("https://www.googleapis.com/upload/drive/v3/") {
                bail!("Unexpected Google Drive upload location");
            }
            self.send(Method::PUT, session, &[("Content-Type", mime.into())], Some(bytes), SMALL, &[StatusCode::CONFLICT])
                .await?;
        }
        let stored: RemoteFile = serde_json::from_value(
            self.get_json(&format!("{API}/files/{id}?fields=id,size,sha256Checksum,appProperties")).await?,
        )?;
        let matches = match &stored.sha256_checksum {
            Some(remote) => remote.eq_ignore_ascii_case(&hash),
            None => sha256(&self.download(id, len).await?) == hash,
        };
        if stored.size() != Some(len as u64) || !matches {
            bail!("Google Drive did not confirm the complete sync upload");
        }
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<()> {
        self.send(Method::DELETE, &format!("{API}/files/{id}"), &[], None, SMALL, &[StatusCode::NOT_FOUND])
            .await?;
        Ok(())
    }

    async fn book_file(&self, sha: &str, size: u64) -> Result<Option<RemoteFile>> {
        let files = self.files("book", &format!(" and appProperties has {{ key='bookSha' and value='{sha}' }}")).await?;
        Ok(files.into_iter().find(|f| {
            f.size() == Some(size)
                && f.app_properties.get("sha256").map(String::as_str) == Some(sha)
                && f.sha256_checksum.as_deref().is_none_or(|c| c.eq_ignore_ascii_case(sha))
        }))
    }
}

impl Transport for Drive {
    async fn account(&self) -> Result<Account> {
        let about = self.get_json(&format!("{API}/about?fields=user(permissionId,emailAddress)")).await?;
        match about["user"]["permissionId"].as_str() {
            Some(id) if !id.is_empty() => Ok(Account {
                id: id.to_owned(),
                email: about["user"]["emailAddress"].as_str().map(str::to_owned),
            }),
            _ => bail!("Cannot identify the Google account"),
        }
    }

    async fn list(&self) -> Result<Vec<CheckpointFile>> {
        self.files("checkpoint", "")
            .await?
            .into_iter()
            .map(|f| {
                let p = &f.app_properties;
                let sequence = p.get("sequence").and_then(|s| s.parse::<u64>().ok()).filter(|s| *s >= 1);
                let sha = p.get("sha256").filter(|s| is_sha256(s));
                let replica = p.get("replica").filter(|r| (1..=200).contains(&r.len()));
                match (sequence, sha, replica, f.size()) {
                    (Some(sequence), Some(sha), Some(replica), Some(size)) if size as usize <= MAX_CHECKPOINT_BYTES => {
                        Ok(CheckpointFile { id: f.id.clone(), replica: replica.clone(), sequence, sha256: sha.clone() })
                    }
                    _ => bail!("Invalid Drive sync checkpoint metadata"),
                }
            })
            .collect()
    }

    async fn read(&self, file: &CheckpointFile) -> Result<Vec<u8>> {
        let bytes = self.download(&file.id, MAX_CHECKPOINT_BYTES).await?;
        if sha256(&bytes) != file.sha256 {
            bail!("Sync checkpoint checksum mismatch");
        }
        Ok(bytes)
    }

    async fn reserve_id(&self) -> Result<String> {
        let data = self.get_json(&format!("{API}/files/generateIds?count=1&space=drive&type=files")).await?;
        match data["ids"][0].as_str() {
            Some(id) if drive_id(id) => Ok(id.to_owned()),
            _ => bail!("Invalid Drive file ID"),
        }
    }

    async fn publish(&self, id: &str, checkpoint: &Checkpoint) -> Result<()> {
        let bytes = canonical(checkpoint)?.into_bytes();
        if bytes.len() > MAX_CHECKPOINT_BYTES {
            bail!("The library is too large to sync");
        }
        let properties = json!({
            "kind": "checkpoint",
            "replica": checkpoint.replica,
            "sequence": checkpoint.sequence.to_string(),
        });
        let name = format!("Reader sync {} {}.json", checkpoint.replica, checkpoint.sequence);
        self.upload(id, &name, "application/json", bytes, properties).await
    }

    async fn has_book(&self, sha: &str, size: u64) -> Result<bool> {
        Ok(self.book_file(sha, size).await?.is_some())
    }

    async fn upload_book(&self, sha: &str, mime: &str, bytes: Vec<u8>) -> Result<()> {
        let id = self.reserve_id().await?;
        let extension = if mime == "application/pdf" { "pdf" } else { "epub" };
        let properties = json!({ "kind": "book", "bookSha": sha });
        self.upload(&id, &format!("Reader book {sha}.{extension}"), mime, bytes, properties).await
    }

    async fn download_book(&self, sha: &str, size: u64) -> Result<Option<Vec<u8>>> {
        if size > MAX_BOOK_BYTES {
            bail!("Book exceeds the sync limit");
        }
        let Some(file) = self.book_file(sha, size).await? else { return Ok(None) };
        let bytes = self.download(&file.id, size as usize).await?;
        if bytes.len() as u64 != size || sha256(&bytes) != sha {
            bail!("Downloaded book checksum mismatch");
        }
        Ok(Some(bytes))
    }

    async fn prune(&self, replica: &str) -> Result<()> {
        let mut own: Vec<CheckpointFile> = self.list().await?.into_iter().filter(|f| f.replica == replica).collect();
        own.sort_by(|a, b| b.sequence.cmp(&a.sequence));
        for file in own.iter().skip(2) {
            self.delete(&file.id).await?;
        }
        Ok(())
    }
}
