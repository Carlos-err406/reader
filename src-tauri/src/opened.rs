//! Books the system hands to Reader: "Open With" and double-clicks on the desktop, a tap in a
//! file manager or "Share" on Android. The webview only ever reads files from this list, by id,
//! until the file is imported.
use crate::error::{bail, Error, Result};
use crate::sync::model::MAX_BOOK_BYTES;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Channel;

#[derive(Clone, Debug, Serialize)]
pub struct OpenedFile {
    pub id: u32,
    pub name: String,
}

struct Entry {
    path: PathBuf,
    name: String,
    /// Android's are copies in the app's cache, removed once read.
    temporary: bool,
}

#[derive(Default)]
pub struct Opened {
    files: Mutex<HashMap<u32, Entry>>,
    /// Not yet handed to the webview.
    waiting: Mutex<Vec<u32>>,
    next: Mutex<u32>,
    /// Told when files arrive while the app runs.
    watcher: Mutex<Option<Channel<()>>>,
}

impl Opened {
    pub fn add(&self, path: PathBuf, name: Option<String>, temporary: bool) {
        let name = name.unwrap_or_else(|| {
            path.file_name().map_or_else(|| "Book".to_owned(), |n| n.to_string_lossy().into_owned())
        });
        let id = {
            let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
            *next += 1;
            *next
        };
        self.files.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Entry { path, name, temporary });
        self.waiting.lock().unwrap_or_else(|e| e.into_inner()).push(id);
        if let Some(watcher) = self.watcher.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = watcher.send(());
        }
    }

    /// Paths from a launch's arguments (Windows and Linux pass opened files that way).
    pub fn add_args<I: IntoIterator<Item = String>>(&self, args: I, cwd: &Path) {
        for arg in args {
            if arg.starts_with('-') {
                continue;
            }
            let path = cwd.join(&arg);
            let book = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf") || e.eq_ignore_ascii_case("epub"));
            if book && path.is_file() {
                self.add(path, None, false);
            }
        }
    }

    pub fn watch(&self, channel: Channel<()>) {
        *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(channel);
    }

    pub fn take(&self) -> Vec<OpenedFile> {
        let ids = std::mem::take(&mut *self.waiting.lock().unwrap_or_else(|e| e.into_inner()));
        let files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        ids.into_iter()
            .filter_map(|id| files.get(&id).map(|f| OpenedFile { id, name: f.name.clone() }))
            .collect()
    }

    /// The file's bytes, for the webview to read its title, author and cover.
    pub fn read(&self, id: u32) -> Result<Vec<u8>> {
        let path = match self.files.lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
            Some(entry) => entry.path.clone(),
            None => bail!("That file is no longer available"),
        };
        read_book(&path)
    }

    /// The file's bytes one last time, for importing it; it's forgotten afterwards (and a
    /// temporary copy deleted).
    pub fn finish(&self, id: u32) -> Result<Vec<u8>> {
        let Some(entry) = self.files.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) else {
            bail!("That file is no longer available");
        };
        let result = read_book(&entry.path);
        if entry.temporary {
            let _ = std::fs::remove_file(&entry.path);
        }
        result
    }
}

fn read_book(path: &Path) -> Result<Vec<u8>> {
    if std::fs::metadata(path)?.len() > MAX_BOOK_BYTES {
        bail!("Books must be smaller than {} MiB", MAX_BOOK_BYTES / 1024 / 1024);
    }
    std::fs::read(path).map_err(Error::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_handed_over_once_and_read_once() {
        let dir = std::env::temp_dir().join(format!("reader-opened-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Dune.epub"), b"PK book").unwrap();
        std::fs::write(dir.join("notes.txt"), b"not a book").unwrap();
        let opened = Opened::default();
        opened.add_args(["--flag".into(), "Dune.epub".into(), "notes.txt".into(), "missing.pdf".into()], &dir);
        let files = opened.take();
        assert_eq!(files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["Dune.epub"]);
        assert!(opened.take().is_empty());
        assert_eq!(opened.read(files[0].id).unwrap(), b"PK book");
        assert_eq!(opened.finish(files[0].id).unwrap(), b"PK book");
        assert!(opened.read(files[0].id).is_err());
        assert!(opened.finish(999).is_err());

        let copy = dir.join("copy.pdf");
        std::fs::write(&copy, b"%PDF").unwrap();
        opened.add(copy.clone(), Some("Shared.pdf".into()), true);
        let shared = opened.take();
        assert_eq!(shared[0].name, "Shared.pdf");
        opened.read(shared[0].id).unwrap();
        assert!(copy.exists());
        opened.finish(shared[0].id).unwrap();
        assert!(!copy.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// Android: OpenedFilesPlugin.kt receives the intents and keeps copies until they're taken.
#[cfg(target_os = "android")]
pub mod android {
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{Manager, Wry};

    pub struct Handle(pub PluginHandle<Wry>);

    pub fn plugin() -> TauriPlugin<Wry> {
        Builder::new("opened-files")
            .setup(|app, api| {
                app.manage(Handle(api.register_android_plugin("org.reader.books", "OpenedFilesPlugin")?));
                Ok(())
            })
            .build()
    }
}

#[derive(serde::Deserialize)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct Copied {
    path: String,
    name: String,
}

/// The files opened with Reader since the last call: their ids and names.
#[tauri::command]
pub async fn take_opened_files(app: tauri::AppHandle, opened: tauri::State<'_, Opened>) -> Result<Vec<OpenedFile>> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        #[derive(serde::Deserialize)]
        struct Taken {
            files: Vec<Copied>,
        }
        let handle = app.state::<android::Handle>().0.clone();
        let taken = tauri::async_runtime::spawn_blocking(move || handle.run_mobile_plugin::<Taken>("takeOpened", ()))
            .await
            .map_err(|e| Error::new(e.to_string()))?
            .map_err(|e| Error::new(e.to_string()))?;
        for file in taken.files {
            opened.add(file.path.into(), Some(file.name), true);
        }
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(opened.take())
}

#[tauri::command]
pub async fn read_opened_file(id: u32, opened: tauri::State<'_, Opened>) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(opened.read(id)?))
}

/// `channel` is told whenever more files are opened while the app runs.
#[tauri::command]
pub async fn watch_opened_files(channel: Channel<()>, app: tauri::AppHandle, opened: tauri::State<'_, Opened>) -> Result<()> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let handle = app.state::<android::Handle>().0.clone();
        let theirs = channel.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // The channel serialises to its id, which the Kotlin side sends to.
            handle.run_mobile_plugin::<serde_json::Value>("watchOpened", serde_json::json!({ "channel": theirs }))
        })
        .await
        .map_err(|e| Error::new(e.to_string()))?
        .map_err(|e| Error::new(e.to_string()))?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
    opened.watch(channel);
    Ok(())
}
