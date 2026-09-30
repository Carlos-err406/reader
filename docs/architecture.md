# Architecture

## Layout

- `src/`: React UI (Vite). Contains `PdfView` (pdf.js, one canvas page at a time), `EpubView` (epub.js, paginated) and `Reader` (toolbar, bookmarks, remote-position banner). It talks to Rust only through `src/api.ts`.
- `src-tauri/src/store.rs`: SQLite. `records` holds the synced state, `blobs` holds book bytes (a local cache) and `meta` holds per-device state (replica id, clock, sync settings, pending checkpoint).
- `src-tauri/src/library.rs`: import, remove, progress and bookmarks. Every write is stamped with a revision in the same transaction.
- `src-tauri/src/sync/`: `model.rs` (wire format and validation), `engine.rs` (the scheduler and sync algorithm, generic over a `Transport`), `drive.rs` (the Google Drive transport).
- `src-tauri/src/google/`: `desktop.rs` (browser, PKCE, loopback callback, refresh token in the OS keychain) and `android.rs`, which calls `gen/android/.../GoogleAuthPlugin.kt` (Play services `AuthorizationClient`).

Tokens never enter the webview. The UI never sees Drive.

## Records

| kind       | id                        | value                                         |
|------------|---------------------------|-----------------------------------------------|
| `book`     | SHA-256 of the file       | title, author, format, size, addedAt          |
| `progress` | book id                   | location (PDF page / EPUB CFI), label, fraction, updatedAt |
| `bookmark` | random UUID               | bookId, location, label, createdAt            |

`value: null` is a tombstone. Removing a book tombstones the book and its bookmarks. A device only drops its local copy of the bytes after it receives the tombstone. A missing record on the remote side never deletes anything.

## Sync protocol (ported from Tasker)

- **Revisions** are hybrid logical clocks `{time, counter, actor}`. They never go backwards locally, and receiving a record advances the clock. The later revision wins per record, and ties break on actor. Two revisions that are identical but carry different values reject the whole checkpoint.
- **Immutable per-device checkpoints.** Each publish is one Drive file that holds every record the device knows. The device uses a pre-generated Drive file id (`generateIds`), so a retry after an ambiguous failure re-verifies that same file instead of creating a duplicate. Devices never overwrite each other's files. Each device keeps its two newest checkpoints.
- **Order of a run:** list checkpoints, then read each device's newest unseen checkpoint, validate it fully, and apply it in one transaction. Next, upload any local books that are missing on Drive, publish the pending checkpoint, prune old ones, and finally download books this device lacks. Progress sync never waits for large book downloads.
- **Books** are Drive files tagged `kind=book, bookSha=<sha>`. Uploads use resumable upload and are verified with Drive's `sha256Checksum` and size. Downloads are verified against the SHA-256.
- **Scheduling:** one job at a time. Edits are debounced by 2 s, polling runs every 30 s, and failures back off exponentially up to 1 h. On Android, sync runs only while the app is visible. Every await is followed by a generation check, so pausing or going to the background cancels work before it is applied.
- **Account pinning:** the Drive `permissionId` is stored when sync is enabled. If a different account shows up, sync pauses instead of merging libraries.

## Limits

Books can be up to 512 MiB each. A checkpoint can be up to 16 MiB, which is on the order of 50k bookmarks. Book files on Drive are never garbage-collected, and removed books leave their Drive file behind (deferred, as in Tasker). Nothing is end-to-end encrypted.
