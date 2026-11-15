//! Filesystem operations are resolved through a cap-std directory capability rooted
//! at the operator-configured agent directory. Requested relative paths cannot
//! traverse outside that root, including through symlinks. Symlinks whose targets
//! remain within the root are allowed.

use cap_std::ambient_authority;
use cap_std::fs::Dir;
use std::collections::BTreeMap;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use crate::json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind { File, Directory, Symlink, Other }

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self { EntryKind::File => "file", EntryKind::Directory => "directory", EntryKind::Symlink => "symlink", EntryKind::Other => "other" }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry { pub name: String, pub path: String, pub kind: EntryKind, pub size: u64 }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectoryPage {
    pub entries: Vec<Entry>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

pub const DEFAULT_DIRECTORY_PAGE_SIZE: usize = 100;
pub const MAX_DIRECTORY_PAGE_SIZE: usize = 256;
const MAX_DIRECTORY_CURSOR_BYTES: usize = 4096;

impl Entry {
    pub fn to_value(&self) -> Value {
        Value::object(vec![
            ("name", Value::string(self.name.clone())),
            ("path", Value::string(self.path.clone())),
            ("kind", Value::string(self.kind.as_str())),
            ("size", Value::Number(self.size as f64)),
        ])
    }
}

pub const MAX_TEXT_FILE: u64 = 64 * 1024;
pub const MAX_WRITE_FILE: usize = 1024 * 1024;

/// Convert the requested path to a path relative to the configured root. Absolute
/// paths are accepted only when beneath that root; parent traversal is rejected.
fn relative_path(root: &Path, requested: &str) -> io::Result<(PathBuf, PathBuf)> {
    let root = root.canonicalize()?;
    let requested = Path::new(requested);
    let relative = if requested.is_absolute() {
        requested.strip_prefix(&root).map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "path escapes the agent root"))?.to_path_buf()
    } else { requested.to_path_buf() };
    if relative.components().any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "path escapes the agent root"));
    }
    Ok((root, relative))
}

fn open_root(root: &Path) -> io::Result<Dir> {
    Dir::open_ambient_dir(root, ambient_authority())
}

pub fn list_dir(path: &Path) -> io::Result<Vec<Entry>> { list_dir_under_root(path, ".") }

/// Return the next name-sorted page after a cursor while retaining at most limit + 1 entries.
pub fn list_dir_page_under_root(root: &Path, requested: &str, cursor: Option<&str>, limit: usize) -> io::Result<DirectoryPage> {
    if limit == 0 || limit > MAX_DIRECTORY_PAGE_SIZE {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "directory page limit must be between 1 and 256"));
    }
    if cursor.is_some_and(|value| value.len() > MAX_DIRECTORY_CURSOR_BYTES) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "directory page cursor exceeds 4096 UTF-8 bytes"));
    }
    let (root, relative) = relative_path(root, requested)?;
    let dir = open_root(&root)?;
    let mut candidates = BTreeMap::new();
    let retain = limit + 1;
    for item in dir.read_dir(&relative)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if cursor.is_some_and(|after| name.as_str() <= after) { continue; }
        let metadata = item.metadata()?;
        let file_type = item.file_type()?;
        let kind = if file_type.is_symlink() { EntryKind::Symlink }
            else if file_type.is_dir() { EntryKind::Directory }
            else if file_type.is_file() { EntryKind::File }
            else { EntryKind::Other };
        let entry_path = root.join(&relative).join(item.file_name());
        candidates.insert(name.clone(), Entry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            kind,
            size: metadata.len(),
        });
        if candidates.len() > retain {
            if let Some(last) = candidates.keys().next_back().cloned() { candidates.remove(&last); }
        }
    }
    let has_more = candidates.len() > limit;
    let entries = candidates.into_values().take(limit).collect::<Vec<_>>();
    let next_cursor = has_more.then(|| entries.last().map(|entry| entry.name.clone())).flatten();
    Ok(DirectoryPage { entries, next_cursor, has_more })
}

pub fn list_dir_under_root(root: &Path, requested: &str) -> io::Result<Vec<Entry>> {
    let (root, relative) = relative_path(root, requested)?;
    let dir = open_root(&root)?;
    let mut entries = Vec::new();
    for item in dir.read_dir(&relative)? {
        let item = item?;
        let metadata = item.metadata()?;
        let file_type = item.file_type()?;
        let kind = if file_type.is_symlink() { EntryKind::Symlink }
            else if file_type.is_dir() { EntryKind::Directory }
            else if file_type.is_file() { EntryKind::File }
            else { EntryKind::Other };
        let name = item.file_name().to_string_lossy().into_owned();
        let entry_path = root.join(&relative).join(item.file_name());
        entries.push(Entry { name, path: entry_path.to_string_lossy().into_owned(), kind, size: metadata.len() });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

pub fn read_text(root: &Path, requested: &str) -> io::Result<String> {
    let (root, relative) = relative_path(root, requested)?;
    let dir = open_root(&root)?;
    let mut file = dir.open(&relative)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_TEXT_FILE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file is not regular text or exceeds 64 KiB"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref().take(MAX_TEXT_FILE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_TEXT_FILE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file exceeds 64 KiB"));
    }
    String::from_utf8(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "file is not valid UTF-8 text"))
}

pub fn write_text(root: &Path, requested: &str, content: &str) -> io::Result<()> {
    if content.len() > MAX_WRITE_FILE {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "content exceeds 1 MiB in UTF-8 bytes"));
    }
    let (root, relative) = relative_path(root, requested)?;
    if relative.as_os_str().is_empty() { return Err(io::Error::new(io::ErrorKind::InvalidInput, "file path has no name")); }
    let dir = open_root(&root)?;
    dir.write(&relative, content.as_bytes())
}

/// Legacy lexical helper for display/validation. Filesystem operations must use the
/// capability-based functions above.
pub fn confine(root: &Path, requested: &str) -> io::Result<PathBuf> {
    let (root, relative) = relative_path(root, requested)?;
    let candidate = root.join(relative);
    let resolved = candidate.canonicalize()?;
    if resolved == root || resolved.starts_with(&root) { Ok(resolved) }
    else { Err(io::Error::new(io::ErrorKind::PermissionDenied, "path escapes the agent root")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!("remotehub-agent-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn lists_directories_then_files_sorted_by_name() {
        let root = scratch("list");
        fs::write(root.join("beta.txt"), b"hello").unwrap();
        fs::create_dir(root.join("alpha")).unwrap();
        let entries = list_dir(&root).unwrap();
        assert_eq!(entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(), vec!["alpha", "beta.txt"]);
        assert_eq!(entries[0].kind, EntryKind::Directory);
        assert_eq!(entries[1].kind, EntryKind::File);
        assert_eq!(entries[1].size, 5);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn confine_rejects_paths_outside_the_root() {
        let root = scratch("confine");
        fs::write(root.join("inside.txt"), b"x").unwrap();
        assert!(confine(&root, "inside.txt").is_ok());
        assert!(confine(&root, ".").is_ok());
        assert!(confine(&root, "../").is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
