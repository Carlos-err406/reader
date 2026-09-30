# Releasing Reader

Releases are published to GitHub Releases at `Carlos-err406/reader` by `.github/workflows/release.yml`. Every pull request and push to `main` runs the checks: versions and release notes, typecheck, frontend and Rust tests, the frontend build, and a debug Android build that uses no secrets.

## Cutting a release

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (then run `cargo check` so `Cargo.lock` follows).
2. Add `docs/releases/<version>.md`. Its text becomes the GitHub release notes and the desktop update notes.
3. Run `node scripts/check-release.mjs`, open a PR, and merge it once the checks pass.
4. Tag a commit that is on `main`, and push the tag:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

The tag run repeats the checks and then builds two packages in parallel:

- **macOS**: a universal (Apple Silicon and Intel) `.dmg`, plus a `.app.tar.gz` for the updater that is signed with the updater key.
- **Android**: a release APK signed with the Reader key. The build fails unless its certificate matches `release/android-certificate.sha256`.

The publish job then writes `latest.json` (the desktop updater manifest) and a `.sha256` for each package. It uploads everything to a **draft** release, downloads the uploads back to verify them byte for byte, and only then publishes the release as latest. If an upload is interrupted, a draft is left behind; rerun the job to finish it. A release that is already published is never replaced, so publish a new version instead.

## How installed copies update

- **Desktop**: Tauri's updater reads `releases/latest/download/latest.json`, checks the bundle signature against the public key in `tauri.conf.json`, installs the bundle and restarts. Losing the updater private key means installed copies can no longer update, and users would have to reinstall by hand.
- **Android**: the app compares its version with the latest GitHub release and offers that release's APK, but only from this repository's download URLs, and only when GitHub reports the file's SHA-256 digest. `AppUpdatePlugin.kt` downloads it into the app's cache, then checks the size and digest, the package name, the version, a higher version code, and that the signer matches the installed app's. Only then does it open Android's installer. The first update asks the user to allow Reader to install apps (`REQUEST_INSTALL_PACKAGES`).

## Secrets

The local originals live in `~/.reader-release/` (created with `chmod 700`). **Back up that folder**, for example in a password manager or on an encrypted drive. The Android key signs every future update, and it can't be replaced without making every user reinstall.

| Actions secret | Value |
| --- | --- |
| `READER_ANDROID_KEYSTORE_BASE64` | `base64 < ~/.reader-release/android-release.jks` |
| `READER_ANDROID_STORE_PASSWORD` | `READER_ANDROID_STORE_PASSWORD` from `secrets.env` |
| `READER_ANDROID_KEY_PASSWORD` | `READER_ANDROID_KEY_PASSWORD` from `secrets.env` |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.reader-release/updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from `secrets.env` |
| `READER_GOOGLE_DESKTOP_CLIENT_JSON` | the downloaded Desktop OAuth client JSON |

Only the tag jobs receive these secrets. The keystore is written to the runner's temporary directory and deleted after the build. The Desktop OAuth client ID and secret are public application identifiers under Google's installed-app model, so they are compiled into the macOS app. The Android build contains no OAuth values, because Google matches Android clients by package name and signing certificate.

## Google Cloud for release builds

- Create a second **Android** OAuth client in the `reader-510214` project, with package `org.reader.books` and the release certificate's SHA-1 (`97:E0:CF:6E:E7:72:4A:47:F6:BD:CD:2E:9B:C3:09:F0:7D:A8:C8:29`). The debug client keeps working for development builds.
- While the Google Auth Platform app is in **Testing**, only listed test users can sign in, and they have to reconnect every 7 days. Publish it to **Production** for normal use. `drive.file` is a non-sensitive scope, so publishing it doesn't need Google's verification.

## Building locally

```sh
# macOS (unsigned by Apple; ad-hoc signature)
set -a; . ~/.reader-release/secrets.env; set +a
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.reader-release/updater.key)" pnpm tauri build --target universal-apple-darwin --bundles app,dmg

# Android release APK
READER_ANDROID_KEYSTORE=~/.reader-release/android-release.jks pnpm tauri android build --apk --target aarch64
```

A release APK can't be installed over a debug build, because the two are signed by different keys. Uninstall the debug build first. Your library comes back through sync, but anything that hasn't synced yet stays on the old install and is lost.
