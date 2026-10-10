# Reader

A Tauri 2 app (macOS + Android) for reading PDF/EPUB, with library, position and bookmark sync through the user's Google Drive. Design: `docs/architecture.md`. OAuth: `docs/google-setup.md`.

- Keep one codebase. Platform differences live behind `cfg(target_os = "android")` in `src-tauri/src/google/`, `system_ui.rs`, `speech.rs` and `app_foreground`. Kotlin lives only in `gen/android/app/src/main/java/org/reader/books/`: `GoogleAuthPlugin.kt`, `SystemUiPlugin.kt`, `AppUpdatePlugin.kt`, `OpenedFilesPlugin.kt` and `SpeechPlugin.kt`.
- The sync protocol follows Tasker (`~/Developer/tasker/packages/core/src/sync`): HLC revisions, immutable per-replica checkpoints with pre-generated ids, full validation before apply, tombstones, and no transaction across an await. Don't swap in a shared mutable file or whole-database replacement.
- Every synced write goes through `Store::stamp`, and every mutating command calls `sync.local_changed()`.
- Book bytes are BLOBs in `blobs`, keyed by SHA-256. Never return them in list queries.
- Tokens stay in Rust, the keychain or Play services. Never send them to the webview or put them in checkpoints. Never commit `google-client.json`, client IDs, `*.db` files or keystores.
- Before handing off, run `pnpm test`, `pnpm typecheck` and `pnpm build`. Engine tests use the in-memory `Transport` fake. Never point tests at a real Google account.
- UI uses shadcn/ui (Radix + Tailwind v4) from `src/components/ui`; add more with `pnpm dlx shadcn@latest add <name>` and fix the `cn` import to `@/lib/utils`. Prefer those over hand-rolled popups so outside-click, Escape and focus work. Skins set the shadcn tokens at runtime (`src/display.ts` → `applyChrome`).
- Display settings (appearance, skin, font, size, layout) are per device in localStorage, never synced. EPUB pages are restyled by the stylesheet from `pageCss`, injected into every chapter via the epub.js content hook (epub.js themes can't override book colours).
- Regenerate icons with `pnpm icons` (Android's adaptive icon needs the separate `assets/icon-foreground.svg`).
- Releases: follow `docs/releasing.md`. Keep the version the same in `package.json`, `tauri.conf.json` and `Cargo.toml` (`node scripts/check-release.mjs` checks this), and add `docs/releases/<version>.md`. Only tag commits that are on `main`. Never replace published release assets.
- Never commit anything from `~/.reader-release/` (the keystore, the updater key or passwords), and never regenerate those keys as a workaround. `release/android-certificate.sha256` pins the release certificate.
