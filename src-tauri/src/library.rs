//! Local library operations. Each edit is stamped for sync in the same transaction.
use crate::error::{bail, Result};
use crate::store::{now_ms, Book, Bookmark, Highlight, Store};
use crate::sync::model::{
    is_sha256, validate_book, validate_bookmark, validate_highlight, validate_progress, BookValue,
    BookmarkValue, Color, Format, HighlightValue, Kind, ProgressValue, MAX_BOOK_BYTES, MAX_HIGHLIGHT_TEXT,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Trust the bytes, not the file name.
pub fn detect_format(bytes: &[u8]) -> Result<Format> {
    if bytes.starts_with(b"%PDF-") {
        return Ok(Format::Pdf);
    }
    // EPUB OCF: a ZIP whose first entry is an uncompressed "mimetype" file.
    if bytes.starts_with(b"PK\x03\x04")
        && bytes.get(30..38) == Some(b"mimetype")
        && bytes.get(38..58) == Some(b"application/epub+zip")
    {
        return Ok(Format::Epub);
    }
    bail!("Only PDF and EPUB books are supported")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMeta {
    pub title: String,
    pub author: Option<String>,
}

fn clip(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

pub fn import(store: &Store, bytes: &[u8], meta: ImportMeta) -> Result<Book> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_BOOK_BYTES {
        bail!("Books must be smaller than {} MiB", MAX_BOOK_BYTES / 1024 / 1024);
    }
    let format = detect_format(bytes)?;
    let id = sha256(bytes);
    let title = match clip(&meta.title, 500) {
        t if t.is_empty() => "Untitled".to_owned(),
        t => t,
    };
    let author = meta.author.map(|a| clip(&a, 500)).filter(|a| !a.is_empty());
    // Re-importing keeps the original added time, and revives a deleted book.
    let added_at = store.book(&id)?.map_or_else(now_ms, |b| b.added_at);
    let value = BookValue { title, author, format, size: bytes.len() as u64, added_at };
    validate_book(&value)?;
    store.put_blob(&id, bytes)?;
    store.stamp(vec![(Kind::Book, id.clone(), Some(serde_json::to_value(&value)?))])?;
    let progress = store.progress(&id)?;
    // The webview renders the cover right after importing.
    Ok(Book { id, value, available: true, progress, cover: None })
}

fn require_book(store: &Store, id: &str) -> Result<BookValue> {
    if !is_sha256(id) {
        bail!("Unknown book");
    }
    match store.book(id)? {
        Some(book) => Ok(book),
        None => bail!("This book was removed"),
    }
}

const MAX_COVER_BYTES: usize = 2 * 1024 * 1024;

/// A JPEG or PNG thumbnail rendered by the webview, or empty for "no cover".
pub fn set_cover(store: &Store, book: &str, image: &[u8]) -> Result<()> {
    require_book(store, book)?;
    let image_like = image.starts_with(b"\xff\xd8\xff") || image.starts_with(b"\x89PNG\r\n\x1a\n");
    if image.len() > MAX_COVER_BYTES || !(image.is_empty() || image_like) {
        bail!("Covers must be a JPEG or PNG under 2 MiB");
    }
    store.set_cover(book, image)
}

pub fn remove(store: &Store, id: &str) -> Result<()> {
    require_book(store, id)?;
    let mut edits = vec![(Kind::Book, id.to_owned(), None)];
    edits.extend(store.bookmarks(id)?.into_iter().map(|b| (Kind::Bookmark, b.id, None)));
    edits.extend(store.highlights(Some(id))?.into_iter().map(|h| (Kind::Highlight, h.id, None)));
    store.stamp(edits)?;
    store.release_deleted_blobs()?;
    Ok(())
}

pub fn set_progress(store: &Store, book: &str, location: String, label: String, fraction: f64) -> Result<Option<ProgressValue>> {
    require_book(store, book)?;
    let current = store.progress(book)?;
    if current.as_ref().is_some_and(|p| p.location == location && p.label == label) {
        return Ok(None);
    }
    let value = ProgressValue { location, label, fraction: fraction.clamp(0.0, 1.0), updated_at: now_ms() };
    validate_progress(&value)?;
    store.stamp(vec![(Kind::Progress, book.to_owned(), Some(serde_json::to_value(&value)?))])?;
    Ok(Some(value))
}

pub fn add_bookmark(store: &Store, book: &str, location: String, label: String) -> Result<Bookmark> {
    require_book(store, book)?;
    if let Some(existing) = store.bookmarks(book)?.into_iter().find(|b| b.value.location == location) {
        return Ok(existing);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let value = BookmarkValue { book_id: book.to_owned(), location, label, created_at: now_ms() };
    validate_bookmark(&value)?;
    store.stamp(vec![(Kind::Bookmark, id.clone(), Some(serde_json::to_value(&value)?))])?;
    Ok(Bookmark { id, value })
}

pub fn remove_bookmark(store: &Store, id: &str) -> Result<()> {
    match store.record(Kind::Bookmark, id)? {
        Some(record) if record.value.is_some() => store.stamp(vec![(Kind::Bookmark, id.to_owned(), None)]),
        _ => Ok(()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHighlight {
    pub location: String,
    pub text: String,
    pub color: Color,
    pub label: String,
    pub fraction: f64,
}

/// Highlighting the same passage again recolours it instead of stacking a second one.
pub fn add_highlight(store: &Store, book: &str, new: NewHighlight) -> Result<Highlight> {
    require_book(store, book)?;
    if let Some(existing) = store.highlights(Some(book))?.into_iter().find(|h| h.value.location == new.location) {
        return set_highlight_color(store, &existing.id, new.color);
    }
    // Collapse the selection's line breaks and runs of spaces for the list.
    let text: String = new.text.split_whitespace().collect::<Vec<_>>().join(" ");
    let value = HighlightValue {
        book_id: book.to_owned(),
        location: new.location,
        text: clip(&text, MAX_HIGHLIGHT_TEXT),
        color: new.color,
        label: new.label,
        fraction: new.fraction.clamp(0.0, 1.0),
        created_at: now_ms(),
    };
    validate_highlight(&value)?;
    let id = uuid::Uuid::new_v4().to_string();
    store.stamp(vec![(Kind::Highlight, id.clone(), Some(serde_json::to_value(&value)?))])?;
    Ok(Highlight { id, value })
}

fn highlight(store: &Store, id: &str) -> Result<HighlightValue> {
    match store.record(Kind::Highlight, id)?.and_then(|record| record.value) {
        Some(value) => Ok(serde_json::from_value(value)?),
        None => bail!("This highlight was removed"),
    }
}

pub fn set_highlight_color(store: &Store, id: &str, color: Color) -> Result<Highlight> {
    let mut value = highlight(store, id)?;
    if value.color != color {
        value.color = color;
        store.stamp(vec![(Kind::Highlight, id.to_owned(), Some(serde_json::to_value(&value)?))])?;
    }
    Ok(Highlight { id: id.to_owned(), value })
}

pub fn remove_highlight(store: &Store, id: &str) -> Result<()> {
    match store.record(Kind::Highlight, id)? {
        Some(record) if record.value.is_some() => store.stamp(vec![(Kind::Highlight, id.to_owned(), None)]),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn epub() -> Vec<u8> {
        let mut bytes = b"PK\x03\x04".to_vec();
        bytes.resize(30, 0);
        bytes.extend_from_slice(b"mimetypeapplication/epub+zip rest");
        bytes
    }

    #[test]
    fn detects_formats_from_content() {
        assert_eq!(detect_format(b"%PDF-1.4 ...").unwrap(), Format::Pdf);
        assert_eq!(detect_format(&epub()).unwrap(), Format::Epub);
        assert!(detect_format(b"PK\x03\x04 plain zip").is_err());
        assert!(detect_format(b"hello").is_err());
    }

    #[test]
    fn importing_the_same_file_twice_is_one_book() {
        let store = Store::memory().unwrap();
        let meta = || ImportMeta { title: " Dune ".into(), author: Some("".into()) };
        let a = import(&store, b"%PDF-1.4 dune", meta()).unwrap();
        let b = import(&store, b"%PDF-1.4 dune", meta()).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.value.title, "Dune");
        assert_eq!(a.value.author, None);
        assert_eq!(store.books().unwrap().len(), 1);
    }

    #[test]
    fn removing_a_book_removes_its_bookmarks_and_bytes() {
        let store = Store::memory().unwrap();
        let book = import(&store, &epub(), ImportMeta { title: "E".into(), author: None }).unwrap();
        add_bookmark(&store, &book.id, "epubcfi(/6/4)".into(), "Chapter 1".into()).unwrap();
        add_bookmark(&store, &book.id, "epubcfi(/6/4)".into(), "Chapter 1".into()).unwrap();
        assert_eq!(store.bookmarks(&book.id).unwrap().len(), 1);
        remove(&store, &book.id).unwrap();
        assert!(store.bookmarks(&book.id).unwrap().is_empty());
        assert!(!store.has_blob(&book.id).unwrap());
        assert!(set_progress(&store, &book.id, "1".into(), "Page 1".into(), 0.0).is_err());
    }

    fn mark(location: &str, color: Color) -> NewHighlight {
        NewHighlight {
            location: location.into(),
            text: "  Call me\n  Ishmael.  ".into(),
            color,
            label: "Chapter 1 · 1%".into(),
            fraction: 0.01,
        }
    }

    #[test]
    fn highlights_recolour_instead_of_stacking_and_leave_with_their_book() {
        let store = Store::memory().unwrap();
        let book = import(&store, &epub(), ImportMeta { title: "E".into(), author: None }).unwrap();
        let first = add_highlight(&store, &book.id, mark("epubcfi(/6/4!/4/2,/1:0,/1:15)", Color::Yellow)).unwrap();
        assert_eq!(first.value.text, "Call me Ishmael.");
        let again = add_highlight(&store, &book.id, mark("epubcfi(/6/4!/4/2,/1:0,/1:15)", Color::Blue)).unwrap();
        assert_eq!((again.id.as_str(), again.value.color), (first.id.as_str(), Color::Blue));
        add_highlight(&store, &book.id, mark("2:[[2,0.1,0.2,0.5,0.03]]", Color::Pink)).unwrap();
        assert_eq!(store.highlights(Some(&book.id)).unwrap().len(), 2);
        assert_eq!(store.summary().unwrap().3, 2);

        set_highlight_color(&store, &first.id, Color::Green).unwrap();
        assert_eq!(store.highlights(None).unwrap()[0].value.color, Color::Green);
        remove_highlight(&store, &first.id).unwrap();
        assert!(set_highlight_color(&store, &first.id, Color::Pink).is_err());
        assert_eq!(store.highlights(None).unwrap().len(), 1);

        remove(&store, &book.id).unwrap();
        assert!(store.highlights(None).unwrap().is_empty());
        assert_eq!(store.summary().unwrap().3, 0);
        assert!(add_highlight(&store, &book.id, mark("epubcfi(/6/4)", Color::Yellow)).is_err());
    }

    #[test]
    fn covers_must_be_small_images_of_known_books() {
        let store = Store::memory().unwrap();
        let book = import(&store, b"%PDF-1.4 c", ImportMeta { title: "C".into(), author: None }).unwrap();
        assert!(set_cover(&store, &book.id, b"\xff\xd8\xff\xe0jpeg").is_ok());
        assert!(set_cover(&store, &book.id, b"").is_ok());
        assert!(set_cover(&store, &book.id, b"<svg onload=x>").is_err());
        assert!(set_cover(&store, &"d".repeat(64), b"\xff\xd8\xff").is_err());
    }

    #[test]
    fn unchanged_progress_is_not_restamped() {
        let store = Store::memory().unwrap();
        let book = import(&store, b"%PDF-1.4 x", ImportMeta { title: "X".into(), author: None }).unwrap();
        assert!(set_progress(&store, &book.id, "2".into(), "Page 2 of 9".into(), 0.2).unwrap().is_some());
        assert!(set_progress(&store, &book.id, "2".into(), "Page 2 of 9".into(), 0.2).unwrap().is_none());
    }
}
