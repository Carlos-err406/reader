//! Portable sync data. No credentials, device settings or book bytes.
use crate::error::{bail, Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;

pub const CHECKPOINT_FORMAT: u32 = 1;
pub const MAX_CHECKPOINT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_BOOK_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TIME: i64 = 8_640_000_000_000_000;

/// Hybrid logical timestamp. Later revisions win; the actor breaks exact ties.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Revision {
    pub time: i64,
    pub counter: i64,
    pub actor: String,
}

impl Revision {
    pub fn zero() -> Self {
        Self { time: 0, counter: 0, actor: String::new() }
    }

    pub fn compare(&self, other: &Self) -> Ordering {
        self.time
            .cmp(&other.time)
            .then(self.counter.cmp(&other.counter))
            .then_with(|| self.actor.as_bytes().cmp(other.actor.as_bytes()))
    }

    /// Never moves backwards, even if the wall clock does.
    pub fn next(&self, actor: &str, now: i64) -> Result<Self> {
        let time = now.max(self.time);
        let counter = if time == self.time { self.counter.checked_add(1) } else { Some(0) };
        match counter {
            Some(counter) if time <= MAX_TIME => Ok(Self { time, counter, actor: actor.to_owned() }),
            _ => bail!("Sync clock overflow"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Book,
    Progress,
    Bookmark,
    Highlight,
    /// A starred book. Unstarring tombstones it.
    Favorite,
    /// A book read to the end, or marked as finished. Marking it not finished tombstones it.
    Finished,
    /// A named group of books. Deleting it tombstones it and its members.
    Collection,
    /// A book in a collection; the id is `<collection id>:<book id>`.
    Member,
    /// A cover chosen for a book, replacing the one drawn from its file. The id is the book's.
    Cover,
    /// One device's reading speed, for the time left in a book. The id is the device's replica
    /// id: each device writes only its own, and readers combine them all.
    Pace,
    /// Time spent reading a book on one device. The id is the device's replica id and the book's
    /// (`time_id`): each device writes only its own, and readers add them up.
    Time,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Book => "book",
            Kind::Progress => "progress",
            Kind::Bookmark => "bookmark",
            Kind::Highlight => "highlight",
            Kind::Favorite => "favorite",
            Kind::Finished => "finished",
            Kind::Collection => "collection",
            Kind::Member => "member",
            Kind::Cover => "cover",
            Kind::Pace => "pace",
            Kind::Time => "time",
        }
    }

    /// Every kind this version understands.
    pub const ALL: [Kind; 11] = [
        Kind::Book,
        Kind::Progress,
        Kind::Bookmark,
        Kind::Highlight,
        Kind::Favorite,
        Kind::Finished,
        Kind::Collection,
        Kind::Member,
        Kind::Cover,
        Kind::Pace,
        Kind::Time,
    ];

    pub fn parse(value: &str) -> Result<Self> {
        match Self::ALL.into_iter().find(|k| k.as_str() == value) {
            Some(kind) => Ok(kind),
            None => bail!("Unknown record kind"),
        }
    }
}

/// The record kinds this version reads, recorded with each checkpoint it has read. A version
/// that knew fewer skipped some records, so a newer one reads that checkpoint again.
pub fn known_kinds() -> String {
    Kind::ALL.map(Kind::as_str).join(",")
}

/// `value: None` is a tombstone. Deletions are records, so remote absence never deletes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub kind: Kind,
    pub id: String,
    pub revision: Revision,
    pub value: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Pdf,
    Epub,
}

impl Format {
    pub fn mime(self) -> &'static str {
        match self {
            Format::Pdf => "application/pdf",
            Format::Epub => "application/epub+zip",
        }
    }
}

/// A book's id is the SHA-256 of its bytes, so importing the same file on two devices is one book.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookValue {
    pub title: String,
    pub author: Option<String>,
    pub format: Format,
    pub size: u64,
    pub added_at: i64,
}

/// `location` is a page number for PDFs and an EPUB CFI for EPUBs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressValue {
    pub location: String,
    pub label: String,
    pub fraction: f64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookmarkValue {
    pub book_id: String,
    pub location: String,
    pub label: String,
    pub created_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Color {
    Yellow,
    Green,
    Blue,
    Pink,
    Purple,
}

/// Coloured text. `location` is an EPUB CFI range, or for PDFs the first page number, a colon
/// and JSON rectangles `[[page, x, y, width, height], …]` as fractions of the page.
/// `fraction` places it in the book, for sorting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HighlightValue {
    pub book_id: String,
    pub location: String,
    pub text: String,
    pub color: Color,
    pub label: String,
    pub fraction: f64,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionValue {
    pub name: String,
    pub created_at: i64,
}

pub const MAX_COLLECTION_NAME: usize = 80;

/// A chosen cover: a small JPEG or PNG, carried in the record itself (as base64), so it syncs
/// with everything else. Kept small so a library of them doesn't swell the checkpoints.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoverValue {
    pub image: String,
    pub at: i64,
}

pub const MAX_COVER_IMAGE: usize = 256 * 1024;

pub fn cover_image(value: &CoverValue) -> Option<Vec<u8>> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&value.image).ok()?;
    let image = bytes.starts_with(b"\xff\xd8\xff") || bytes.starts_with(b"\x89PNG\r\n\x1a\n");
    (image && bytes.len() <= MAX_COVER_IMAGE).then_some(bytes)
}

/// A member record's id: the collection's and the book's, so each membership syncs on its own.
pub fn member_id(collection: &str, book: &str) -> String {
    format!("{collection}:{book}")
}

pub fn parse_member_id(id: &str) -> Option<(&str, &str)> {
    let (collection, book) = id.split_once(':')?;
    (is_uuid(collection) && is_sha256(book)).then_some((collection, book))
}

/// Reading measured on one device: `units` read (EPUB locations of about 1200 characters, or PDF
/// pages) in `minutes`, over its latest reading.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reading {
    pub units: f64,
    pub minutes: f64,
}

/// One device's reading speed, by format.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaceValue {
    #[serde(default)]
    pub epub: Option<Reading>,
    #[serde(default)]
    pub pdf: Option<Reading>,
    pub at: i64,
}

pub fn validate_pace(value: &PaceValue) -> Result<()> {
    let reading = |r: &Reading| {
        r.units.is_finite() && r.minutes.is_finite() && (0.0..=1e6).contains(&r.units) && (0.0..=1e4).contains(&r.minutes)
    };
    check(value.epub.as_ref().is_none_or(reading) && value.pdf.as_ref().is_none_or(reading) && time(value.at))
}

/// A time record's id: the device's and the book's, so each device keeps its own count.
pub fn time_id(device: &str, book: &str) -> String {
    format!("{device}:{book}")
}

/// Minutes spent reading a book on one device.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeValue {
    pub minutes: f64,
    pub at: i64,
}

/// More than this (in minutes, about nineteen years) isn't reading time.
pub const MAX_MINUTES_READ: f64 = 1e7;

pub fn validate_time(value: &TimeValue) -> Result<()> {
    check(value.minutes.is_finite() && (0.0..=MAX_MINUTES_READ).contains(&value.minutes) && time(value.at))
}

/// When a book was starred, finished or added to a collection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkedValue {
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub format: u32,
    pub replica: String,
    pub sequence: u64,
    pub records: Vec<Record>,
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|u| u.hyphenated().to_string() == value)
}

fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max
}

fn time(value: i64) -> bool {
    (0..=MAX_TIME).contains(&value)
}

fn invalid() -> Error {
    Error::new("Invalid or unsupported sync data")
}

fn check(valid: bool) -> Result<()> {
    if valid {
        Ok(())
    } else {
        Err(invalid())
    }
}

pub fn validate_book(value: &BookValue) -> Result<()> {
    check(
        text(&value.title, 500)
            && value.author.as_deref().is_none_or(|a| text(a, 500))
            && (1..=MAX_BOOK_BYTES).contains(&value.size)
            && time(value.added_at),
    )
}

pub fn validate_progress(value: &ProgressValue) -> Result<()> {
    check(
        text(&value.location, 4000)
            && text(&value.label, 300)
            && value.fraction.is_finite()
            && (0.0..=1.0).contains(&value.fraction)
            && time(value.updated_at),
    )
}

pub fn validate_bookmark(value: &BookmarkValue) -> Result<()> {
    check(
        is_sha256(&value.book_id)
            && text(&value.location, 4000)
            && text(&value.label, 300)
            && time(value.created_at),
    )
}

pub const MAX_HIGHLIGHT_TEXT: usize = 2000;

pub fn validate_highlight(value: &HighlightValue) -> Result<()> {
    check(
        is_sha256(&value.book_id)
            && text(&value.location, 16_000)
            && text(&value.text, MAX_HIGHLIGHT_TEXT)
            && text(&value.label, 300)
            && value.fraction.is_finite()
            && (0.0..=1.0).contains(&value.fraction)
            && time(value.created_at),
    )
}

pub fn validate_record(record: &Record) -> Result<()> {
    let r = &record.revision;
    check(time(r.time) && r.counter >= 0 && text(&r.actor, 200))?;
    match record.kind {
        Kind::Book | Kind::Progress | Kind::Favorite | Kind::Finished | Kind::Cover => check(is_sha256(&record.id))?,
        Kind::Bookmark | Kind::Highlight | Kind::Collection | Kind::Pace => check(is_uuid(&record.id))?,
        // Both are a UUID (a collection's, a device's) and a book's id.
        Kind::Member | Kind::Time => check(parse_member_id(&record.id).is_some())?,
    }
    let Some(value) = &record.value else { return Ok(()) };
    let value = value.clone();
    match record.kind {
        Kind::Book => validate_book(&serde_json::from_value(value).map_err(|_| invalid())?),
        Kind::Progress => validate_progress(&serde_json::from_value(value).map_err(|_| invalid())?),
        Kind::Bookmark => validate_bookmark(&serde_json::from_value(value).map_err(|_| invalid())?),
        Kind::Highlight => validate_highlight(&serde_json::from_value(value).map_err(|_| invalid())?),
        Kind::Collection => {
            let collection: CollectionValue = serde_json::from_value(value).map_err(|_| invalid())?;
            check(text(&collection.name, MAX_COLLECTION_NAME) && time(collection.created_at))
        }
        Kind::Cover => {
            let cover: CoverValue = serde_json::from_value(value).map_err(|_| invalid())?;
            check(time(cover.at) && cover_image(&cover).is_some())
        }
        Kind::Pace => validate_pace(&serde_json::from_value(value).map_err(|_| invalid())?),
        Kind::Time => validate_time(&serde_json::from_value(value).map_err(|_| invalid())?),
        Kind::Favorite | Kind::Finished | Kind::Member => {
            let marked: MarkedValue = serde_json::from_value(value).map_err(|_| invalid())?;
            check(time(marked.at))
        }
    }
}

/// Validates everything before any of it may be applied. Records of kinds a newer version added
/// are skipped, so an older device keeps syncing everything it understands.
pub fn validate_checkpoint(bytes: &[u8]) -> Result<Checkpoint> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Raw {
        format: u32,
        replica: String,
        sequence: u64,
        records: Vec<Value>,
    }
    check(bytes.len() <= MAX_CHECKPOINT_BYTES)?;
    let raw: Raw = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    check(
        raw.format == CHECKPOINT_FORMAT
            && text(&raw.replica, 200)
            && raw.sequence >= 1
            && raw.records.len() <= 200_000,
    )?;
    let mut records = Vec::with_capacity(raw.records.len());
    for record in raw.records {
        let known = record.get("kind").and_then(Value::as_str).is_some_and(|k| Kind::parse(k).is_ok());
        if !known {
            check(record.get("kind").is_some_and(Value::is_string))?;
            continue;
        }
        records.push(serde_json::from_value::<Record>(record).map_err(|_| invalid())?);
    }
    let mut seen = HashSet::new();
    for record in &records {
        validate_record(record)?;
        check(seen.insert((record.kind, record.id.as_str())))?;
    }
    Ok(Checkpoint { format: raw.format, replica: raw.replica, sequence: raw.sequence, records })
}

/// Stable bytes for hashing and equality. serde_json objects keep keys sorted.
pub fn canonical<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(&serde_json::to_value(value)?)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_never_move_backwards() {
        let a = Revision { time: 100, counter: 4, actor: "b".into() };
        let rolled_back = a.next("a", 50).unwrap();
        assert_eq!((rolled_back.time, rolled_back.counter), (100, 5));
        assert_eq!(rolled_back.compare(&a), Ordering::Greater);
        let later = a.next("a", 200).unwrap();
        assert_eq!((later.time, later.counter), (200, 0));
    }

    #[test]
    fn ties_break_on_actor() {
        let a = Revision { time: 1, counter: 0, actor: "a".into() };
        let b = Revision { time: 1, counter: 0, actor: "b".into() };
        assert_eq!(a.compare(&b), Ordering::Less);
    }

    #[test]
    fn rejects_malformed_checkpoints() {
        let book = "a".repeat(64);
        let good = serde_json::json!({
            "format": 1, "replica": "r", "sequence": 1,
            "records": [{ "kind": "progress", "id": book, "revision": { "time": 1, "counter": 0, "actor": "r" },
                "value": { "location": "4", "label": "Page 4 of 10", "fraction": 0.4, "updatedAt": 1 } }]
        });
        assert!(validate_checkpoint(good.to_string().as_bytes()).is_ok());

        let mut unknown = good.clone();
        unknown["records"][0]["value"]["extra"] = true.into();
        assert!(validate_checkpoint(unknown.to_string().as_bytes()).is_err());

        let mut fraction = good.clone();
        fraction["records"][0]["value"]["fraction"] = 1.5.into();
        assert!(validate_checkpoint(fraction.to_string().as_bytes()).is_err());

        let mut duplicate = good.clone();
        let record = duplicate["records"][0].clone();
        duplicate["records"].as_array_mut().unwrap().push(record);
        assert!(validate_checkpoint(duplicate.to_string().as_bytes()).is_err());

        let mut version = good.clone();
        version["format"] = 2.into();
        assert!(validate_checkpoint(version.to_string().as_bytes()).is_err());

        let mut future = good.clone();
        future["records"].as_array_mut().unwrap().push(serde_json::json!({ "kind": "sticker", "id": "x", "anything": 1 }));
        assert_eq!(validate_checkpoint(future.to_string().as_bytes()).unwrap().records.len(), 1);

        let highlight = serde_json::json!({ "kind": "highlight", "id": "0b8e8a52-6f1c-4d1e-9a39-1d5f0c6f6c11",
            "revision": { "time": 1, "counter": 0, "actor": "r" },
            "value": { "bookId": "a".repeat(64), "location": "epubcfi(/6/4!/4/2,/1:0,/1:5)", "text": "Hello",
                "color": "green", "label": "Chapter 1 · 3%", "fraction": 0.03, "createdAt": 1 } });
        let mut colored = good.clone();
        colored["records"].as_array_mut().unwrap().push(highlight.clone());
        assert_eq!(validate_checkpoint(colored.to_string().as_bytes()).unwrap().records.len(), 2);
        let mut odd = good.clone();
        let mut bad_color = highlight;
        bad_color["value"]["color"] = "orange".into();
        odd["records"].as_array_mut().unwrap().push(bad_color);
        assert!(validate_checkpoint(odd.to_string().as_bytes()).is_err());

        let mut bad_id = good;
        bad_id["records"][0]["id"] = "../etc".into();
        assert!(validate_checkpoint(bad_id.to_string().as_bytes()).is_err());
    }
}
