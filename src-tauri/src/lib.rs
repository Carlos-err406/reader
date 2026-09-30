mod error;
mod google;
mod library;
mod store;
mod sync;
mod system_ui;
mod updates;

use error::{bail, Error, Result};
use google::{GoogleAuth, GoogleStatus};
use serde::Serialize;
use std::sync::Arc;
use store::{Book, Bookmark, Store};
use sync::drive::Drive;
use sync::engine::{Engine, Event, SyncStatus};
use sync::model::ProgressValue;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager, State};

struct AppState {
    store: Arc<Store>,
    auth: Arc<GoogleAuth>,
    sync: Arc<Engine<Drive>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    #[serde(flatten)]
    sync: SyncStatus,
    google: GoogleStatus,
    platform: &'static str,
    library: Library,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Library {
    books: u32,
    local_books: u32,
    bookmarks: u32,
}

impl AppState {
    fn status(&self) -> Status {
        let (books, local_books, bookmarks) = self.store.summary().unwrap_or_default();
        Status {
            library: Library { books, local_books, bookmarks },
            sync: self.sync.status(),
            google: self.auth.status(),
            platform: if cfg!(target_os = "android") { "android" } else { "desktop" },
        }
    }
}

#[tauri::command]
fn list_books(state: State<'_, AppState>) -> Result<Vec<Book>> {
    state.store.books()
}

/// The webview sends the file as a raw IPC body; metadata rides in a header.
#[tauri::command]
async fn import_book(request: Request<'_>, state: State<'_, AppState>) -> Result<Book> {
    let InvokeBody::Raw(bytes) = request.body() else { bail!("Expected the book's bytes") };
    let meta = request
        .headers()
        .get("x-book-meta")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| percent_encoding::percent_decode_str(v).decode_utf8().ok())
        .ok_or_else(|| Error::new("Missing book details"))?;
    let book = library::import(&state.store, bytes, serde_json::from_str(&meta)?)?;
    state.sync.local_changed();
    Ok(book)
}

#[tauri::command]
async fn read_book(id: String, state: State<'_, AppState>) -> Result<Response> {
    match state.store.blob(&id)? {
        Some(bytes) => Ok(Response::new(bytes)),
        None => bail!("This book hasn't finished downloading yet"),
    }
}

/// Raw IPC body: the rendered cover image; the book id rides in a header.
#[tauri::command]
async fn save_cover(request: Request<'_>, state: State<'_, AppState>) -> Result<()> {
    let InvokeBody::Raw(image) = request.body() else { bail!("Expected the cover image") };
    let book = request.headers().get("x-book-id").and_then(|v| v.to_str().ok()).unwrap_or_default();
    library::set_cover(&state.store, book, image)
}

#[tauri::command]
async fn read_cover(id: String, state: State<'_, AppState>) -> Result<Response> {
    match state.store.cover(&id)? {
        Some(image) => Ok(Response::new(image)),
        None => bail!("No cover"),
    }
}

#[tauri::command]
fn remove_book(id: String, state: State<'_, AppState>) -> Result<()> {
    library::remove(&state.store, &id)?;
    state.sync.local_changed();
    Ok(())
}

#[tauri::command]
fn get_progress(book_id: String, state: State<'_, AppState>) -> Result<Option<ProgressValue>> {
    state.store.progress(&book_id)
}

#[tauri::command]
fn set_progress(book_id: String, location: String, label: String, fraction: f64, state: State<'_, AppState>) -> Result<()> {
    if library::set_progress(&state.store, &book_id, location, label, fraction)?.is_some() {
        state.sync.local_changed();
    }
    Ok(())
}

#[tauri::command]
fn list_bookmarks(book_id: String, state: State<'_, AppState>) -> Result<Vec<Bookmark>> {
    state.store.bookmarks(&book_id)
}

#[tauri::command]
fn add_bookmark(book_id: String, location: String, label: String, state: State<'_, AppState>) -> Result<Bookmark> {
    let bookmark = library::add_bookmark(&state.store, &book_id, location, label)?;
    state.sync.local_changed();
    Ok(bookmark)
}

#[tauri::command]
fn remove_bookmark(id: String, state: State<'_, AppState>) -> Result<()> {
    library::remove_bookmark(&state.store, &id)?;
    state.sync.local_changed();
    Ok(())
}

#[tauri::command]
fn sync_status(state: State<'_, AppState>) -> Status {
    state.status()
}

/// One action for the user: sign in if needed, then enable sync for that account.
#[tauri::command]
async fn sync_enable(state: State<'_, AppState>) -> Result<Status> {
    if !state.auth.status().connected {
        state.auth.connect().await?;
    }
    state.sync.enable().await?;
    Ok(state.status())
}

#[tauri::command]
fn sync_pause(state: State<'_, AppState>) -> Result<Status> {
    state.sync.pause()?;
    Ok(state.status())
}

#[tauri::command]
fn sync_now(state: State<'_, AppState>) -> Status {
    state.sync.sync_now();
    state.status()
}

#[tauri::command]
async fn google_disconnect(state: State<'_, AppState>) -> Result<Status> {
    state.sync.forget_account()?;
    state.auth.disconnect().await?;
    Ok(state.status())
}

/// Android syncs only while visible. Desktop keeps syncing and refreshes on focus.
#[tauri::command]
fn app_foreground(visible: bool, state: State<'_, AppState>) {
    if cfg!(target_os = "android") {
        state.sync.foreground(visible);
    } else if visible {
        state.sync.sync_now();
    }
}

/// Android only: a newer GitHub release, if there is one.
#[tauri::command]
async fn check_apk_update() -> Result<Option<updates::Available>> {
    updates::check().await
}

/// Opens the release APK in the system browser, which downloads it and offers to install.
#[tauri::command]
fn open_apk(url: String, app: tauri::AppHandle) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    if !updates::is_release_download(&url) {
        bail!("Not a Reader release");
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| Error::new(e.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(not(target_os = "android"))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(google::plugin()).plugin(system_ui::plugin());
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Arc::new(Store::open(&dir.join("reader.db"))?);

            #[cfg(not(target_os = "android"))]
            let platform = {
                use tauri_plugin_opener::OpenerExt;
                let handle = app.handle().clone();
                google::Platform::new(
                    &app.path().app_config_dir()?,
                    Box::new(move |url| {
                        handle.opener().open_url(url, None::<&str>).map_err(|e| Error::new(e.to_string()))
                    }),
                )
            };
            #[cfg(target_os = "android")]
            let platform = google::Platform::new(app.handle(), store.clone());

            let auth = Arc::new(GoogleAuth::new(platform));
            let handle = app.handle().clone();
            let engine = Engine::new(
                store.clone(),
                Drive::new(auth.clone()),
                Box::new(move |event| {
                    let _ = match event {
                        Event::Status => handle.emit("sync-status", ()),
                        Event::Changed(changed) => handle.emit("records-changed", changed),
                    };
                }),
            );
            tauri::async_runtime::spawn(engine.clone().run());
            app.manage(AppState { store, auth, sync: engine });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_books,
            import_book,
            read_book,
            remove_book,
            save_cover,
            read_cover,
            get_progress,
            set_progress,
            list_bookmarks,
            add_bookmark,
            remove_bookmark,
            sync_status,
            sync_enable,
            sync_pause,
            sync_now,
            google_disconnect,
            app_foreground,
            system_ui::set_immersive,
            check_apk_update,
            open_apk,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Reader");
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    #[test]
    fn imports_a_book_sent_as_raw_ipc_bytes() {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![import_book, list_books])
            .build(mock_context(noop_assets()))
            .unwrap();
        let store = Arc::new(Store::memory().unwrap());
        let dir = std::env::temp_dir().join(format!("reader-test-{}", uuid::Uuid::new_v4()));
        let auth = Arc::new(GoogleAuth::new(google::Platform::new(&dir, Box::new(|_| Ok(())))));
        let sync = Engine::new(store.clone(), Drive::new(auth.clone()), Box::new(|_| {}));
        app.manage(AppState { store: store.clone(), auth, sync });
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

        let mut headers = tauri::http::HeaderMap::new();
        let meta = percent_encoding::utf8_percent_encode(r#"{"title":"Café Guide","author":null}"#, percent_encoding::NON_ALPHANUMERIC);
        headers.insert("x-book-meta", meta.to_string().parse().unwrap());
        let response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "import_book".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Raw(b"%PDF-1.7 tiny".to_vec()),
                headers,
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .unwrap();
        let book: serde_json::Value = response.deserialize().unwrap();
        assert_eq!(book["title"], "Café Guide");
        assert_eq!(book["format"], "pdf");
        assert_eq!(store.books().unwrap().len(), 1);
    }
}
