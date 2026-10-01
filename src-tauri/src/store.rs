//! SQLite holds synced records, book bytes and device-local metadata.
//! Every method is synchronous, so no transaction ever spans a network await.
use crate::error::{bail, Result};
use crate::sync::model::{
    canonical, parse_member_id, validate_record, BookValue, BookmarkValue, CollectionValue, HighlightValue, Kind,
    ProgressValue, Record, Revision,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::path::Path;
use std::sync::Mutex;

const SCHEMA: &str = "
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS records(
  kind TEXT NOT NULL, id TEXT NOT NULL,
  time INTEGER NOT NULL, counter INTEGER NOT NULL, actor TEXT NOT NULL,
  value TEXT, PRIMARY KEY(kind, id));
CREATE TABLE IF NOT EXISTS blobs(sha256 TEXT PRIMARY KEY, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Covers are rendered on each device from the book itself, so they are never synced.
-- An empty image means the book has no cover, so it is not retried.
CREATE TABLE IF NOT EXISTS covers(book TEXT PRIMARY KEY, data BLOB NOT NULL);
";

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    #[serde(flatten)]
    pub value: BookValue,
    /// False until this device has the bytes (e.g. imported on the other device).
    pub available: bool,
    pub progress: Option<ProgressValue>,
    /// `None` until this device has tried to render a cover; then whether it found one.
    pub cover: Option<bool>,
    pub favorite: bool,
    /// When it was read to the end or marked as finished.
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    #[serde(flatten)]
    pub value: BookmarkValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: String,
    #[serde(flatten)]
    pub value: HighlightValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    /// The books in it that are still in the library.
    pub books: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct Changed {
    pub kind: Kind,
    pub id: String,
}

pub struct Store {
    conn: Mutex<Connection>,
    now: fn() -> i64,
}

fn read_record(row: &rusqlite::Row) -> rusqlite::Result<(String, String, Revision, Option<String>)> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        Revision { time: row.get(2)?, counter: row.get(3)?, actor: row.get(4)? },
        row.get(5)?,
    ))
}

fn to_record((kind, id, revision, value): (String, String, Revision, Option<String>)) -> Result<Record> {
    Ok(Record {
        kind: Kind::parse(&kind)?,
        id,
        revision,
        value: value.map(|v| serde_json::from_str(&v)).transpose()?,
    })
}

fn put(tx: &Connection, record: &Record) -> Result<()> {
    let value = record.value.as_ref().map(canonical).transpose()?;
    tx.execute(
        "INSERT INTO records(kind,id,time,counter,actor,value) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(kind,id) DO UPDATE SET time=excluded.time, counter=excluded.counter,
         actor=excluded.actor, value=excluded.value",
        params![
            record.kind.as_str(),
            record.id,
            record.revision.time,
            record.revision.counter,
            record.revision.actor,
            value
        ],
    )?;
    Ok(())
}

fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))
        .optional()?)
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [key, value],
    )?;
    Ok(())
}

fn clock(conn: &Connection) -> Result<Revision> {
    match get_meta(conn, "clock")? {
        Some(value) => Ok(serde_json::from_str(&value)?),
        None => Ok(Revision::zero()),
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA)?;
        let store = Self { conn: Mutex::new(conn), now: now_ms };
        if store.meta("replica")?.is_none() {
            store.set_meta("replica", &uuid::Uuid::new_v4().to_string())?;
        }
        Ok(store)
    }

    #[cfg(test)]
    pub fn with_clock(mut self, now: fn() -> i64) -> Self {
        self.now = now;
        self
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn transaction<T>(&self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        get_meta(&self.lock(), key)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        set_meta(&self.lock(), key, value)
    }

    pub fn delete_meta_prefix(&self, prefix: &str, keep: &[String]) -> Result<()> {
        let conn = self.lock();
        let keys: Vec<String> = conn
            .prepare("SELECT key FROM meta WHERE substr(key,1,?2)=?1")?
            .query_map(params![prefix, prefix.len() as i64], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for key in keys.iter().filter(|k| !keep.contains(k)) {
            conn.execute("DELETE FROM meta WHERE key=?1", [key])?;
        }
        Ok(())
    }

    pub fn replica(&self) -> Result<String> {
        match self.meta("replica")? {
            Some(replica) => Ok(replica),
            None => bail!("Missing device identity"),
        }
    }

    pub fn dirty(&self) -> Result<bool> {
        Ok(self.meta("dirty")?.as_deref() == Some("1"))
    }

    /// Records a local edit with a fresh revision in the same transaction as the write.
    pub fn stamp(&self, edits: Vec<(Kind, String, Option<Value>)>) -> Result<()> {
        let replica = self.replica()?;
        let now = (self.now)();
        self.transaction(|tx| {
            let mut revision = clock(tx)?;
            for (kind, id, value) in edits {
                revision = revision.next(&replica, now)?;
                let record = Record { kind, id, revision: revision.clone(), value };
                validate_record(&record)?;
                put(tx, &record)?;
            }
            set_meta(tx, "clock", &canonical(&revision)?)?;
            set_meta(tx, "dirty", "1")
        })
    }

    pub fn records(&self) -> Result<Vec<Record>> {
        let conn = self.lock();
        let rows = conn
            .prepare("SELECT kind,id,time,counter,actor,value FROM records ORDER BY kind,id")?
            .query_map([], read_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(to_record).collect()
    }

    pub fn record(&self, kind: Kind, id: &str) -> Result<Option<Record>> {
        let conn = self.lock();
        let row = conn
            .query_row(
                "SELECT kind,id,time,counter,actor,value FROM records WHERE kind=?1 AND id=?2",
                [kind.as_str(), id],
                read_record,
            )
            .optional()?;
        row.map(to_record).transpose()
    }

    /// Last-writer-wins per record. Callers must pass a validated checkpoint.
    /// Merging against current rows inside the transaction keeps edits made during a download.
    pub fn apply(&self, incoming: &[Record]) -> Result<Vec<Changed>> {
        self.transaction(|tx| {
            let mut observed = clock(tx)?;
            let mut changed = Vec::new();
            for record in incoming {
                let local = tx
                    .query_row(
                        "SELECT kind,id,time,counter,actor,value FROM records WHERE kind=?1 AND id=?2",
                        [record.kind.as_str(), record.id.as_str()],
                        read_record,
                    )
                    .optional()?
                    .map(to_record)
                    .transpose()?;
                let wins = match &local {
                    None => true,
                    Some(local) => match record.revision.compare(&local.revision) {
                        Ordering::Greater => true,
                        Ordering::Less => false,
                        Ordering::Equal if local.value == record.value => false,
                        Ordering::Equal => bail!("Conflicting sync revision"),
                    },
                };
                if wins {
                    put(tx, record)?;
                    if local.as_ref().map(|l| &l.value) != Some(&record.value) {
                        changed.push(Changed { kind: record.kind, id: record.id.clone() });
                    }
                }
                if record.revision.compare(&observed) == Ordering::Greater {
                    observed = record.revision.clone();
                }
            }
            set_meta(tx, "clock", &canonical(&observed)?)?;
            Ok(changed)
        })
    }

    pub fn books(&self) -> Result<Vec<Book>> {
        let conn = self.lock();
        let mut statement = conn.prepare(
            "SELECT b.id, b.value, EXISTS(SELECT 1 FROM blobs WHERE sha256=b.id), p.value,
                    (SELECT length(data) > 0 FROM covers WHERE book=b.id),
                    EXISTS(SELECT 1 FROM records WHERE kind='favorite' AND id=b.id AND value IS NOT NULL),
                    (SELECT json_extract(value,'$.at') FROM records WHERE kind='finished' AND id=b.id AND value IS NOT NULL)
             FROM records b LEFT JOIN records p ON p.kind='progress' AND p.id=b.id
             WHERE b.kind='book' AND b.value IS NOT NULL",
        )?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<bool>>(4)?,
                    r.get::<_, bool>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut books = rows
            .into_iter()
            .map(|(id, value, available, progress, cover, favorite, finished_at)| {
                Ok(Book {
                    id,
                    value: serde_json::from_str(&value)?,
                    available,
                    progress: progress.map(|p| serde_json::from_str(&p)).transpose()?,
                    cover,
                    favorite,
                    finished_at,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let recent = |b: &Book| b.progress.as_ref().map_or(b.value.added_at, |p| p.updated_at);
        books.sort_by(|a, b| recent(b).cmp(&recent(a)));
        Ok(books)
    }

    pub fn book(&self, id: &str) -> Result<Option<BookValue>> {
        match self.record(Kind::Book, id)? {
            Some(Record { value: Some(value), .. }) => Ok(Some(serde_json::from_value(value)?)),
            _ => Ok(None),
        }
    }

    pub fn progress(&self, book: &str) -> Result<Option<ProgressValue>> {
        match self.record(Kind::Progress, book)? {
            Some(Record { value: Some(value), .. }) => Ok(Some(serde_json::from_value(value)?)),
            _ => Ok(None),
        }
    }

    pub fn bookmarks(&self, book: &str) -> Result<Vec<Bookmark>> {
        let conn = self.lock();
        let rows = conn
            .prepare(
                "SELECT id, value FROM records WHERE kind='bookmark' AND value IS NOT NULL
                 AND json_extract(value,'$.bookId')=?1 ORDER BY json_extract(value,'$.createdAt')",
            )?
            .query_map([book], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(id, value)| Ok(Bookmark { id, value: serde_json::from_str(&value)? }))
            .collect()
    }

    /// One book's highlights, or every book's, in reading order. A deleted book's are left out.
    pub fn highlights(&self, book: Option<&str>) -> Result<Vec<Highlight>> {
        let conn = self.lock();
        let rows = conn
            .prepare(
                "SELECT h.id, h.value FROM records h
                 JOIN records b ON b.kind='book' AND b.id=json_extract(h.value,'$.bookId') AND b.value IS NOT NULL
                 WHERE h.kind='highlight' AND h.value IS NOT NULL AND (?1 IS NULL OR b.id=?1)
                 ORDER BY b.id, json_extract(h.value,'$.fraction'), json_extract(h.value,'$.createdAt')",
            )?
            .query_map([book], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(id, value)| Ok(Highlight { id, value: serde_json::from_str(&value)? }))
            .collect()
    }

    /// Live memberships as (collection, book), including ones whose book was removed.
    pub fn members(&self) -> Result<Vec<(String, String)>> {
        let conn = self.lock();
        let ids = conn
            .prepare("SELECT id FROM records WHERE kind='member' AND value IS NOT NULL")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids
            .iter()
            .filter_map(|id| parse_member_id(id).map(|(c, b)| (c.to_owned(), b.to_owned())))
            .collect())
    }

    /// Collections by name, each with the books in it that are still in the library.
    pub fn collections(&self) -> Result<Vec<Collection>> {
        let (rows, live) = {
            let conn = self.lock();
            let rows = conn
                .prepare("SELECT id, value FROM records WHERE kind='collection' AND value IS NOT NULL")?
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let live = conn
                .prepare("SELECT id FROM records WHERE kind='book' AND value IS NOT NULL")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;
            (rows, live)
        };
        let members = self.members()?;
        let mut collections = rows
            .into_iter()
            .map(|(id, value)| {
                let value: CollectionValue = serde_json::from_str(&value)?;
                let books = members.iter().filter(|(c, b)| *c == id && live.contains(b)).map(|(_, b)| b.clone()).collect();
                Ok(Collection { id, name: value.name, created_at: value.created_at, books })
            })
            .collect::<Result<Vec<_>>>()?;
        collections.sort_by_cached_key(|c| (c.name.to_lowercase(), c.created_at));
        Ok(collections)
    }

    /// Counts of books in the library, books whose bytes are on this device, bookmarks and highlights.
    pub fn summary(&self) -> Result<(u32, u32, u32, u32)> {
        Ok(self.lock().query_row(
            "SELECT
               (SELECT count(*) FROM records WHERE kind='book' AND value IS NOT NULL),
               (SELECT count(*) FROM records r JOIN blobs b ON b.sha256=r.id WHERE r.kind='book' AND r.value IS NOT NULL),
               (SELECT count(*) FROM records WHERE kind='bookmark' AND value IS NOT NULL),
               (SELECT count(*) FROM records WHERE kind='highlight' AND value IS NOT NULL)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?)
    }

    pub fn put_blob(&self, sha256: &str, bytes: &[u8]) -> Result<()> {
        self.lock().execute(
            "INSERT OR IGNORE INTO blobs(sha256,data) VALUES(?1,?2)",
            params![sha256, bytes],
        )?;
        Ok(())
    }

    pub fn blob(&self, sha256: &str) -> Result<Option<Vec<u8>>> {
        Ok(self
            .lock()
            .query_row("SELECT data FROM blobs WHERE sha256=?1", [sha256], |r| r.get(0))
            .optional()?)
    }

    #[cfg(test)]
    pub fn has_blob(&self, sha256: &str) -> Result<bool> {
        Ok(self
            .lock()
            .query_row("SELECT 1 FROM blobs WHERE sha256=?1", [sha256], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// Book bytes and covers are local cache; a book tombstone (from any device) releases them.
    pub fn release_deleted_blobs(&self) -> Result<usize> {
        let conn = self.lock();
        let live = "SELECT id FROM records WHERE kind='book' AND value IS NOT NULL";
        conn.execute(&format!("DELETE FROM covers WHERE book NOT IN ({live})"), [])?;
        Ok(conn.execute(&format!("DELETE FROM blobs WHERE sha256 NOT IN ({live})"), [])?)
    }

    pub fn set_cover(&self, book: &str, image: &[u8]) -> Result<()> {
        self.lock().execute(
            "INSERT INTO covers(book,data) VALUES(?1,?2) ON CONFLICT(book) DO UPDATE SET data=excluded.data",
            params![book, image],
        )?;
        Ok(())
    }

    pub fn cover(&self, book: &str) -> Result<Option<Vec<u8>>> {
        Ok(self
            .lock()
            .query_row("SELECT data FROM covers WHERE book=?1 AND length(data) > 0", [book], |r| r.get(0))
            .optional()?)
    }

    pub fn missing_blobs(&self) -> Result<Vec<(String, BookValue)>> {
        Ok(self
            .books()?
            .into_iter()
            .filter(|b| !b.available)
            .map(|b| (b.id, b.value))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn progress(location: &str, at: i64) -> Option<Value> {
        Some(json!({ "location": location, "label": format!("Page {location}"), "fraction": 0.5, "updatedAt": at }))
    }

    fn book_id() -> String {
        "b".repeat(64)
    }

    #[test]
    fn stamping_marks_dirty_and_advances_the_clock() {
        let store = Store::memory().unwrap().with_clock(|| 1000);
        store.stamp(vec![(Kind::Progress, book_id(), progress("3", 1))]).unwrap();
        store.stamp(vec![(Kind::Progress, book_id(), progress("4", 2))]).unwrap();
        let record = store.record(Kind::Progress, &book_id()).unwrap().unwrap();
        assert_eq!((record.revision.time, record.revision.counter), (1000, 1));
        assert!(store.dirty().unwrap());
        assert_eq!(store.progress(&book_id()).unwrap().unwrap().location, "4");
    }

    #[test]
    fn replicas_converge_regardless_of_delivery_order() {
        let a = Store::memory().unwrap().with_clock(|| 1000);
        let b = Store::memory().unwrap().with_clock(|| 2000);
        a.stamp(vec![(Kind::Progress, book_id(), progress("10", 1000))]).unwrap();
        b.stamp(vec![(Kind::Progress, book_id(), progress("20", 2000))]).unwrap();
        let (ra, rb) = (a.records().unwrap(), b.records().unwrap());

        assert_eq!(a.apply(&rb).unwrap().len(), 1);
        assert!(b.apply(&ra).unwrap().is_empty());
        // Repeated delivery is a no-op.
        assert!(a.apply(&rb).unwrap().is_empty());
        assert_eq!(a.records().unwrap(), b.records().unwrap());
        assert_eq!(a.progress(&book_id()).unwrap().unwrap().location, "20");
    }

    #[test]
    fn receiving_advances_the_clock_so_the_next_local_edit_wins() {
        let slow = Store::memory().unwrap().with_clock(|| 10);
        let fast = Store::memory().unwrap().with_clock(|| 5000);
        fast.stamp(vec![(Kind::Progress, book_id(), progress("50", 5000))]).unwrap();
        slow.apply(&fast.records().unwrap()).unwrap();
        slow.stamp(vec![(Kind::Progress, book_id(), progress("51", 10))]).unwrap();
        fast.apply(&slow.records().unwrap()).unwrap();
        assert_eq!(fast.progress(&book_id()).unwrap().unwrap().location, "51");
    }

    #[test]
    fn tombstones_beat_stale_offline_copies() {
        let a = Store::memory().unwrap().with_clock(|| 100);
        let id = uuid::Uuid::new_v4().to_string();
        let mark = json!({ "bookId": book_id(), "location": "7", "label": "Page 7", "createdAt": 100 });
        a.stamp(vec![(Kind::Bookmark, id.clone(), Some(mark))]).unwrap();
        let stale = a.records().unwrap();
        a.stamp(vec![(Kind::Bookmark, id.clone(), None)]).unwrap();
        let b = Store::memory().unwrap();
        b.apply(&a.records().unwrap()).unwrap();
        b.apply(&stale).unwrap();
        assert!(b.bookmarks(&book_id()).unwrap().is_empty());
    }

    #[test]
    fn same_revision_with_different_content_is_rejected_atomically() {
        let a = Store::memory().unwrap().with_clock(|| 100);
        a.stamp(vec![(Kind::Progress, book_id(), progress("1", 1))]).unwrap();
        let mut forged = a.records().unwrap();
        forged[0].value = progress("2", 1);
        let other = Record { id: "c".repeat(64), ..forged[0].clone() };
        let b = Store::memory().unwrap();
        b.apply(&a.records().unwrap()).unwrap();
        assert!(b.apply(&[other, forged[0].clone()]).is_err());
        assert!(b.record(Kind::Progress, &"c".repeat(64)).unwrap().is_none());
    }

    #[test]
    fn deleted_books_release_their_bytes() {
        let store = Store::memory().unwrap();
        let book = json!({ "title": "T", "author": null, "format": "pdf", "size": 3, "addedAt": 1 });
        store.stamp(vec![(Kind::Book, book_id(), Some(book))]).unwrap();
        store.put_blob(&book_id(), b"pdf").unwrap();
        assert_eq!(store.release_deleted_blobs().unwrap(), 0);
        assert!(store.books().unwrap()[0].available);
        assert_eq!(store.summary().unwrap(), (1, 1, 0, 0));
        assert_eq!(store.books().unwrap()[0].cover, None);
        store.set_cover(&book_id(), b"\xff\xd8jpeg").unwrap();
        assert_eq!(store.books().unwrap()[0].cover, Some(true));
        store.stamp(vec![(Kind::Book, book_id(), None)]).unwrap();
        assert_eq!(store.release_deleted_blobs().unwrap(), 1);
        assert!(store.cover(&book_id()).unwrap().is_none());
        assert_eq!(store.summary().unwrap(), (0, 0, 0, 0));
        assert!(store.books().unwrap().is_empty());
    }
}
