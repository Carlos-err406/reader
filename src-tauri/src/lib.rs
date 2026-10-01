mod error;
mod google;
mod library;
mod opened;
mod store;
mod sync;
mod system_ui;
mod updates;

use error::{bail, Error, Result};
use google::{GoogleAuth, GoogleStatus};
use serde::Serialize;
use std::sync::Arc;
use store::{Book, Bookmark, Collection, Highlight, Store};
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
    highlights: u32,
}

impl AppState {
    fn status(&self) -> Status {
        let (books, local_books, bookmarks, highlights) = self.store.summary().unwrap_or_default();
        Status {
            library: Library { books, local_books, bookmarks, highlights },
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
/// A command's binary body. Desktop webviews send it raw; Android's can only send text, so Tauri
/// sends the bytes there as a JSON array of numbers.
fn body_bytes<'a>(request: &'a Request<'_>) -> Result<std::borrow::Cow<'a, [u8]>> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(std::borrow::Cow::Borrowed(bytes)),
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()).ok_or_else(|| Error::new("Expected bytes")))
            .collect::<Result<Vec<u8>>>()
            .map(std::borrow::Cow::Owned),
        _ => bail!("Expected bytes"),
    }
}

#[tauri::command]
async fn import_book(request: Request<'_>, state: State<'_, AppState>) -> Result<Book> {
    let bytes = body_bytes(&request)?;
    let bytes = bytes.as_ref();
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
    let image = body_bytes(&request)?;
    let image = image.as_ref();
    let book = request.headers().get("x-book-id").and_then(|v| v.to_str().ok()).unwrap_or_default();
    library::set_cover(&state.store, book, image)
}

/// The chosen cover if there is one, else the one this device drew from the book.
#[tauri::command]
async fn read_cover(id: String, state: State<'_, AppState>) -> Result<Response> {
    match state.store.custom_cover(&id)?.or(state.store.cover(&id)?) {
        Some(image) => Ok(Response::new(image)),
        None => bail!("No cover"),
    }
}

/// Chooses a cover for a book from the raw image body; an empty body goes back to the book's own.
#[tauri::command]
async fn set_book_cover(request: Request<'_>, state: State<'_, AppState>) -> Result<()> {
    let image = body_bytes(&request)?;
    let book = request.headers().get("x-book-id").and_then(|v| v.to_str().ok()).unwrap_or_default();
    library::set_custom_cover(&state.store, book, (!image.is_empty()).then_some(image.as_ref()))?;
    state.sync.local_changed();
    Ok(())
}

#[tauri::command]
fn edit_book(book_id: String, title: String, author: String, state: State<'_, AppState>) -> Result<()> {
    library::set_details(&state.store, &book_id, &title, &author)?;
    state.sync.local_changed();
    Ok(())
}

#[tauri::command]
fn remove_book(id: String, state: State<'_, AppState>) -> Result<()> {
    library::remove(&state.store, &id)?;
    state.sync.local_changed();
    Ok(())
}

/// Imports a book opened with Reader from its own copy, so the bytes don't travel back through
/// the webview (slow on Android, where they'd go as text). The webview sends the details it read.
#[tauri::command]
async fn import_opened_file(
    id: u32,
    meta: library::ImportMeta,
    opened: State<'_, opened::Opened>,
    state: State<'_, AppState>,
) -> Result<Book> {
    let bytes = opened.finish(id)?;
    let book = library::import(&state.store, &bytes, meta)?;
    state.sync.local_changed();
    Ok(book)
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
fn set_favorite(book_id: String, on: bool, state: State<'_, AppState>) -> Result<()> {
    if library::set_mark(&state.store, sync::model::Kind::Favorite, &book_id, on)? {
        state.sync.local_changed();
    }
    Ok(())
}

#[tauri::command]
fn set_finished(book_id: String, on: bool, state: State<'_, AppState>) -> Result<()> {
    if library::set_mark(&state.store, sync::model::Kind::Finished, &book_id, on)? {
        state.sync.local_changed();
    }
    Ok(())
}

#[tauri::command]
fn list_collections(state: State<'_, AppState>) -> Result<Vec<Collection>> {
    state.store.collections()
}

#[tauri::command]
fn create_collection(name: String, state: State<'_, AppState>) -> Result<Collection> {
    let collection = library::create_collection(&state.store, &name)?;
    state.sync.local_changed();
    Ok(collection)
}

#[tauri::command]
fn rename_collection(id: String, name: String, state: State<'_, AppState>) -> Result<()> {
    library::rename_collection(&state.store, &id, &name)?;
    state.sync.local_changed();
    Ok(())
}

#[tauri::command]
fn delete_collection(id: String, state: State<'_, AppState>) -> Result<()> {
    library::delete_collection(&state.store, &id)?;
    state.sync.local_changed();
    Ok(())
}

#[tauri::command]
fn set_in_collection(collection_id: String, book_id: String, on: bool, state: State<'_, AppState>) -> Result<()> {
    if library::set_member(&state.store, &collection_id, &book_id, on)? {
        state.sync.local_changed();
    }
    Ok(())
}

/// One book's highlights, or (without `book_id`) every book's.
#[tauri::command]
fn list_highlights(book_id: Option<String>, state: State<'_, AppState>) -> Result<Vec<Highlight>> {
    state.store.highlights(book_id.as_deref())
}

#[tauri::command]
fn add_highlight(book_id: String, highlight: library::NewHighlight, state: State<'_, AppState>) -> Result<Highlight> {
    let highlight = library::add_highlight(&state.store, &book_id, highlight)?;
    state.sync.local_changed();
    Ok(highlight)
}

#[tauri::command]
fn recolor_highlight(id: String, color: sync::model::Color, state: State<'_, AppState>) -> Result<Highlight> {
    let highlight = library::set_highlight_color(&state.store, &id, color)?;
    state.sync.local_changed();
    Ok(highlight)
}

#[tauri::command]
fn remove_highlight(id: String, state: State<'_, AppState>) -> Result<()> {
    library::remove_highlight(&state.store, &id)?;
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

fn is_github_link(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some("github.com") && u.username().is_empty())
}

/// Opens a page of the project on GitHub (source, license, credits) in the browser.
/// Nothing else: the webview can't use this to open arbitrary sites.
#[tauri::command]
fn open_link(url: String, app: tauri::AppHandle) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    if !is_github_link(&url) {
        bail!("Only GitHub links can be opened");
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| Error::new(e.to_string()))
}

/// Android only: a newer GitHub release, if there is one.
#[tauri::command]
async fn check_apk_update() -> Result<Option<updates::Available>> {
    updates::check().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Files opened with Reader can arrive before anything else is set up.
    let builder = tauri::Builder::default().manage(opened::Opened::default());
    // First of all plugins: a second launch (a deep link back from the Google sign-in page)
    // only brings this window forward; the deep-link plugin gets its URL.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        // Opening a book with Reader while it runs starts a second copy with the file's path.
        app.state::<opened::Opened>().add_args(args.into_iter().skip(1), std::path::Path::new(&cwd));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    let builder = builder.plugin(tauri_plugin_opener::init());
    #[cfg(not(target_os = "android"))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init());
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(google::plugin())
        .plugin(system_ui::plugin())
        .plugin(system_ui::updater())
        .plugin(opened::android::plugin());
    builder
        .setup(|app| {
            // Windows and Linux start Reader with the paths of the books it was asked to open.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            app.state::<opened::Opened>().add_args(std::env::args().skip(1), &std::env::current_dir()?);
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

            // The Google sign-in page sends the browser to org.reader.books://connected; the
            // browser asks "Open Reader?" and the system hands the link here (on Windows, through
            // the single-instance plugin). Bring the window back to the front.
            #[cfg(not(target_os = "android"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |_event| {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            }
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
            set_favorite,
            set_finished,
            set_book_cover,
            edit_book,
            list_collections,
            create_collection,
            rename_collection,
            delete_collection,
            set_in_collection,
            list_highlights,
            add_highlight,
            recolor_highlight,
            remove_highlight,
            sync_status,
            sync_enable,
            sync_pause,
            sync_now,
            google_disconnect,
            app_foreground,
            system_ui::set_immersive,
            system_ui::keep_awake,
            system_ui::volume_keys,
            check_apk_update,
            system_ui::install_update,
            open_link,
            opened::take_opened_files,
            opened::read_opened_file,
            import_opened_file,
            opened::watch_opened_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Reader")
        .run(|_app, _event| {
            // macOS hands over books opened with Reader (Open With, a double-click) as events.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                use tauri::Manager;
                let opened = _app.state::<opened::Opened>();
                for path in urls.iter().filter_map(|url| url.to_file_path().ok()) {
                    opened.add(path, None, false);
                }
            }
        });
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    #[test]
    fn opens_only_github_links() {
        assert!(is_github_link("https://github.com/Carlos-err406/reader/blob/main/LICENSE"));
        assert!(!is_github_link("http://github.com/Carlos-err406/reader"));
        assert!(!is_github_link("https://github.com.evil.example/x"));
        assert!(!is_github_link("https://evil.example/?github.com"));
        assert!(!is_github_link("https://github.com@evil.example/"));
        assert!(!is_github_link("file:///etc/passwd"));
        assert!(!is_github_link("javascript:alert(1)"));
    }

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
