//! Local library operations. Each edit is stamped for sync in the same transaction.
use crate::error::{bail, Result};
use crate::store::{now_ms, Book, Bookmark, Collection, Highlight, Store};
use crate::sync::model::{
    is_sha256, validate_book, validate_bookmark, validate_highlight, validate_progress, BookValue,
    BookmarkValue, Color, CollectionValue, CoverValue, Format, HighlightValue, Kind, MarkedValue, PaceValue, ProgressValue,
    MAX_BOOK_BYTES, MAX_COLLECTION_NAME, MAX_COVER_IMAGE, MAX_HIGHLIGHT_TEXT, is_uuid, member_id,
};
use serde::{Deserialize, Serialize};
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
    // Re-importing keeps the original added time and any title or author edited since, and
    // revives a deleted book.
    let existing = store.book(&id)?;
    let added_at = existing.as_ref().map_or_else(now_ms, |b| b.added_at);
    let (title, author) = match existing {
        Some(b) => (b.title, b.author),
        None => (title, author),
    };
    let value = BookValue { title, author, format, size: bytes.len() as u64, added_at };
    validate_book(&value)?;
    store.put_blob(&id, bytes)?;
    store.stamp(vec![(Kind::Book, id.clone(), Some(serde_json::to_value(&value)?))])?;
    let progress = store.progress(&id)?;
    // The webview renders the cover right after importing.
    let favorite = store.record(Kind::Favorite, &id)?.is_some_and(|r| r.value.is_some());
    let finished_at = finished_at(store, &id)?;
    let custom_cover = store.custom_cover(&id)?.map(|_| now_ms());
    Ok(Book { id, value, available: true, progress, cover: custom_cover.map(|_| true), favorite, finished_at, custom_cover })
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
    for kind in [Kind::Favorite, Kind::Finished, Kind::Cover] {
        if store.record(kind, id)?.is_some_and(|r| r.value.is_some()) {
            edits.push((kind, id.to_owned(), None));
        }
    }
    for (collection, book) in store.members()? {
        if book == id {
            edits.push((Kind::Member, member_id(&collection, &book), None));
        }
    }
    store.stamp(edits)?;
    store.release_deleted_blobs()?;
    Ok(())
}

/// Reading reaches the end: a PDF's last page, or the last screens of an EPUB (whose position is
/// where the screen starts, so it never quite reaches 100%).
fn at_the_end(format: Format, fraction: f64) -> bool {
    match format {
        Format::Pdf => fraction >= 0.9999,
        Format::Epub => fraction >= 0.99,
    }
}

/// Corrects a book's title or author. An empty author clears it.
pub fn set_details(store: &Store, book: &str, title: &str, author: &str) -> Result<BookValue> {
    let mut value = require_book(store, book)?;
    let title = clip(title, 500);
    if title.is_empty() {
        bail!("A book needs a title");
    }
    let author = Some(clip(author, 500)).filter(|a| !a.is_empty());
    if value.title != title || value.author != author {
        value.title = title;
        value.author = author;
        validate_book(&value)?;
        store.stamp(vec![(Kind::Book, book.to_owned(), Some(serde_json::to_value(&value)?))])?;
    }
    Ok(value)
}

/// Chooses a cover for a book (a small JPEG or PNG), or with `None` goes back to the one drawn
/// from its file.
pub fn set_custom_cover(store: &Store, book: &str, image: Option<&[u8]>) -> Result<()> {
    use base64::Engine;
    require_book(store, book)?;
    let value = match image {
        Some(image) => {
            let image_like = image.starts_with(b"\xff\xd8\xff") || image.starts_with(b"\x89PNG\r\n\x1a\n");
            if !image_like || image.len() > MAX_COVER_IMAGE {
                bail!("Covers must be a JPEG or PNG under {} KB", MAX_COVER_IMAGE / 1024);
            }
            let cover = CoverValue { image: base64::engine::general_purpose::STANDARD.encode(image), at: now_ms() };
            Some(serde_json::to_value(cover)?)
        }
        None if store.record(Kind::Cover, book)?.is_none_or(|r| r.value.is_none()) => return Ok(()),
        None => None,
    };
    store.stamp(vec![(Kind::Cover, book.to_owned(), value)])
}

pub fn set_progress(store: &Store, book: &str, location: String, label: String, fraction: f64) -> Result<Option<ProgressValue>> {
    let format = require_book(store, book)?.format;
    let current = store.progress(book)?;
    if current.as_ref().is_some_and(|p| p.location == location && p.label == label) {
        return Ok(None);
    }
    let value = ProgressValue { location, label, fraction: fraction.clamp(0.0, 1.0), updated_at: now_ms() };
    validate_progress(&value)?;
    let mut edits = vec![(Kind::Progress, book.to_owned(), Some(serde_json::to_value(&value)?))];
    // Reaching the end finishes the book; reading it again later doesn't unfinish it.
    if at_the_end(format, value.fraction) && finished_at(store, book)?.is_none() {
        edits.push((Kind::Finished, book.to_owned(), Some(serde_json::to_value(MarkedValue { at: value.updated_at })?)));
    }
    store.stamp(edits)?;
    Ok(Some(value))
}

fn finished_at(store: &Store, book: &str) -> Result<Option<i64>> {
    match store.record(Kind::Finished, book)?.and_then(|r| r.value) {
        Some(value) => Ok(Some(serde_json::from_value::<MarkedValue>(value)?.at)),
        None => Ok(None),
    }
}

/// Reading speeds: this device's, which it adds to, and every other device's.
#[derive(Debug, Serialize)]
pub struct Paces {
    pub mine: Option<PaceValue>,
    pub others: Vec<PaceValue>,
}

pub fn paces(store: &Store) -> Result<Paces> {
    let me = store.replica()?;
    let (mine, others): (Vec<_>, Vec<_>) = store.paces()?.into_iter().partition(|(device, _)| *device == me);
    Ok(Paces { mine: mine.into_iter().next().map(|(_, p)| p), others: others.into_iter().map(|(_, p)| p).collect() })
}

/// Saves this device's reading speed. Each device has its own record, so none overwrites another's.
pub fn set_pace(store: &Store, pace: PaceValue) -> Result<()> {
    let pace = PaceValue { at: now_ms(), ..pace };
    store.stamp(vec![(Kind::Pace, store.replica()?, Some(serde_json::to_value(pace)?))])
}

/// Stars or unstars a book (`Kind::Favorite`), or marks it finished or not (`Kind::Finished`).
/// Returns whether anything changed.
pub fn set_mark(store: &Store, kind: Kind, book: &str, on: bool) -> Result<bool> {
    if !matches!(kind, Kind::Favorite | Kind::Finished) {
        bail!("Unknown mark");
    }
    require_book(store, book)?;
    let marked = store.record(kind, book)?.is_some_and(|r| r.value.is_some());
    if marked == on {
        return Ok(false);
    }
    let value = on.then(|| serde_json::to_value(MarkedValue { at: now_ms() })).transpose()?;
    store.stamp(vec![(kind, book.to_owned(), value)])?;
    Ok(true)
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

fn collection_name(name: &str) -> Result<String> {
    let name = clip(&name.split_whitespace().collect::<Vec<_>>().join(" "), MAX_COLLECTION_NAME);
    if name.is_empty() {
        bail!("Give the collection a name");
    }
    Ok(name)
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// A collection called `name`; one that already has that name is reused rather than doubled.
pub fn create_collection(store: &Store, name: &str) -> Result<Collection> {
    let name = collection_name(name)?;
    if let Some(existing) = store.collections()?.into_iter().find(|c| same_name(&c.name, &name)) {
        return Ok(existing);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let value = CollectionValue { name, created_at: now_ms() };
    store.stamp(vec![(Kind::Collection, id.clone(), Some(serde_json::to_value(&value)?))])?;
    Ok(Collection { id, name: value.name, created_at: value.created_at, books: Vec::new() })
}

fn collection(store: &Store, id: &str) -> Result<CollectionValue> {
    if !is_uuid(id) {
        bail!("Unknown collection");
    }
    match store.record(Kind::Collection, id)?.and_then(|r| r.value) {
        Some(value) => Ok(serde_json::from_value(value)?),
        None => bail!("This collection was deleted"),
    }
}

pub fn rename_collection(store: &Store, id: &str, name: &str) -> Result<()> {
    let mut value = collection(store, id)?;
    let name = collection_name(name)?;
    if store.collections()?.iter().any(|c| c.id != id && same_name(&c.name, &name)) {
        bail!("There's already a collection called “{name}”");
    }
    if value.name != name {
        value.name = name;
        store.stamp(vec![(Kind::Collection, id.to_owned(), Some(serde_json::to_value(&value)?))])?;
    }
    Ok(())
}

/// The books stay in the library; only the grouping goes.
pub fn delete_collection(store: &Store, id: &str) -> Result<()> {
    collection(store, id)?;
    let mut edits = vec![(Kind::Collection, id.to_owned(), None)];
    for (c, book) in store.members()? {
        if c == id {
            edits.push((Kind::Member, member_id(&c, &book), None));
        }
    }
    store.stamp(edits)
}

/// Adds a book to a collection or takes it out. Returns whether anything changed.
pub fn set_member(store: &Store, collection_id: &str, book: &str, on: bool) -> Result<bool> {
    collection(store, collection_id)?;
    require_book(store, book)?;
    let id = member_id(collection_id, book);
    let member = store.record(Kind::Member, &id)?.is_some_and(|r| r.value.is_some());
    if member == on {
        return Ok(false);
    }
    let value = on.then(|| serde_json::to_value(MarkedValue { at: now_ms() })).transpose()?;
    store.stamp(vec![(Kind::Member, id, value)])?;
    Ok(true)
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
    fn each_device_keeps_its_own_pace() {
        let reading = |units, minutes| Some(crate::sync::model::Reading { units, minutes });
        let phone = Store::memory().unwrap();
        let laptop = Store::memory().unwrap();
        set_pace(&phone, PaceValue { epub: reading(30.0, 20.0), pdf: None, at: 0 }).unwrap();
        set_pace(&laptop, PaceValue { epub: reading(90.0, 60.0), pdf: reading(4.0, 10.0), at: 0 }).unwrap();
        // Both reach each other, in both directions, and neither overwrites the other.
        phone.apply(&laptop.records().unwrap()).unwrap();
        laptop.apply(&phone.records().unwrap()).unwrap();
        let seen = paces(&phone).unwrap();
        assert_eq!(seen.mine.unwrap().epub, reading(30.0, 20.0));
        assert_eq!(seen.others.len(), 1);
        assert_eq!(seen.others[0].pdf, reading(4.0, 10.0));
        assert_eq!(paces(&laptop).unwrap().others[0].epub, reading(30.0, 20.0));
        // A newer reading replaces this device's own.
        set_pace(&phone, PaceValue { epub: reading(40.0, 25.0), pdf: None, at: 0 }).unwrap();
        assert_eq!(paces(&phone).unwrap().mine.unwrap().epub, reading(40.0, 25.0));
        assert!(set_pace(&phone, PaceValue { epub: reading(f64::NAN, 1.0), pdf: None, at: 0 }).is_err());
        assert!(set_pace(&phone, PaceValue { epub: reading(-1.0, 1.0), pdf: None, at: 0 }).is_err());
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
        let recoloured = store.highlights(None).unwrap().into_iter().find(|h| h.id == first.id).unwrap();
        assert_eq!(recoloured.value.color, Color::Green);
        remove_highlight(&store, &first.id).unwrap();
        assert!(set_highlight_color(&store, &first.id, Color::Pink).is_err());
        assert_eq!(store.highlights(None).unwrap().len(), 1);

        remove(&store, &book.id).unwrap();
        assert!(store.highlights(None).unwrap().is_empty());
        assert_eq!(store.summary().unwrap().3, 0);
        assert!(add_highlight(&store, &book.id, mark("epubcfi(/6/4)", Color::Yellow)).is_err());
    }

    #[test]
    fn favorites_and_finishing_are_marks_that_leave_with_their_book() {
        let store = Store::memory().unwrap();
        let book = import(&store, &epub(), ImportMeta { title: "E".into(), author: None }).unwrap();
        let get = |store: &Store| store.books().unwrap().into_iter().next().unwrap();
        assert!(!get(&store).favorite && get(&store).finished_at.is_none());

        assert!(set_mark(&store, Kind::Favorite, &book.id, true).unwrap());
        assert!(!set_mark(&store, Kind::Favorite, &book.id, true).unwrap());
        assert!(get(&store).favorite);

        set_progress(&store, &book.id, "epubcfi(/6/4)".into(), "1%".into(), 0.5).unwrap();
        assert!(get(&store).finished_at.is_none());
        set_progress(&store, &book.id, "epubcfi(/6/90)".into(), "99%".into(), 0.993).unwrap();
        let finished = get(&store).finished_at;
        assert!(finished.is_some());
        // Reading it again keeps it finished; unmarking is the reader's choice.
        set_progress(&store, &book.id, "epubcfi(/6/8)".into(), "2%".into(), 0.02).unwrap();
        assert_eq!(get(&store).finished_at, finished);
        assert!(set_mark(&store, Kind::Finished, &book.id, false).unwrap());
        assert!(get(&store).finished_at.is_none());
        assert!(set_mark(&store, Kind::Bookmark, &book.id, true).is_err());

        remove(&store, &book.id).unwrap();
        for kind in [Kind::Favorite, Kind::Finished] {
            assert!(store.record(kind, &book.id).unwrap().is_none_or(|r| r.value.is_none()));
        }
    }

    #[test]
    fn collections_group_books_and_leave_them_be_when_deleted() {
        let store = Store::memory().unwrap();
        let book = import(&store, &epub(), ImportMeta { title: "E".into(), author: None }).unwrap();
        let other = import(&store, b"%PDF-1.4 another", ImportMeta { title: "P".into(), author: None }).unwrap();

        let sci = create_collection(&store, "  Science   fiction ").unwrap();
        assert_eq!(sci.name, "Science fiction");
        assert_eq!(create_collection(&store, "science FICTION").unwrap().id, sci.id);
        assert!(create_collection(&store, "   ").is_err());
        let fav = create_collection(&store, "Audio").unwrap();

        assert!(set_member(&store, &sci.id, &book.id, true).unwrap());
        assert!(!set_member(&store, &sci.id, &book.id, true).unwrap());
        set_member(&store, &sci.id, &other.id, true).unwrap();
        set_member(&store, &fav.id, &book.id, true).unwrap();
        let all = store.collections().unwrap();
        assert_eq!(all.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Audio", "Science fiction"]);
        assert_eq!(all[1].books.len(), 2);

        assert!(rename_collection(&store, &fav.id, "SCIENCE fiction").is_err());
        rename_collection(&store, &fav.id, "Audiobooks").unwrap();

        // Removing a book takes it out of its collections.
        remove(&store, &other.id).unwrap();
        assert_eq!(store.collections().unwrap()[1].books, [book.id.clone()]);

        delete_collection(&store, &sci.id).unwrap();
        assert_eq!(store.collections().unwrap().len(), 1);
        assert_eq!(store.books().unwrap().len(), 1);
        assert!(set_member(&store, &sci.id, &book.id, true).is_err());
        assert!(store.members().unwrap().iter().all(|(c, _)| *c == fav.id));
    }

    #[test]
    fn details_and_chosen_covers_are_edited_and_survive_reimporting() {
        let store = Store::memory().unwrap();
        let book = import(&store, &epub(), ImportMeta { title: "Wrong Title".into(), author: None }).unwrap();
        set_details(&store, &book.id, "  Dune ", " Frank Herbert ").unwrap();
        assert!(set_details(&store, &book.id, "   ", "x").is_err());
        let again = import(&store, &epub(), ImportMeta { title: "Wrong Title".into(), author: Some("?".into()) }).unwrap();
        assert_eq!((again.value.title.as_str(), again.value.author.as_deref()), ("Dune", Some("Frank Herbert")));
        set_details(&store, &book.id, "Dune", "").unwrap();
        assert_eq!(store.book(&book.id).unwrap().unwrap().author, None);

        let jpeg = b"\xff\xd8\xff\xe0 a tiny jpeg".to_vec();
        assert!(set_custom_cover(&store, &book.id, Some(b"not an image")).is_err());
        set_custom_cover(&store, &book.id, Some(&jpeg)).unwrap();
        assert_eq!(store.custom_cover(&book.id).unwrap(), Some(jpeg));
        let listed = store.books().unwrap().remove(0);
        assert!(listed.custom_cover.is_some() && listed.cover == Some(true));
        set_custom_cover(&store, &book.id, None).unwrap();
        assert_eq!(store.custom_cover(&book.id).unwrap(), None);
        assert!(store.books().unwrap()[0].custom_cover.is_none());
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
