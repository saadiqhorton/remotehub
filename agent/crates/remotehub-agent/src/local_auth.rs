//! Access control for the inbound loopback listener (SAA-298).
//!
//! Every time the persistent agent starts its TCP listener it:
//!
//! 1. refuses any bind address other than `127.0.0.1`,
//! 2. generates a fresh 32-byte token from the OS CSPRNG (`ring::rand`),
//! 3. writes it, hex-encoded, to a file only the current user can read
//!    (`0600` in a `0700` directory on Unix; an ACL granting only the current
//!    user on Windows), and
//! 4. requires every connection to present it in its first request,
//!    `{"op":"hello","params":{"token":"..."}}`, compared in constant time.
//!
//! RemoteHub reads the file over the user's own SSH session (SFTP), so only
//! someone who can already log in as that user can talk to the listener. The
//! token is never printed: logs name the file, not its contents.

use std::fs;
use std::io::{self, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use ring::rand::{SecureRandom, SystemRandom};

/// Raw token size before hex encoding.
pub const TOKEN_BYTES: usize = 32;

/// Default location, relative to the user's home directory.
pub const DEFAULT_TOKEN_RELATIVE: &str = ".remotehub/agent-local-token";

/// A fresh random token, hex-encoded (64 characters).
pub fn generate_token() -> io::Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| io::Error::other("the OS random number generator failed"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Constant-time equality: the running time depends only on the lengths, never
/// on where the first differing byte is.
pub fn tokens_match(expected: &str, presented: &str) -> bool {
    let (a, b) = (expected.as_bytes(), presented.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// `~/.remotehub/agent-local-token`, from `HOME` (Unix) or `USERPROFILE` (Windows).
pub fn default_token_path() -> io::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "cannot find the home directory (HOME/USERPROFILE)"))?;
    Ok(PathBuf::from(home).join(DEFAULT_TOKEN_RELATIVE))
}

/// The listener only ever binds IPv4 loopback.
pub fn require_loopback(listen: &str) -> io::Result<SocketAddr> {
    let address: SocketAddr = listen
        .parse()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("--listen must be 127.0.0.1:<port>, got \"{listen}\"")))?;
    if address.ip() != std::net::IpAddr::V4(Ipv4Addr::LOCALHOST) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("--listen must bind 127.0.0.1 only, got {}", address.ip())));
    }
    Ok(address)
}

/// Write `token` to `path`, readable and writable only by the current user.
/// Any previous file is replaced (never reused with its old permissions).
pub fn write_token_file(path: &Path, token: &str) -> io::Result<()> {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        create_private_dir(parent)?;
    }
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut file = create_private_file(path)?;
    restrict_to_current_user(path)?;
    file.write_all(token.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    if !dir.exists() {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    // Tighten an existing directory too; the token is the only thing in it we own.
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)
}

#[cfg(unix)]
fn create_private_file(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    // create_new + 0600: the file never exists with wider permissions, and a
    // symlink planted at the path is not followed.
    fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
}

#[cfg(not(unix))]
fn create_private_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(unix)]
fn restrict_to_current_user(_path: &Path) -> io::Result<()> {
    Ok(()) // Already 0600 from creation.
}

/// Windows: drop inherited ACEs and grant full control to the current user only,
/// before any token bytes are written. Fails closed: the agent will not start
/// if the ACL cannot be set.
#[cfg(windows)]
fn restrict_to_current_user(path: &Path) -> io::Result<()> {
    let user = windows_current_user()?;
    let status = std::process::Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("{user}:F"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::new(io::ErrorKind::PermissionDenied, "could not restrict the token file ACL to the current user"))
    }
}

#[cfg(windows)]
fn windows_current_user() -> io::Result<String> {
    let name = std::env::var("USERNAME").map_err(|_| io::Error::new(io::ErrorKind::NotFound, "USERNAME is not set"))?;
    Ok(match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() => format!("{domain}\\{name}"),
        _ => name,
    })
}

#[cfg(all(not(unix), not(windows)))]
fn restrict_to_current_user(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "no way to restrict the token file on this platform"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("remotehub-local-auth-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn tokens_are_fresh_long_and_hex() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_eq!(a.len(), TOKEN_BYTES * 2);
        assert!(a.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(a, b, "every start gets a new token");
    }

    #[test]
    fn comparison_rejects_missing_wrong_and_prefix_tokens() {
        let token = generate_token().unwrap();
        assert!(tokens_match(&token, &token));
        assert!(!tokens_match(&token, ""));
        assert!(!tokens_match(&token, &token[..63]));
        let mut wrong = token.clone().into_bytes();
        wrong[63] = if wrong[63] == b'0' { b'1' } else { b'0' };
        assert!(!tokens_match(&token, std::str::from_utf8(&wrong).unwrap()));
    }

    #[test]
    fn only_ipv4_loopback_is_accepted_as_a_bind_address() {
        assert!(require_loopback("127.0.0.1:8377").is_ok());
        for bad in ["0.0.0.0:8377", "192.168.1.5:8377", "[::1]:8377", "[::]:8377", "localhost:8377", "8377"] {
            assert!(require_loopback(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn token_file_is_private_to_the_current_user_and_replaced_on_restart() {
        let dir = scratch("perm");
        let path = dir.join("nested").join("agent-local-token");
        write_token_file(&path, "first").unwrap();
        write_token_file(&path, "second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        #[cfg(windows)]
        {
            // The ACL must name only the current user: no Everyone/Users/inherited entries.
            let output = std::process::Command::new("icacls").arg(&path).output().unwrap();
            let listing = String::from_utf8_lossy(&output.stdout).to_string();
            let user = std::env::var("USERNAME").unwrap();
            assert!(listing.contains(&user), "ACL lists the current user: {listing}");
            for other in ["Everyone", "BUILTIN\\Users", "Authenticated Users", "(I)"] {
                assert!(!listing.contains(other), "ACL must not contain {other}: {listing}");
            }
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_planted_at_the_token_path_is_not_followed() {
        let dir = scratch("link");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("victim");
        fs::write(&target, "keep").unwrap();
        let path = dir.join("agent-local-token");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        write_token_file(&path, "tok").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep", "the symlink target is untouched");
        assert!(!fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        fs::remove_dir_all(&dir).unwrap();
    }
}
