# Architecture

## Layout

- `src/`: React UI (Vite). Contains `PdfView` (pdf.js canvases with its transparent text layer for selecting, `pdfText.ts`), `EpubView` (epub.js, scrolled or paginated) and `Reader` (toolbar, bookmarks, highlights, remote-position banner). It talks to Rust only through `src/api.ts`.
- Highlights (`highlights.ts`): EPUB chapters paint them with the CSS Custom Highlight API (`::highlight()`), so they reflow with the text. PDF highlights are rectangles stored as fractions of the page and drawn over the page image. `HighlightToolbar` colours a selection or a tapped highlight. `MarksPanel` lists one book's highlights and bookmarks, and `HighlightsSheet` lists the whole library's, with search.
- `src-tauri/src/store.rs`: SQLite. `records` holds the synced state, `blobs` holds book bytes (a local cache) and `meta` holds per-device state (replica id, clock, sync settings, pending checkpoint).
- `src-tauri/src/library.rs`: import, remove, progress, bookmarks and highlights. Every write is stamped with a revision in the same transaction.
- `src-tauri/src/sync/`: `model.rs` (wire format and validation), `engine.rs` (the scheduler and sync algorithm, generic over a `Transport`), `drive.rs` (the Google Drive transport).
- `src-tauri/src/google/`: `desktop.rs` (browser, PKCE, loopback callback that answers with a styled page and an `org.reader.books://connected` link back to the app, refresh token in the OS keychain) and `android.rs`, which calls `gen/android/.../GoogleAuthPlugin.kt` (Play services `AuthorizationClient`).
- `src-tauri/src/updates.rs` finds the newest Android release on GitHub. `system_ui::install_update` passes it to `AppUpdatePlugin.kt`, which downloads and verifies the APK and opens Android's installer.

Tokens never enter the webview. The UI never sees Drive.

## Records

| kind       | id                        | value                                         |
|------------|---------------------------|-----------------------------------------------|
| `book`     | SHA-256 of the file       | title, author, format, size, addedAt          |
| `progress` | book id                   | location (PDF page / EPUB CFI), label, fraction, updatedAt |
| `bookmark` | random UUID               | bookId, location, label, createdAt            |
| `highlight` | random UUID              | bookId, location, text, color, label, fraction, createdAt |
| `favorite` | book id                   | at (when it was starred)                      |
| `finished` | book id                   | at (when it was finished)                     |
| `collection` | random UUID             | name, createdAt                               |
| `member`   | `<collection id>:<book id>` | at (when the book was added)                |

A highlight's `location` is an EPUB CFI range, or for PDFs the first page, a colon and JSON rectangles `[[page, x, y, width, height], …]`. `color` is one of yellow, green, blue, pink or purple. Highlighting the same passage again recolours it.

A book's place in a collection is its own `member` record, so adding books to a collection on two devices at once loses neither. Deleting a collection tombstones it and its members; the books stay. Favorites and finished are separate records, so starring a book on one device while finishing it on another can't overwrite either. Unstarring, or marking a book not finished, tombstones the record. Saving a position at the end of a book (a PDF's last page, or 99% of an EPUB) adds a `finished` record in the same transaction, unless one exists.

`value: null` is a tombstone. Removing a book tombstones the book, its bookmarks, highlights and marks. A device only drops its local copy of the bytes after it receives the tombstone. A missing record on the remote side never deletes anything.

## Sync protocol (ported from Tasker)

- **Revisions** are hybrid logical clocks `{time, counter, actor}`. They never go backwards locally, and receiving a record advances the clock. The later revision wins per record, and ties break on actor. Two revisions that are identical but carry different values reject the whole checkpoint.
- **Immutable per-device checkpoints.** Each publish is one Drive file that holds every record the device knows. The device uses a pre-generated Drive file id (`generateIds`), so a retry after an ambiguous failure re-verifies that same file instead of creating a duplicate. Devices never overwrite each other's files. Each device keeps its two newest checkpoints.
- **Order of a run:** list checkpoints, then read each device's newest unseen checkpoint, validate it fully, and apply it in one transaction. Next, upload any local books that are missing on Drive, publish the pending checkpoint, prune old ones, and finally download books this device lacks. Progress sync never waits for large book downloads.
- **Books** are Drive files tagged `kind=book, bookSha=<sha>`. Uploads use resumable upload and are verified with Drive's `sha256Checksum` and size. Downloads are verified against the SHA-256.
- **Scheduling:** one job at a time. Edits are debounced by 2 s, polling runs every 30 s, and failures back off exponentially up to 1 h. On Android, sync runs only while the app is visible. Every await is followed by a generation check, so pausing or going to the background cancels work before it is applied.
- **Read markers:** each device remembers the checkpoints it has read, together with the record kinds it knew then, so a version that learns new kinds reads them all once more.
- **Newer record kinds:** a checkpoint record whose kind this version doesn't know is skipped, so an older device keeps syncing everything else. Versions before 0.1.4 reject such checkpoints, so highlights need every device on 0.1.4 or later.
- **Account pinning:** the Drive `permissionId` is stored when sync is enabled. If a different account shows up, sync pauses instead of merging libraries.

## Limits

Books can be up to 512 MiB each. A checkpoint can be up to 16 MiB, which is on the order of 50k bookmarks. Book files on Drive are never garbage-collected, and removed books leave their Drive file behind (deferred, as in Tasker). Nothing is end-to-end encrypted.
