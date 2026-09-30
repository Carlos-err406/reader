//! Android can't replace itself, so it looks for a newer GitHub release and offers the APK.
//! Desktop uses the signed Tauri updater from the webview instead.
use crate::error::{bail, Result};
use serde::{Deserialize, Serialize};

const RELEASES: &str = "https://api.github.com/repos/Carlos-err406/reader/releases/latest";
const DOWNLOADS: &str = "https://github.com/Carlos-err406/reader/releases/download/";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    pub url: String,
    pub notes: String,
    /// Published by GitHub for the uploaded file; the phone checks the download against it.
    pub sha256: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: String,
    #[serde(default)]
    size: u64,
}

const MAX_APK: u64 = 200 * 1024 * 1024;

/// `major.minor.patch`, ignoring a leading `v`; anything else isn't a release we offer.
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.strip_prefix('v').unwrap_or(text).split('.').map(|p| p.parse::<u64>().ok());
    match (parts.next()??, parts.next()??, parts.next()??, parts.next()) {
        (major, minor, patch, None) => Some((major, minor, patch)),
        _ => None,
    }
}

fn newer(release: Release, current: &str) -> Option<Available> {
    if release.draft || release.prerelease {
        return None;
    }
    let latest = parse_version(&release.tag_name)?;
    if latest <= parse_version(current)? {
        return None;
    }
    let apk = release.assets.into_iter().find(|a| a.name.ends_with(".apk"))?;
    let sha256 = apk.digest.strip_prefix("sha256:").filter(|d| crate::sync::model::is_sha256(d))?.to_owned();
    // Only ever download from this repository's releases, and only a sensibly sized file.
    (apk.browser_download_url.starts_with(DOWNLOADS) && (1..=MAX_APK).contains(&apk.size)).then(|| Available {
        version: release.tag_name.trim_start_matches('v').to_owned(),
        url: apk.browser_download_url,
        notes: release.body.chars().take(2000).collect(),
        sha256,
        size: apk.size,
    })
}

pub async fn check() -> Result<Option<Available>> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("Reader/", env!("CARGO_PKG_VERSION")))
        .build()?
        .get(RELEASES)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    match response.status().as_u16() {
        200 => Ok(newer(response.json().await?, env!("CARGO_PKG_VERSION"))),
        404 => Ok(None),
        status => bail!("Couldn't check for updates ({status})"),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, url: &str) -> Release {
        Release {
            tag_name: tag.into(),
            body: "Notes".into(),
            draft: false,
            prerelease: false,
            assets: vec![Asset {
                name: "Reader.apk".into(),
                browser_download_url: url.into(),
                digest: format!("sha256:{}", "a".repeat(64)),
                size: 1000,
            }],
        }
    }

    #[test]
    fn offers_only_newer_releases_from_this_repository() {
        let ours = format!("{DOWNLOADS}v0.2.0/Reader.apk");
        assert_eq!(newer(release("v0.2.0", &ours), "0.1.0").unwrap().version, "0.2.0");
        assert!(newer(release("v0.1.0", &ours), "0.1.0").is_none());
        assert!(newer(release("v0.0.9", &ours), "0.1.0").is_none());
        assert!(newer(release("v0.2.0", "https://evil.example/Reader.apk"), "0.1.0").is_none());
        assert!(newer(release("nightly", &ours), "0.1.0").is_none());
        // No published checksum, or an absurd size: not offered.
        let mut unchecked = release("v0.2.0", &ours);
        unchecked.assets[0].digest.clear();
        assert!(newer(unchecked, "0.1.0").is_none());
        let mut huge = release("v0.2.0", &ours);
        huge.assets[0].size = MAX_APK + 1;
        assert!(newer(huge, "0.1.0").is_none());
        let mut draft = release("v0.3.0", &ours);
        draft.draft = true;
        assert!(newer(draft, "0.1.0").is_none());
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(parse_version("v0.10.0") > parse_version("0.9.9"));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
    }
}
