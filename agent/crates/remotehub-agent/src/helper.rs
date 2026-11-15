//! Temporary helper lifecycle (SAA-299).
//!
//! RemoteHub uploads this same binary over SFTP into a fresh private directory
//! named `remotehub-helper-<random>`, writes a single-use token next to it, and
//! runs it over SSH as
//!
//! ```text
//! <dir>/remotehub-agent --mode temporary --root <home> \
//!     --helper-token-file <dir>/session-token --helper-cleanup
//! ```
//!
//! The helper then:
//!
//! 1. reads the token and deletes the token file at once (it is never on disk
//!    for longer than the start-up, never in argv/env, never logged),
//! 2. speaks the normal protocol on stdin/stdout — the SSH exec channel, so the
//!    host needs no listening port and RemoteHub needs no inbound reachability,
//! 3. requires the token in the first request (`hello`), compared in constant
//!    time; a missing or wrong token gets one `unauthorized` reply and the helper
//!    exits,
//! 4. exits if nobody authenticates within `--helper-ttl` seconds, and
//! 5. on every exit path (session end, refusal, expiry, I/O error) deletes its
//!    own binary and the temporary directory. It never installs a service.
//!
//! Cleanup only ever touches a directory whose name starts with
//! [`HELPER_DIR_PREFIX`], so a mistaken `--helper-cleanup` on a real install
//! cannot delete it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Temporary directories created by RemoteHub for a helper start with this.
pub const HELPER_DIR_PREFIX: &str = "remotehub-helper-";

/// Read the single-use token and remove the file. Fails if the file cannot be
/// deleted, so a token is never left behind for a second use.
pub fn take_token(path: &Path) -> io::Result<String> {
    let contents = fs::read_to_string(path)?;
    fs::remove_file(path)?;
    let token = contents.trim().to_string();
    let valid = (64..=256).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "helper token file is malformed"));
    }
    Ok(token)
}

/// What [`cleanup`] removed.
#[derive(Debug, PartialEq, Eq)]
pub enum Cleanup {
    /// The binary (and the directory, once empty) are gone.
    Removed,
    /// Windows: a running executable cannot delete itself, so deletion was
    /// handed to a detached `cmd` that runs after this process exits.
    Scheduled,
    /// The executable is not inside a `remotehub-helper-*` directory; nothing was touched.
    Refused,
}

/// Delete `exe`, an optional leftover `token_file`, and their helper directory.
pub fn cleanup(exe: &Path, token_file: Option<&Path>) -> io::Result<Cleanup> {
    let Some(dir) = helper_dir(exe) else { return Ok(Cleanup::Refused) };
    if let Some(token_file) = token_file.filter(|file| file.parent() == Some(dir.as_path())) {
        remove_if_present(token_file)?;
    }
    remove_self(exe, &dir)
}

/// Clean up the running executable.
pub fn cleanup_current(token_file: Option<&Path>) -> io::Result<Cleanup> {
    let exe = std::env::current_exe()?;
    cleanup(&exe, token_file)
}

fn helper_dir(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?;
    let name = dir.file_name()?.to_str()?;
    (name.starts_with(HELPER_DIR_PREFIX) && name.len() > HELPER_DIR_PREFIX.len()).then(|| dir.to_path_buf())
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(not(windows))]
fn remove_self(exe: &Path, dir: &Path) -> io::Result<Cleanup> {
    // Unix unlinks a running binary fine; the inode lives until the process exits.
    remove_if_present(exe)?;
    // remove_dir (not remove_dir_all): only an empty directory is removed, so
    // anything unexpected someone put there is left alone.
    match fs::remove_dir(dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(Cleanup::Removed),
    }
}

#[cfg(windows)]
fn remove_self(exe: &Path, dir: &Path) -> io::Result<Cleanup> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Wait ~2 s for this process to exit, then delete the binary and the directory.
    let script = format!(
        "ping -n 3 127.0.0.1 >NUL & del /F /Q \"{}\" & rmdir \"{}\"",
        exe.display(),
        dir.display()
    );
    // raw_arg: cmd.exe does not understand the \" escaping Rust applies to
    // ordinary arguments, so the quoted paths are passed through verbatim.
    Command::new("cmd")
        .raw_arg(format!("/C {script}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn()?;
    Ok(Cleanup::Scheduled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("rh-helper-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn token_is_read_once_and_the_file_is_deleted() {
        let dir = scratch("take");
        let path = dir.join("session-token");
        let token = "ab".repeat(32);
        fs::write(&path, format!("{token}\n")).unwrap();
        assert_eq!(take_token(&path).unwrap(), token);
        assert!(!path.exists(), "token file removed after reading");
        assert!(take_token(&path).is_err(), "a second read (reuse) fails");
        fs::write(&path, "short").unwrap();
        assert_eq!(take_token(&path).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert!(!path.exists(), "even a malformed token file is removed");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cleanup_removes_binary_token_and_directory_only_inside_a_helper_dir() {
        let base = scratch("cleanup");
        let dir = base.join(format!("{HELPER_DIR_PREFIX}0123abcd"));
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("remotehub-agent");
        let token = dir.join("session-token");
        fs::write(&exe, b"binary").unwrap();
        fs::write(&token, b"tok").unwrap();
        let outcome = cleanup(&exe, Some(&token)).unwrap();
        #[cfg(not(windows))]
        {
            assert_eq!(outcome, Cleanup::Removed);
            assert!(!dir.exists(), "helper directory is gone");
        }
        #[cfg(windows)]
        assert_eq!(outcome, Cleanup::Scheduled);
        assert!(!token.exists());

        // A binary outside a remotehub-helper-* directory is never touched.
        let install = base.join("bin");
        fs::create_dir_all(&install).unwrap();
        let real = install.join("remotehub-agent");
        fs::write(&real, b"installed").unwrap();
        assert_eq!(cleanup(&real, None).unwrap(), Cleanup::Refused);
        assert!(real.exists());
        // Nor is a bare prefix with no random part.
        let bare = base.join(HELPER_DIR_PREFIX);
        fs::create_dir_all(&bare).unwrap();
        fs::write(bare.join("remotehub-agent"), b"x").unwrap();
        assert_eq!(cleanup(&bare.join("remotehub-agent"), None).unwrap(), Cleanup::Refused);
        fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn cleanup_leaves_a_directory_with_unexpected_files() {
        let base = scratch("extra");
        let dir = base.join(format!("{HELPER_DIR_PREFIX}feedface"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("remotehub-agent"), b"x").unwrap();
        fs::write(dir.join("someone-elses-file"), b"keep").unwrap();
        assert!(cleanup(&dir.join("remotehub-agent"), None).is_err(), "non-empty dir is reported, not force-deleted");
        assert!(dir.join("someone-elses-file").exists());
        assert!(!dir.join("remotehub-agent").exists());
        fs::remove_dir_all(&base).unwrap();
    }
}
