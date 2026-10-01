//! One serial sync job per device. Each await is followed by a generation check,
//! so work started before pause/background is never applied afterwards.
use crate::error::{bail, Error, Result, OFFLINE};
use crate::store::{now_ms, Changed, Store};
use crate::sync::model::{canonical, known_kinds, validate_checkpoint, Checkpoint, Kind, Record, CHECKPOINT_FORMAT};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::Instant;

const POLL: Duration = Duration::from_secs(30);
const DEBOUNCE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    /// Drive's stable account id; sync is pinned to it.
    pub id: String,
    pub email: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointFile {
    pub id: String,
    pub replica: String,
    pub sequence: u64,
    pub sha256: String,
}

/// Remote storage. Drive in the app, an in-memory fake in tests.
pub trait Transport: Send + Sync + 'static {
    fn account(&self) -> impl Future<Output = Result<Account>> + Send;
    fn list(&self) -> impl Future<Output = Result<Vec<CheckpointFile>>> + Send;
    /// Returns the verified checkpoint bytes.
    fn read(&self, file: &CheckpointFile) -> impl Future<Output = Result<Vec<u8>>> + Send;
    fn reserve_id(&self) -> impl Future<Output = Result<String>> + Send;
    /// Idempotent for a reserved id: a retry after an ambiguous failure verifies instead of duplicating.
    fn publish(&self, id: &str, checkpoint: &Checkpoint) -> impl Future<Output = Result<()>> + Send;
    fn has_book(&self, sha256: &str, size: u64) -> impl Future<Output = Result<bool>> + Send;
    fn upload_book(&self, sha256: &str, mime: &str, bytes: Vec<u8>) -> impl Future<Output = Result<()>> + Send;
    /// `None` while the owning device has not uploaded the book yet.
    fn download_book(&self, sha256: &str, size: u64) -> impl Future<Output = Result<Option<Vec<u8>>>> + Send;
    fn prune(&self, replica: &str) -> impl Future<Output = Result<()>> + Send;
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub syncing: bool,
    pub pending: bool,
    pub last_sync: Option<i64>,
    pub error: Option<String>,
    /// The error is a lost connection rather than a Drive or data problem.
    pub offline: bool,
    /// What the running job is doing, e.g. uploading a particular book.
    pub activity: Option<String>,
    /// Epoch ms of the next automatic attempt after a failure.
    pub retry_at: Option<i64>,
    pub account: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pending {
    id: String,
    checkpoint: Checkpoint,
}

pub type Emit = Box<dyn Fn(Event) + Send + Sync>;

#[derive(Clone, Debug)]
pub enum Event {
    Status,
    Changed(Vec<Changed>),
}

struct State {
    generation: u64,
    foreground: bool,
    syncing: bool,
    due: Option<Instant>,
    poll: Instant,
    retry: Instant,
    failures: u32,
    error: Option<String>,
    activity: Option<String>,
}

pub struct Engine<T: Transport> {
    store: Arc<Store>,
    transport: T,
    state: Mutex<State>,
    wake: Notify,
    cancel: Notify,
    emit: Emit,
}

impl<T: Transport> Engine<T> {
    pub fn new(store: Arc<Store>, transport: T, emit: Emit) -> Arc<Self> {
        let now = Instant::now();
        Arc::new(Self {
            store,
            transport,
            state: Mutex::new(State {
                generation: 0,
                foreground: true,
                syncing: false,
                due: Some(now),
                poll: now + POLL,
                retry: now,
                failures: 0,
                error: None,
                activity: None,
            }),
            wake: Notify::new(),
            cancel: Notify::new(),
            emit,
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn enabled(&self) -> bool {
        self.store.meta("sync_enabled").ok().flatten().as_deref() == Some("1")
    }

    pub fn status(&self) -> SyncStatus {
        let state = self.state();
        let wait = state.retry.saturating_duration_since(Instant::now());
        SyncStatus {
            enabled: self.enabled(),
            syncing: state.syncing,
            pending: self.store.dirty().unwrap_or(false)
                || self.store.meta("pending").ok().flatten().is_some_and(|p| !p.is_empty()),
            last_sync: self.store.meta("sync_last").ok().flatten().and_then(|v| v.parse().ok()),
            offline: state.error.as_deref() == Some(OFFLINE),
            error: state.error.clone(),
            activity: state.activity.clone(),
            retry_at: (state.error.is_some() && !wait.is_zero()).then(|| now_ms() + wait.as_millis() as i64),
            account: self.store.meta("sync_email").ok().flatten().filter(|e| !e.is_empty()),
        }
    }

    fn working(&self, activity: impl Into<String>) {
        self.state().activity = Some(activity.into());
        self.publish_status();
    }

    fn publish_status(&self) {
        (self.emit)(Event::Status);
    }

    fn schedule(&self, at: Instant, reset_retry: bool) {
        {
            let mut state = self.state();
            state.due = Some(state.due.map_or(at, |d| d.min(at)));
            if reset_retry {
                state.retry = Instant::now();
            }
        }
        self.wake.notify_one();
    }

    /// A local edit was committed; publish it shortly, coalescing page turns.
    pub fn local_changed(&self) {
        self.schedule(Instant::now() + DEBOUNCE, false);
        self.publish_status();
    }

    pub fn sync_now(&self) {
        self.schedule(Instant::now(), true);
    }

    /// Android only syncs while visible; returning to the app syncs immediately.
    pub fn foreground(&self, visible: bool) {
        self.state().foreground = visible;
        if visible {
            self.schedule(Instant::now(), true);
        } else {
            self.interrupt();
        }
    }

    fn interrupt(&self) {
        let mut state = self.state();
        state.generation += 1;
        drop(state);
        self.cancel.notify_waiters();
    }

    pub async fn enable(&self) -> Result<()> {
        let account = self.transport.account().await?;
        if let Some(previous) = self.store.meta("sync_account")?.filter(|p| !p.is_empty()) {
            if previous != account.id {
                bail!("Use the same Google account to resume this sync.");
            }
        }
        self.store.set_meta("sync_account", &account.id)?;
        self.store.set_meta("sync_email", account.email.as_deref().unwrap_or(""))?;
        self.store.set_meta("sync_enabled", "1")?;
        self.state().error = None;
        self.sync_now();
        self.publish_status();
        Ok(())
    }

    pub fn pause(&self) -> Result<()> {
        self.store.set_meta("sync_enabled", "0")?;
        self.interrupt();
        self.publish_status();
        Ok(())
    }

    /// Forget the pinned account so a different one can be connected.
    pub fn forget_account(&self) -> Result<()> {
        self.pause()?;
        self.store.set_meta("sync_account", "")?;
        self.store.set_meta("sync_email", "")?;
        self.store.delete_meta_prefix("seen:", &[])?;
        self.store.delete_meta_prefix("uploaded:", &[])?;
        Ok(())
    }

    pub async fn run(self: Arc<Self>) {
        loop {
            let (due, runnable) = {
                let state = self.state();
                let due = state.due.map_or(state.poll, |d| d.min(state.poll)).max(state.retry);
                (due, state.foreground && self.enabled())
            };
            if runnable && Instant::now() >= due {
                self.attempt().await;
                continue;
            }
            tokio::select! {
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep_until(due), if runnable => {}
            }
        }
    }

    async fn attempt(&self) {
        let generation = {
            let mut state = self.state();
            state.syncing = true;
            state.due = None;
            state.generation
        };
        self.publish_status();
        let result = tokio::select! {
            result = self.sync_once(generation) => result,
            _ = self.cancel.notified() => Err(Error::new("Sync cancelled")),
        };
        {
            let mut state = self.state();
            state.syncing = false;
            state.activity = None;
            let now = Instant::now();
            state.poll = now + POLL;
            match result {
                Ok(()) => {
                    state.failures = 0;
                    state.error = None;
                    state.retry = now;
                }
                Err(error) if state.generation == generation => {
                    let backoff = 5u64 * 2u64.pow(state.failures.min(9));
                    state.failures += 1;
                    state.retry = now + Duration::from_secs(backoff.min(3600));
                    state.error = Some(error.0);
                }
                Err(_) => {}
            }
        }
        self.publish_status();
    }

    fn current(&self, generation: u64) -> Result<()> {
        let state = self.state();
        if state.generation != generation || !state.foreground || !self.enabled() {
            bail!("Sync cancelled");
        }
        Ok(())
    }

    async fn sync_once(&self, generation: u64) -> Result<()> {
        self.working("Checking Google Drive");
        let account = self.transport.account().await?;
        self.current(generation)?;
        if self.store.meta("sync_account")?.as_deref() != Some(account.id.as_str()) {
            self.pause()?;
            bail!("Google account changed. Sync is paused; reconnect the original account.");
        }
        if let Some(email) = &account.email {
            self.store.set_meta("sync_email", email)?;
        }

        // Pull: the newest checkpoint of every device, each of which subsumes its earlier ones.
        let mut latest: BTreeMap<String, CheckpointFile> = BTreeMap::new();
        for file in self.transport.list().await? {
            match latest.get(&file.replica) {
                Some(p) if p.sequence == file.sequence && p.sha256 != file.sha256 => {
                    bail!("Conflicting device checkpoint. Reader will retry.")
                }
                Some(p) if p.sequence > file.sequence || (p.sequence == file.sequence && p.id <= file.id) => {}
                _ => {
                    latest.insert(file.replica.clone(), file);
                }
            }
        }
        self.current(generation)?;
        let seen: Vec<String> = latest.values().map(|f| format!("seen:{}", f.id)).collect();
        let kinds = known_kinds();
        for file in latest.values() {
            let key = format!("seen:{}", file.id);
            // Read before by a version that knew fewer kinds, which skipped those records: read
            // it again now that they can be applied.
            let marker = format!("{} {kinds}", file.sha256);
            if self.store.meta(&key)?.as_deref() == Some(marker.as_str()) {
                continue;
            }
            self.working("Downloading changes from your other device");
            let checkpoint = validate_checkpoint(&self.transport.read(file).await?)?;
            self.current(generation)?;
            if checkpoint.replica != file.replica || checkpoint.sequence != file.sequence {
                bail!("Sync checkpoint identity mismatch");
            }
            let changed = self.store.apply(&checkpoint.records)?;
            self.store.set_meta(&key, &marker)?;
            if changed.iter().any(|c| c.kind == Kind::Book) {
                self.store.release_deleted_blobs()?;
            }
            if !changed.is_empty() {
                (self.emit)(Event::Changed(changed));
            }
        }
        self.store.delete_meta_prefix("seen:", &seen)?;

        // Push: books first, then one immutable checkpoint of everything this device knows.
        let replica = self.store.replica()?;
        let mut pending = self.store.meta("pending")?.filter(|p| !p.is_empty());
        if pending.is_none() && self.store.dirty()? {
            let id = self.transport.reserve_id().await?;
            self.current(generation)?;
            let sequence = self.store.meta("sync_sequence")?.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0) + 1;
            let checkpoint = Checkpoint { format: CHECKPOINT_FORMAT, replica: replica.clone(), sequence, records: self.store.records()? };
            let serialized = canonical(&Pending { id, checkpoint })?;
            self.store.set_meta("sync_sequence", &sequence.to_string())?;
            self.store.set_meta("pending", &serialized)?;
            self.store.set_meta("dirty", "0")?;
            pending = Some(serialized);
        }
        if let Some(pending) = pending {
            let Pending { id, checkpoint } = serde_json::from_str(&pending)?;
            self.upload_books(&checkpoint.records, generation).await?;
            self.working("Saving your changes to Google Drive");
            self.transport.publish(&id, &checkpoint).await?;
            self.current(generation)?;
            self.store.set_meta("pending", "")?;
            self.transport.prune(&replica).await?;
            self.current(generation)?;
        }

        self.store.set_meta("sync_last", &now_ms().to_string())?;
        self.download_books(generation).await
    }

    async fn upload_books(&self, records: &[Record], generation: u64) -> Result<()> {
        for record in records.iter().filter(|r| r.kind == Kind::Book && r.value.is_some()) {
            let key = format!("uploaded:{}", record.id);
            if self.store.meta(&key)?.is_some() {
                continue;
            }
            let Some(book) = self.store.book(&record.id)? else { continue };
            // Only the device holding the bytes uploads them; others already found them on Drive.
            let Some(bytes) = self.store.blob(&record.id)? else { continue };
            if !self.transport.has_book(&record.id, book.size).await? {
                self.current(generation)?;
                self.working(format!("Uploading “{}”", book.title));
                self.transport.upload_book(&record.id, book.format.mime(), bytes).await?;
            }
            self.current(generation)?;
            self.store.set_meta(&key, "1")?;
        }
        Ok(())
    }

    /// Progress sync never waits for book bytes; missing books download afterwards.
    async fn download_books(&self, generation: u64) -> Result<()> {
        for (id, book) in self.store.missing_blobs()? {
            self.working(format!("Downloading “{}”", book.title));
            let Some(bytes) = self.transport.download_book(&id, book.size).await? else { continue };
            self.current(generation)?;
            if bytes.len() as u64 != book.size || crate::library::sha256(&bytes) != id {
                bail!("Downloaded book checksum mismatch");
            }
            self.store.put_blob(&id, &bytes)?;
            self.store.set_meta(&format!("uploaded:{id}"), "1")?;
            (self.emit)(Event::Changed(vec![Changed { kind: Kind::Book, id }]));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::sha256;
    use serde_json::json;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Remote {
        files: Vec<(CheckpointFile, Vec<u8>)>,
        books: HashMap<String, Vec<u8>>,
        next: u32,
        fail_publish_after_store: bool,
        offline: bool,
    }

    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<Remote>>);

    impl Transport for Fake {
        async fn account(&self) -> Result<Account> {
            if self.0.lock().unwrap().offline {
                return Err(Error::new(OFFLINE));
            }
            Ok(Account { id: "account".into(), email: Some("reader@example.com".into()) })
        }
        async fn list(&self) -> Result<Vec<CheckpointFile>> {
            Ok(self.0.lock().unwrap().files.iter().map(|f| f.0.clone()).collect())
        }
        async fn read(&self, file: &CheckpointFile) -> Result<Vec<u8>> {
            Ok(self.0.lock().unwrap().files.iter().find(|f| f.0.id == file.id).unwrap().1.clone())
        }
        async fn reserve_id(&self) -> Result<String> {
            let mut remote = self.0.lock().unwrap();
            remote.next += 1;
            Ok(format!("file{}", remote.next))
        }
        async fn publish(&self, id: &str, checkpoint: &Checkpoint) -> Result<()> {
            let bytes = canonical(checkpoint)?.into_bytes();
            let mut remote = self.0.lock().unwrap();
            if !remote.files.iter().any(|f| f.0.id == id) {
                let file = CheckpointFile {
                    id: id.into(),
                    replica: checkpoint.replica.clone(),
                    sequence: checkpoint.sequence,
                    sha256: sha256(&bytes),
                };
                remote.files.push((file, bytes));
            }
            if std::mem::take(&mut remote.fail_publish_after_store) {
                return Err(Error::new("timeout"));
            }
            Ok(())
        }
        async fn has_book(&self, sha: &str, _: u64) -> Result<bool> {
            Ok(self.0.lock().unwrap().books.contains_key(sha))
        }
        async fn upload_book(&self, sha: &str, _: &str, bytes: Vec<u8>) -> Result<()> {
            self.0.lock().unwrap().books.insert(sha.into(), bytes);
            Ok(())
        }
        async fn download_book(&self, sha: &str, _: u64) -> Result<Option<Vec<u8>>> {
            Ok(self.0.lock().unwrap().books.get(sha).cloned())
        }
        async fn prune(&self, replica: &str) -> Result<()> {
            let mut remote = self.0.lock().unwrap();
            let mut own: Vec<u64> = remote.files.iter().filter(|f| f.0.replica == replica).map(|f| f.0.sequence).collect();
            own.sort_unstable_by(|a, b| b.cmp(a));
            let keep: Vec<u64> = own.into_iter().take(2).collect();
            remote.files.retain(|f| f.0.replica != replica || keep.contains(&f.0.sequence));
            Ok(())
        }
    }

    fn device(remote: &Fake) -> Arc<Engine<Fake>> {
        let store = Arc::new(Store::memory().unwrap());
        store.set_meta("sync_enabled", "1").unwrap();
        store.set_meta("sync_account", "account").unwrap();
        Engine::new(store, remote.clone(), Box::new(|_| {}))
    }

    async fn sync(engine: &Engine<Fake>) -> Result<()> {
        let generation = engine.state().generation;
        engine.sync_once(generation).await
    }

    fn import(engine: &Engine<Fake>, bytes: &[u8]) -> String {
        let id = sha256(bytes);
        let book = json!({ "title": "Dune", "author": null, "format": "pdf", "size": bytes.len(), "addedAt": 1 });
        engine.store.put_blob(&id, bytes).unwrap();
        engine.store.stamp(vec![(Kind::Book, id.clone(), Some(book))]).unwrap();
        id
    }

    fn read_to(engine: &Engine<Fake>, book: &str, page: &str) {
        let value = json!({ "location": page, "label": format!("Page {page}"), "fraction": 0.1, "updatedAt": now_ms() });
        engine.store.stamp(vec![(Kind::Progress, book.into(), Some(value))]).unwrap();
    }

    #[tokio::test]
    async fn a_book_and_its_page_reach_the_other_device() {
        let remote = Fake::default();
        let (desktop, phone) = (device(&remote), device(&remote));
        let book = import(&desktop, b"%PDF-1.7 book");
        read_to(&desktop, &book, "42");
        sync(&desktop).await.unwrap();
        sync(&phone).await.unwrap();

        let books = phone.store.books().unwrap();
        assert_eq!(books.len(), 1);
        assert!(books[0].available);
        assert_eq!(books[0].progress.as_ref().unwrap().location, "42");
        assert_eq!(phone.status().account.as_deref(), Some("reader@example.com"));

        std::thread::sleep(Duration::from_millis(2));
        read_to(&phone, &book, "57");
        sync(&phone).await.unwrap();
        sync(&desktop).await.unwrap();
        assert_eq!(desktop.store.progress(&book).unwrap().unwrap().location, "57");
        assert!(!desktop.status().pending && !phone.status().pending);
    }

    #[tokio::test]
    async fn checkpoints_read_by_an_older_version_are_read_again() {
        let remote = Fake::default();
        let (phone, desktop) = (device(&remote), device(&remote));
        let book = import(&phone, b"%PDF-1.7 book");
        let collection = "0b8e8a52-6f1c-4d1e-9a39-1d5f0c6f6c11";
        phone
            .store
            .stamp(vec![(Kind::Collection, collection.into(), Some(json!({ "name": "Finance", "createdAt": 1 })))])
            .unwrap();
        phone
            .store
            .stamp(vec![(Kind::Member, format!("{collection}:{book}"), Some(json!({ "at": 1 })))])
            .unwrap();
        sync(&phone).await.unwrap();

        // An older desktop read the phone's checkpoint without knowing collections: it took the
        // book, skipped the rest and marked the checkpoint read the old way (just its hash).
        let file = remote.0.lock().unwrap().files.last().unwrap().0.clone();
        let only_book: Vec<Record> = phone.store.records().unwrap().into_iter().filter(|r| r.kind == Kind::Book).collect();
        desktop.store.apply(&only_book).unwrap();
        desktop.store.set_meta(&format!("seen:{}", file.id), &file.sha256).unwrap();

        sync(&desktop).await.unwrap();
        let collections = desktop.store.collections().unwrap();
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].books, [book]);
        // And once read with every kind known, it isn't read again.
        assert_eq!(
            desktop.store.meta(&format!("seen:{}", file.id)).unwrap(),
            Some(format!("{} {}", file.sha256, known_kinds()))
        );
    }

    #[tokio::test]
    async fn an_ambiguous_publish_retries_the_same_file() {
        let remote = Fake::default();
        let desktop = device(&remote);
        read_to(&desktop, &"a".repeat(64), "3");
        remote.0.lock().unwrap().fail_publish_after_store = true;
        assert!(sync(&desktop).await.is_err());
        sync(&desktop).await.unwrap();
        let files = remote.0.lock().unwrap().files.len();
        assert_eq!(files, 1);
        assert!(!desktop.status().pending);
    }

    #[tokio::test]
    async fn only_two_checkpoints_per_device_are_kept() {
        let remote = Fake::default();
        let desktop = device(&remote);
        for page in 1..=5 {
            read_to(&desktop, &"a".repeat(64), &page.to_string());
            sync(&desktop).await.unwrap();
        }
        assert_eq!(remote.0.lock().unwrap().files.len(), 2);
        let phone = device(&remote);
        sync(&phone).await.unwrap();
        assert_eq!(phone.store.progress(&"a".repeat(64)).unwrap().unwrap().location, "5");
    }

    #[tokio::test]
    async fn going_offline_keeps_changes_pending_and_schedules_a_retry() {
        let remote = Fake::default();
        let desktop = device(&remote);
        read_to(&desktop, &"a".repeat(64), "3");
        remote.0.lock().unwrap().offline = true;
        desktop.attempt().await;
        let status = desktop.status();
        assert!(status.offline && status.pending && !status.syncing);
        assert!(status.activity.is_none());
        assert!(status.retry_at.is_some_and(|at| at > now_ms()));

        remote.0.lock().unwrap().offline = false;
        desktop.sync_now();
        desktop.attempt().await;
        let status = desktop.status();
        assert!(!status.offline && !status.pending && status.error.is_none() && status.retry_at.is_none());
    }

    #[tokio::test]
    async fn paused_sync_does_not_run() {
        let remote = Fake::default();
        let desktop = device(&remote);
        read_to(&desktop, &"a".repeat(64), "3");
        desktop.pause().unwrap();
        assert!(sync(&desktop).await.is_err());
        assert!(remote.0.lock().unwrap().files.is_empty());
    }

    #[tokio::test]
    async fn deleting_a_book_on_one_device_removes_it_on_the_other() {
        let remote = Fake::default();
        let (desktop, phone) = (device(&remote), device(&remote));
        let book = import(&desktop, b"%PDF-1.7 other");
        sync(&desktop).await.unwrap();
        sync(&phone).await.unwrap();
        assert!(phone.store.has_blob(&book).unwrap());
        desktop.store.stamp(vec![(Kind::Book, book.clone(), None)]).unwrap();
        sync(&desktop).await.unwrap();
        sync(&phone).await.unwrap();
        assert!(phone.store.books().unwrap().is_empty());
        assert!(!phone.store.has_blob(&book).unwrap());
    }
}
