# Reader

A PDF and EPUB reader for macOS, Windows and Android that keeps your place on all of them. Import a book on one device and it shows up on the other. Your reading position, bookmarks and highlights follow you in both directions.

One Tauri 2 app builds for every platform. Books are stored as SQLite BLOBs. Sync uses your own Google Drive with Tasker's checkpoint protocol (see [architecture](docs/architecture.md)). There is no server and no hosting cost.

## Install

Download the latest release from [GitHub Releases](https://github.com/Carlos-err406/reader/releases/latest).

- **macOS** (Apple Silicon or Intel): open the `.dmg` and drag Reader to Applications. Reader isn't notarized by Apple, so the first time you have to right-click it and choose **Open**. After that it updates itself.
- **Windows** (10 or 11, 64-bit): run `Reader-…-windows-x64-setup.exe`. It installs for your user only, without asking for administrator rights. Reader isn't code-signed, so Windows SmartScreen may say "Windows protected your PC": choose **More info**, then **Run anyway**. After that it updates itself.
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
- The library has sections: All books, Reading, Favorites, Finished and Not started, in a sidebar on the Mac. On the phone, tap the library's title for a sheet with the sections, collections, sorting, highlights and settings. **Continue reading** at the top is the last unfinished book; tap it to pick up where you left off. Search filters by title and author, and the sort menu orders by recently read, title, author, date added or progress. A book's ⋯ (an action sheet on the phone; right-click works too on the Mac) stars it, files it in collections, marks it finished or not finished, or selects it. Reading to the end marks it finished. The star in the reader's header stars the open book.
- **Edit details…** in a book's ⋯ menu fixes its title or author and changes its cover (any image, shrunk to a small JPEG), or goes back to the cover in the file. Edits sync, and importing the same file again keeps them.
- **Collections** group books however you like, and a book can be in several. Create one with the **+** next to Collections, in the sidebar (Mac) or the library sheet (phone). Add books from their ⋯ menu → **Collections…**, and rename or delete a collection from the ⋯ next to its name. Deleting a collection keeps its books.
- **Select** (Mac) or a long press on a book (phone) selects several books (keep the finger down and drag to sweep over more, as in a photo gallery) to add them to a collection, favorite them or remove them at once.
- Books scroll continuously by default. **Aa** switches to page turns (edge taps, swipes, arrow keys) and sets the appearance (System, Light or Dark), the skin (Paper, Sepia, Slate or Contrast), the font (Literata, Serif, Sans, Hyperlegible or the book's own) and the text size. These settings are per device.
- The bookmark icon saves where you are. Select text (long-press on a phone) and pick one of five colours to highlight it, and tap a highlight to recolour, copy or delete it. The list icon opens the book's contents (chapters, with the one you're in marked; for books whose own list is a stub, it's built from the chapters' titles), highlights and bookmarks. The highlighter in the library lists every book's highlights, with search, and opens a book right at one. Scanned PDFs without a text layer can't be highlighted.
- On Android, while a book is open the volume buttons move through the book (down forward, up back; in the scroll layout a smooth glide of about two-thirds of a screen, so the last lines read stay in view) and the screen stays on until the book goes untouched for 10 minutes. Both can be switched off under **Aa → While reading**.
- Pull down in the library to sync right away.
- **Sync** (at the bottom of the sidebar on the Mac, in the library sheet on the phone) → **Turn on sync with Google Drive** signs you in and combines both libraries. Page turns upload about 2 seconds after you stop. Other devices check every 30 seconds, and right away when the app comes back to the foreground.
- If another device moves ahead while a book is open, the reader offers "Another device is at Page 57 — Go there / Stay". It never jumps without asking.
