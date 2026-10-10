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

- **Add book** imports PDFs and EPUBs. On the Mac you can also drag books from Finder into the window. Opening a book with Reader from elsewhere adds it and opens it: on Android, tap a PDF or EPUB in a file manager or Downloads, or **Share** it to Reader; on the Mac, **Open With → Reader** or double-click an EPUB (Reader doesn't take over PDFs from Preview); on Windows, double-click an EPUB or use **Open with** (Reader registers EPUB only, so it doesn't replace your PDF viewer). A book's identity is the SHA-256 of its bytes, so importing the same file on both devices gives you one book.
- The library has sections: All books, Reading, Favorites, Finished and Not started, in a sidebar on the Mac. On the phone, tap the library's title for a sheet with the sections, tags, sorting, highlights and settings. **Continue reading** at the top is the last unfinished book; tap it to pick up where you left off. Search filters by title and author, and the sort menu orders by recently read, title, author, date added or progress. A book's ⋯ (an action sheet on the phone; right-click works too on the Mac) stars it, tags it, marks it finished or not finished, or selects it. Reading to the end marks it finished. In the reader, **⋯** in the toolbar stars the open book.
- **Edit details…** in a book's ⋯ menu fixes its title or author and changes its cover (any image, shrunk to a small JPEG), or goes back to the cover in the file. Edits sync, and importing the same file again keeps them.
- **Tags** group books however you like, and a book can have several. Create one with the **+** next to Tags, in the sidebar (Mac) or the library sheet (phone), and tag books from their ⋯ menu → **Tags…**. Tap tags to filter by them: pick several and only books with all of them show, within the section you're in (Reading, Finished…). **Clear** drops the filter. With one tag picked, the ⋯ next to the title renames or deletes it. Deleting a tag keeps its books.
- **Select** (Mac) or a long press on a book (phone) selects several books (keep the finger down and drag to sweep over more, as in a photo gallery) to tag them, favorite them or remove them at once.
- In the reader, tap the page to show or hide its controls: the title at the top, and at the bottom where you are, the time left and the tools (contents, search, read aloud, **Aa** and **⋯** for bookmarks, favorites and, on desktop, full screen).
- Books scroll continuously by default. **Aa** switches to page turns (edge taps, swipes, arrow keys) and sets the appearance (System, Light or Dark), the skin (Paper, Sepia, Slate or Contrast), the font (Literata, Serif, Sans, Hyperlegible or the book's own) and the text size (for a PDF, its zoom). These settings are per device.
- **⋯ → Bookmark this page** saves where you are. Select text (long-press on a phone) and pick one of five colours to highlight it, and tap a highlight to recolour, copy or delete it. The list icon opens the book's contents (chapters, with the one you're in marked; for books whose own list is a stub, it's built from the chapters' titles), highlights and bookmarks. The highlighter in the library lists every book's highlights, with search, and opens a book right at one. Scanned PDFs without a text layer can't be highlighted.
- The magnifier in the reader (⌘F or Ctrl+F on desktop) searches the whole book: case and accents don't matter, and each match is listed with the text around it and its chapter or page. Tapping one shows it marked on the page, and a bar at the bottom steps through the rest (⌘G and ⇧⌘G on desktop).
- The headphones in the reader's toolbar read the book aloud from the top of the page, with the device's own voices: the sentence being read is marked and the pages turn to follow it. The bar that appears pauses, changes the speed (0.75× to 2×) and picks a voice (one is remembered per language, per device); **Get more voices** on Android opens the phone's screen for adding languages. How the voices sound, and which languages there are, depends on the device. Reading aloud stops when the book closes, and listening doesn't count toward the reading speed behind the time left.
- On Android, while a book is open the volume buttons move through the book (down forward, up back; in the scroll layout a smooth glide of about two-thirds of a screen, so the last lines read stay in view) and the screen stays on until the book goes untouched for 10 minutes. Both can be switched off under **Aa → While reading**. While a book is read aloud, the volume buttons set the volume again.
- Pull down in the library to sync right away.
- **Sync** (at the bottom of the sidebar on the Mac, in the library sheet on the phone) → **Turn on sync with Google Drive** signs you in and combines both libraries. Page turns upload about 2 seconds after you stop. Other devices check every 30 seconds, and right away when the app comes back to the foreground.
- If another device moves ahead while a book is open, the reader offers "Another device is at Page 57 — Go there / Stay". It never jumps without asking.
