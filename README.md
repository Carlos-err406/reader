# Reader

A PDF and EPUB reader for macOS and Android that keeps your place on both. Import a book on one device and it shows up on the other. Your reading position, bookmarks and highlights follow you in both directions.

One Tauri 2 app builds for both platforms. Books are stored as SQLite BLOBs. Sync uses your own Google Drive with Tasker's checkpoint protocol (see [architecture](docs/architecture.md)). There is no server and no hosting cost.

## Install

Download the latest release from [GitHub Releases](https://github.com/Carlos-err406/reader/releases/latest).

- **macOS** (Apple Silicon or Intel): open the `.dmg` and drag Reader to Applications. Reader isn't notarized by Apple, so the first time you have to right-click it and choose **Open**. After that it updates itself.
- **Android**: open the `.apk` on the phone and allow your browser to install apps. When a new version is out, Reader downloads it, checks it and opens Android's installer. The first time, Android asks you to allow Reader to install updates.

## Develop

```sh
pnpm install
pnpm desktop            # macOS window with hot reload
pnpm android            # device or emulator (needs ANDROID_HOME, NDK_HOME, JAVA_HOME=17)
pnpm test               # vitest + cargo test
pnpm typecheck
pnpm build:desktop      # .app / .dmg in src-tauri/target/release/bundle
pnpm build:android      # debug APK in src-tauri/gen/android/app/build/outputs/apk
```

Sync needs a Google OAuth client for each platform. See [Google setup](docs/google-setup.md). Reading works fully offline without one. Releases are covered in [releasing](docs/releasing.md).

## Using it

- **Add book** imports PDFs and EPUBs. On the Mac you can also drag books from Finder into the window. A book's identity is the SHA-256 of its bytes, so importing the same file on both devices gives you one book.
- Books scroll continuously by default. **Aa** switches to page turns (edge taps, swipes, arrow keys) and sets the appearance (System, Light or Dark), the skin (Paper, Sepia, Slate or Contrast), the font (Literata, Serif, Sans, Hyperlegible or the book's own) and the text size. These settings are per device.
- The bookmark icon saves where you are. Select text (long-press on a phone) and pick one of five colours to highlight it, and tap a highlight to recolour, copy or delete it. The list icon shows the book's highlights and bookmarks. The highlighter in the library lists every book's highlights, with search, and opens a book right at one. Scanned PDFs without a text layer can't be highlighted.
- Pull down in the library to sync right away.
- **Sync** (at the bottom of the library, next to About) → **Turn on sync with Google Drive** signs you in and combines both libraries. Page turns upload about 2 seconds after you stop. Other devices check every 30 seconds, and right away when the app comes back to the foreground.
- If another device moves ahead while a book is open, the reader offers "Another device is at Page 57 — Go there / Stay". It never jumps without asking.
