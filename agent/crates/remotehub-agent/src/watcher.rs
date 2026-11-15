//! Native filesystem watcher for the Files surface (SAA-297).
//!
//! Wraps the `notify` crate (inotify on Linux, FSEvents on macOS,
//! ReadDirectoryChangesW on Windows) and normalizes its platform-specific events
//! into four browser-facing changes — `create`, `delete`, `modify`, `rename` —
//! plus `unavailable` when the watched directory itself goes away.
//!
//! * Only the requested directory is watched (non-recursive), after it has been
//!   confined to the agent root with [`files::confine`].
//! * Each watch has its own thread that blocks on a channel; it wakes only when the
//!   OS reports a change (or briefly to settle an unpaired rename), so an idle
//!   watch costs no polling.
//! * [`DirectoryWatch::stop`] (or dropping the watch) unregisters the OS watch and
//!   joins its thread.
//!
//! Wiring this into the control protocol (`watchDirectory` / `filesystemEvent`) is
//! done by the SAA-295 protocol layer; this module only produces [`Change`]s.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::event::{EventKind, ModifyKind, RenameMode};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use crate::files;

/// How long a rename "from" half waits for its "to" half before it is reported as
/// a delete (the entry moved out of the watched directory).
pub const RENAME_SETTLE: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Create,
    Delete,
    Modify,
    Rename,
    Unavailable,
}

impl ChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeKind::Create => "create",
            ChangeKind::Delete => "delete",
            ChangeKind::Modify => "modify",
            ChangeKind::Rename => "rename",
            ChangeKind::Unavailable => "unavailable",
        }
    }
}

/// One normalized change. `from` is set only for renames.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub watch_id: u64,
    pub kind: ChangeKind,
    pub path: PathBuf,
    pub from: Option<PathBuf>,
}

/// A live, non-recursive watch on one directory.
pub struct DirectoryWatch {
    id: u64,
    path: PathBuf,
    /// The parent directory, also watched (non-recursively) so the removal or
    /// rename of the watched directory itself is reported on every platform:
    /// Windows' ReadDirectoryChangesW never reports its own directory going away.
    parent: Option<PathBuf>,
    watcher: Option<RecommendedWatcher>,
    worker: Option<JoinHandle<()>>,
}

impl DirectoryWatch {
    /// Start watching `requested` (resolved against `root`) and send normalized
    /// changes to `sink`. Fails if the path is missing, escapes the root, or is not
    /// a directory.
    pub fn start(id: u64, root: &Path, requested: &str, sink: Sender<Change>) -> io::Result<DirectoryWatch> {
        let path = files::confine(root, requested)?;
        if !path.is_dir() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "watch target is not a directory"));
        }
        let (raw_tx, raw_rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            let _ = raw_tx.send(result);
        })
        .map_err(to_io)?;
        watcher.watch(&path, RecursiveMode::NonRecursive).map_err(to_io)?;
        // Best effort: an unreadable parent only loses the early "unavailable" signal.
        let parent = path
            .parent()
            .filter(|parent| watcher.watch(parent, RecursiveMode::NonRecursive).is_ok())
            .map(Path::to_path_buf);
        let watched = path.clone();
        let worker = thread::Builder::new()
            .name(format!("watch-{id}"))
            .spawn(move || pump(id, watched, raw_rx, sink))?;
        Ok(DirectoryWatch { id, path, parent, watcher: Some(watcher), worker: Some(worker) })
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Unregister the OS watch and wait for the worker thread to finish.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        // Dropping the notify watcher drops its event callback and so the raw
        // sender, which ends the worker's receive loop.
        if let Some(mut watcher) = self.watcher.take() {
            let _ = watcher.unwatch(&self.path);
            if let Some(parent) = &self.parent {
                let _ = watcher.unwatch(parent);
            }
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for DirectoryWatch {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn to_io(error: notify::Error) -> io::Error {
    match error.kind {
        notify::ErrorKind::Io(inner) => inner,
        notify::ErrorKind::PathNotFound => io::Error::new(io::ErrorKind::NotFound, "watch path not found"),
        other => io::Error::new(io::ErrorKind::Other, format!("{other:?}")),
    }
}

/// Turns raw notify events into normalized changes until the watcher is dropped,
/// the sink is closed, or the watched directory disappears.
fn pump(id: u64, watched: PathBuf, raw: Receiver<notify::Result<Event>>, sink: Sender<Change>) {
    let mut normalizer = Normalizer::new(id, watched);
    loop {
        let timeout = normalizer.next_deadline().map(|deadline| deadline.saturating_duration_since(Instant::now()));
        let received = match timeout {
            Some(wait) => raw.recv_timeout(wait),
            None => raw.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        let changes = match received {
            Ok(Ok(event)) => normalizer.push(event, Instant::now()),
            // Backends report a vanished directory as an error on some platforms.
            Ok(Err(_)) => normalizer.check_still_there(),
            Err(RecvTimeoutError::Timeout) => normalizer.flush_expired(Instant::now()),
            Err(RecvTimeoutError::Disconnected) => return,
        };
        for change in changes {
            let lost = change.kind == ChangeKind::Unavailable;
            if sink.send(change).is_err() || lost {
                return;
            }
        }
    }
}

/// Platform normalization, kept free of threads and OS calls (other than an
/// `exists` check for ambiguous renames) so it can be unit tested with synthetic
/// events.
struct Normalizer {
    id: u64,
    watched: PathBuf,
    /// Rename "from" halves waiting for their partner, keyed by notify's tracker.
    pending: HashMap<usize, (PathBuf, Instant)>,
    lost: bool,
}

impl Normalizer {
    fn new(id: u64, watched: PathBuf) -> Normalizer {
        Normalizer { id, watched, pending: HashMap::new(), lost: false }
    }

    fn change(&self, kind: ChangeKind, path: PathBuf, from: Option<PathBuf>) -> Change {
        Change { watch_id: self.id, kind, path, from }
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().map(|(_, at)| *at + RENAME_SETTLE).min()
    }

    fn flush_expired(&mut self, now: Instant) -> Vec<Change> {
        let expired: Vec<usize> = self.pending.iter().filter(|(_, (_, at))| now >= *at + RENAME_SETTLE).map(|(key, _)| *key).collect();
        let mut out = Vec::new();
        for key in expired {
            if let Some((path, _)) = self.pending.remove(&key) {
                out.push(self.change(ChangeKind::Delete, path, None));
            }
        }
        out
    }

    /// After a backend error: if the watched directory is gone, end the watch.
    fn check_still_there(&mut self) -> Vec<Change> {
        if self.lost || self.watched.is_dir() {
            return Vec::new();
        }
        self.lost = true;
        vec![self.change(ChangeKind::Unavailable, self.watched.clone(), None)]
    }

    /// The watched directory itself, or one of its direct children. Events for
    /// siblings (from the parent watch) are dropped.
    fn relevant(&self, path: &Path) -> bool {
        path == self.watched || path.parent() == Some(self.watched.as_path())
    }

    fn push(&mut self, event: Event, now: Instant) -> Vec<Change> {
        if self.lost {
            return Vec::new();
        }
        let mut out = self.flush_expired(now);
        let tracker = event.attrs.tracker();
        // A rename reported with both ends: classify by which ends are ours.
        if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = event.kind {
            if let Some(key) = tracker {
                self.pending.remove(&key);
            }
            let mut ends = event.paths.into_iter();
            if let (Some(from), Some(to)) = (ends.next(), ends.next()) {
                if from == self.watched {
                    self.lost = true;
                    out.push(self.change(ChangeKind::Unavailable, from, None));
                    return out;
                }
                match (self.relevant(&from), self.relevant(&to) && to != self.watched) {
                    (true, true) => out.push(self.change(ChangeKind::Rename, to, Some(from))),
                    (true, false) => out.push(self.change(ChangeKind::Delete, from, None)),
                    (false, true) => out.push(self.change(ChangeKind::Create, to, None)),
                    (false, false) => {}
                }
            }
            return out;
        }
        let kept: Vec<PathBuf> = event.paths.into_iter().filter(|path| self.relevant(path)).collect();
        if kept.is_empty() {
            return out;
        }
        let mut paths = kept.into_iter();

        // The watched directory itself was removed or moved away.
        let touches_root = |kind: &EventKind, path: &Path| {
            path == self.watched
                && matches!(kind, EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From | RenameMode::Any)))
        };

        match event.kind {
            // FSEvents can replay the watched directory's own creation; only its
            // removal matters (handled below), so never report it as a child.
            EventKind::Create(_) => out.extend(paths.filter(|path| *path != self.watched).map(|path| self.change(ChangeKind::Create, path, None))),
            EventKind::Remove(_) => {
                for path in paths {
                    if touches_root(&event.kind, &path) {
                        self.lost = true;
                        out.push(self.change(ChangeKind::Unavailable, path, None));
                        return out;
                    }
                    out.push(self.change(ChangeKind::Delete, path, None));
                }
            }
            EventKind::Modify(ModifyKind::Name(mode)) => match (mode, tracker) {
                (RenameMode::From, Some(key)) => {
                    if let Some(path) = paths.next() {
                        if touches_root(&event.kind, &path) {
                            self.lost = true;
                            out.push(self.change(ChangeKind::Unavailable, path, None));
                            return out;
                        }
                        self.pending.insert(key, (path, now));
                    }
                }
                (RenameMode::To, Some(key)) => {
                    // A paired "to" is followed by a "both"; an unpaired one is a move-in.
                    if !self.pending.contains_key(&key) {
                        out.extend(paths.map(|path| self.change(ChangeKind::Create, path, None)));
                    }
                }
                (RenameMode::From, None) => out.extend(paths.map(|path| self.change(ChangeKind::Delete, path, None))),
                (RenameMode::To, None) => out.extend(paths.map(|path| self.change(ChangeKind::Create, path, None))),
                // FSEvents and some backends report renames without a direction.
                _ => {
                    for path in paths {
                        if touches_root(&event.kind, &path) && !path.exists() {
                            self.lost = true;
                            out.push(self.change(ChangeKind::Unavailable, path, None));
                            return out;
                        }
                        if path == self.watched {
                            continue;
                        }
                        let kind = if path.exists() { ChangeKind::Create } else { ChangeKind::Delete };
                        out.push(self.change(kind, path, None));
                    }
                }
            },
            EventKind::Modify(_) => {
                out.extend(paths.filter(|path| *path != self.watched).map(|path| self.change(ChangeKind::Modify, path, None)))
            }
            // Access and unclassified events carry nothing the browser needs.
            EventKind::Access(_) | EventKind::Any | EventKind::Other => {}
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, RemoveKind};
    use std::fs;

    fn event(kind: EventKind, paths: &[&str], tracker: Option<usize>) -> Event {
        let mut event = Event::new(kind);
        for path in paths {
            event = event.add_path(PathBuf::from(path));
        }
        if let Some(key) = tracker {
            event = event.set_tracker(key);
        }
        event
    }

    fn kinds(changes: &[Change]) -> Vec<ChangeKind> {
        changes.iter().map(|change| change.kind).collect()
    }

    #[test]
    fn normalizes_basic_platform_events() {
        let mut n = Normalizer::new(1, PathBuf::from("/w"));
        let now = Instant::now();
        assert_eq!(kinds(&n.push(event(EventKind::Create(CreateKind::File), &["/w/a"], None), now)), vec![ChangeKind::Create]);
        assert_eq!(kinds(&n.push(event(EventKind::Modify(ModifyKind::Data(DataChange::Any)), &["/w/a"], None), now)), vec![ChangeKind::Modify]);
        assert_eq!(kinds(&n.push(event(EventKind::Remove(RemoveKind::File), &["/w/a"], None), now)), vec![ChangeKind::Delete]);
        assert!(n.push(event(EventKind::Access(notify::event::AccessKind::Any), &["/w/a"], None), now).is_empty());
    }

    #[test]
    fn pairs_inotify_style_renames_into_one_rename() {
        let mut n = Normalizer::new(1, PathBuf::from("/w"));
        let now = Instant::now();
        assert!(n.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::From)), &["/w/a"], Some(7)), now).is_empty());
        assert!(n.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::To)), &["/w/b"], Some(7)), now).is_empty());
        let both = n.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["/w/a", "/w/b"], Some(7)), now);
        assert_eq!(both, vec![Change { watch_id: 1, kind: ChangeKind::Rename, path: "/w/b".into(), from: Some("/w/a".into()) }]);
        assert!(n.flush_expired(now + RENAME_SETTLE * 2).is_empty(), "the pending half was consumed");
    }

    #[test]
    fn unpaired_rename_halves_become_delete_and_create() {
        let mut n = Normalizer::new(1, PathBuf::from("/w"));
        let now = Instant::now();
        assert!(n.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::From)), &["/w/out"], Some(1)), now).is_empty());
        assert_eq!(kinds(&n.flush_expired(now + RENAME_SETTLE)), vec![ChangeKind::Delete]);
        assert_eq!(kinds(&n.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::To)), &["/w/in"], Some(2)), now)), vec![ChangeKind::Create]);
    }

    #[test]
    fn sibling_events_from_the_parent_watch_are_dropped_but_self_removal_is_not() {
        let mut n = Normalizer::new(1, PathBuf::from("/p/w"));
        let now = Instant::now();
        assert!(n.push(event(EventKind::Create(CreateKind::File), &["/p/other.txt"], None), now).is_empty());
        assert!(n.push(event(EventKind::Remove(RemoveKind::File), &["/p/w/deep/x"], None), now).is_empty());
        // Moving a file between the watched dir and its parent.
        assert_eq!(kinds(&n.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["/p/w/a", "/p/a"], Some(3)), now)), vec![ChangeKind::Delete]);
        assert_eq!(kinds(&n.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["/p/b", "/p/w/b"], Some(4)), now)), vec![ChangeKind::Create]);
        assert!(n.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["/p/c", "/p/d"], Some(5)), now).is_empty());
        // The parent watch reports the watched directory being removed (Windows path).
        assert_eq!(kinds(&n.push(event(EventKind::Remove(RemoveKind::Any), &["/p/w"], None), now)), vec![ChangeKind::Unavailable]);
    }

    #[test]
    fn renaming_the_watched_directory_away_ends_the_watch() {
        let mut n = Normalizer::new(1, PathBuf::from("/p/w"));
        let out = n.push(event(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["/p/w", "/p/w2"], Some(1)), Instant::now());
        assert_eq!(kinds(&out), vec![ChangeKind::Unavailable]);
    }

    #[test]
    fn events_about_the_watched_directory_itself_are_not_reported_as_children() {
        // macOS FSEvents can replay the creation of the directory being watched.
        let mut n = Normalizer::new(1, PathBuf::from("/w"));
        let now = Instant::now();
        assert!(n.push(event(EventKind::Create(CreateKind::Folder), &["/w"], None), now).is_empty());
        assert!(n.push(event(EventKind::Modify(ModifyKind::Metadata(notify::event::MetadataKind::Any)), &["/w"], None), now).is_empty());
        assert_eq!(kinds(&n.push(event(EventKind::Create(CreateKind::File), &["/w/a"], None), now)), vec![ChangeKind::Create]);
    }

    /// Portable live check for CI on Linux, macOS and Windows: it only asserts
    /// that each operation produces *some* event naming the affected path with an
    /// acceptable kind, and never one for the watched directory as a child. It
    /// tolerates ordering, extra `modify` noise, and backends that coalesce or
    /// split renames into delete+create.
    #[test]
    fn portable_watch_reports_each_operation_for_the_right_path() {
        let root = scratch("portable");
        let (tx, rx) = mpsc::channel();
        let watch = DirectoryWatch::start(5, &root, ".", tx).unwrap();
        let watched = watch.path().to_path_buf();
        let same = |a: &Path, b: &Path| a.file_name() == b.file_name();
        let wait_for = |what: &str, ok: &dyn Fn(&Change) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut seen = Vec::new();
            while Instant::now() < deadline {
                if let Ok(change) = rx.recv_timeout(Duration::from_millis(100)) {
                    assert!(!(change.path == watched && change.kind != ChangeKind::Unavailable), "watched dir reported as a child: {change:?}");
                    assert_eq!(change.watch_id, 5);
                    if ok(&change) {
                        return;
                    }
                    seen.push(change);
                }
            }
            panic!("no event for {what}; saw {seen:?}");
        };

        let a = watched.join("p-a.txt");
        fs::write(&a, b"1").unwrap();
        wait_for("create", &|c| same(&c.path, &a) && matches!(c.kind, ChangeKind::Create | ChangeKind::Modify));
        // Give coalescing backends a moment so the write is a separate event.
        thread::sleep(Duration::from_millis(300));
        fs::write(&a, b"more data").unwrap();
        wait_for("modify", &|c| same(&c.path, &a) && matches!(c.kind, ChangeKind::Modify | ChangeKind::Create));
        let b = watched.join("p-b.txt");
        fs::rename(&a, &b).unwrap();
        wait_for("rename", &|c| same(&c.path, &b) && matches!(c.kind, ChangeKind::Rename | ChangeKind::Create | ChangeKind::Modify));
        fs::remove_file(&b).unwrap();
        wait_for("delete", &|c| same(&c.path, &b) && matches!(c.kind, ChangeKind::Delete | ChangeKind::Rename));

        watch.stop();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn removing_the_watched_directory_reports_unavailable_once() {
        let mut n = Normalizer::new(3, PathBuf::from("/w"));
        let now = Instant::now();
        let out = n.push(event(EventKind::Remove(RemoveKind::Folder), &["/w"], None), now);
        assert_eq!(kinds(&out), vec![ChangeKind::Unavailable]);
        assert!(n.push(event(EventKind::Create(CreateKind::File), &["/w/x"], None), now).is_empty());
    }

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("remotehub-watch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    /// Wait for a change matching `want`, ignoring others (platforms differ in noise).
    fn expect(rx: &Receiver<Change>, want: impl Fn(&Change) -> bool) -> Change {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(change) if want(&change) => return change,
                Ok(_) => continue,
                Err(_) => panic!("timed out waiting for change"),
            }
        }
    }

    #[test]
    fn live_watch_reports_create_modify_rename_delete_and_stops() {
        let root = scratch("live");
        let (tx, rx) = mpsc::channel();
        let watch = DirectoryWatch::start(9, &root, ".", tx).unwrap();
        assert_eq!(watch.id(), 9);

        let a = root.join("a.txt");
        fs::write(&a, b"1").unwrap();
        expect(&rx, |c| c.kind == ChangeKind::Create && c.path == a);
        fs::write(&a, b"22").unwrap();
        expect(&rx, |c| c.kind == ChangeKind::Modify && c.path == a);
        let b = root.join("b.txt");
        fs::rename(&a, &b).unwrap();
        expect(&rx, |c| (c.kind == ChangeKind::Rename && c.path == b) || (c.kind == ChangeKind::Create && c.path == b));
        fs::remove_file(&b).unwrap();
        expect(&rx, |c| c.kind == ChangeKind::Delete && c.path == b);

        // Only the requested directory: changes in a subdirectory's contents are not reported.
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        expect(&rx, |c| c.kind == ChangeKind::Create && c.path == sub);

        watch.stop();
        fs::write(root.join("after.txt"), b"x").unwrap();
        thread::sleep(Duration::from_millis(200));
        assert!(rx.try_iter().all(|c| c.path != root.join("after.txt")), "no events after stop");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn deleting_the_watched_directory_ends_the_watch() {
        let root = scratch("gone");
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        let (tx, rx) = mpsc::channel();
        let _watch = DirectoryWatch::start(2, &root, "target", tx).unwrap();
        fs::remove_dir(&target).unwrap();
        expect(&rx, |c| c.kind == ChangeKind::Unavailable);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn refuses_missing_escaping_and_non_directory_targets() {
        let root = scratch("refuse");
        fs::write(root.join("file.txt"), b"x").unwrap();
        let (tx, _rx) = mpsc::channel();
        assert!(DirectoryWatch::start(1, &root, "missing", tx.clone()).is_err());
        assert!(DirectoryWatch::start(1, &root, "..", tx.clone()).is_err());
        assert!(DirectoryWatch::start(1, &root, "file.txt", tx).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
