//! SAA-299: the real binary run the way RemoteHub deploys it as a temporary
//! helper — copied into a fresh `remotehub-helper-*` directory with a
//! single-use token file next to it — over stdin/stdout.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

const TOKEN: &str = "5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed";

struct Deployed {
    dir: PathBuf,
    exe: PathBuf,
    token_file: PathBuf,
}

// Tests write only under the OS temp dir and remove what they made, even on failure.
impl Drop for Deployed {
    fn drop(&mut self) {
        if let Some(base) = self.dir.parent() {
            let _ = fs::remove_dir_all(base);
        }
    }
}

fn deploy(name: &str) -> Deployed {
    let base = std::env::temp_dir().join(format!("rh-helper-proc-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let dir = base.join(format!("remotehub-helper-{name}"));
    fs::create_dir_all(&dir).unwrap();
    let exe = dir.join(if cfg!(windows) { "remotehub-agent.exe" } else { "remotehub-agent" });
    fs::copy(env!("CARGO_BIN_EXE_remotehub-agent"), &exe).unwrap();
    let token_file = dir.join("session-token");
    fs::write(&token_file, format!("{TOKEN}\n")).unwrap();
    Deployed { dir, exe, token_file }
}

fn start(deployed: &Deployed, ttl: u64) -> (Child, ChildStdin, BufReader<ChildStdout>) {
    // Linux: a test thread forking while another copies a binary can briefly hold
    // the copy's write handle open, so exec fails with ETXTBSY. Retry briefly.
    let mut attempts = 0;
    let mut child = loop {
        match spawn_helper(deployed, ttl) {
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy && attempts < 50 => {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            other => break other.unwrap(),
        }
    };
    let stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());
    (child, stdin, stdout)
}

fn spawn_helper(deployed: &Deployed, ttl: u64) -> std::io::Result<Child> {
    Command::new(&deployed.exe)
        .args(["--mode", "temporary", "--root"])
        .arg(std::env::temp_dir())
        .arg("--helper-token-file")
        .arg(&deployed.token_file)
        .arg("--helper-cleanup")
        .args(["--helper-ttl", &ttl.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

fn read_line(reader: &mut BufReader<ChildStdout>) -> String {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    line
}

fn wait(child: &mut Child) -> (i32, String) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            let mut stderr = String::new();
            std::io::Read::read_to_string(child.stderr.as_mut().unwrap(), &mut stderr).unwrap();
            return (status.code().unwrap_or(-1), stderr);
        }
        assert!(Instant::now() < deadline, "helper did not exit");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Windows deletes the running binary from a detached cmd after exit.
fn assert_gone(dir: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while dir.exists() {
        assert!(Instant::now() < deadline, "helper directory {} still exists", dir.display());
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn right_token_serves_the_session_then_the_helper_removes_itself() {
    let deployed = deploy("ok");
    let (mut child, mut stdin, mut stdout) = start(&deployed, 30);
    let hello = read_line(&mut stdout);
    assert!(hello.contains("\"event\":\"hello\"") && hello.contains("\"mode\":\"temporary\""), "{hello}");
    assert!(!deployed.token_file.exists(), "token file deleted as soon as it was read");
    writeln!(stdin, "{{\"id\":1,\"op\":\"hello\",\"params\":{{\"protocol\":1,\"token\":\"{TOKEN}\"}}}}").unwrap();
    let auth = read_line(&mut stdout);
    assert!(auth.contains("\"ok\":true") && auth.contains("authenticated"), "{auth}");
    writeln!(stdin, "{{\"id\":2,\"op\":\"ping\"}}").unwrap();
    assert!(read_line(&mut stdout).contains("\"pong\":true"));
    drop(stdin); // session ends: RemoteHub closes the channel
    let (code, stderr) = wait(&mut child);
    assert_eq!(code, 0, "{stderr}");
    assert!(!stderr.contains(TOKEN), "token never logged");
    assert_gone(&deployed.dir);
}

#[test]
fn wrong_or_missing_token_is_refused_and_the_helper_still_cleans_up() {
    for (name, request) in [
        ("wrong", format!("{{\"id\":1,\"op\":\"hello\",\"params\":{{\"protocol\":1,\"token\":\"{}\"}}}}", "0".repeat(64))),
        ("missing", "{\"id\":1,\"op\":\"hello\",\"params\":{\"protocol\":1}}".to_string()),
        ("skipped", "{\"id\":1,\"op\":\"ping\"}".to_string()),
    ] {
        let deployed = deploy(name);
        let (mut child, mut stdin, mut stdout) = start(&deployed, 30);
        read_line(&mut stdout);
        writeln!(stdin, "{request}").unwrap();
        let reply = read_line(&mut stdout);
        assert!(reply.contains("\"unauthorized\""), "{name}: {reply}");
        let (code, stderr) = wait(&mut child);
        assert_eq!(code, 3, "{name}: {stderr}");
        assert!(!stderr.contains(TOKEN));
        assert_gone(&deployed.dir);
    }
}

#[test]
fn unused_token_expires_and_the_helper_exits_and_cleans_up() {
    let deployed = deploy("ttl");
    let started = Instant::now();
    let (mut child, stdin, mut stdout) = start(&deployed, 1);
    read_line(&mut stdout);
    let (code, stderr) = wait(&mut child);
    drop(stdin);
    assert_eq!(code, 3, "{stderr}");
    assert!(started.elapsed() >= Duration::from_millis(900));
    assert!(stderr.contains("expired"), "{stderr}");
    assert_gone(&deployed.dir);
}

#[test]
fn a_used_token_cannot_start_a_second_helper() {
    // The token file is consumed by the first start; a second start with the
    // same file path finds nothing and exits without serving.
    let deployed = deploy("reuse");
    let token_copy = deployed.dir.with_extension("token-copy");
    fs::copy(&deployed.token_file, &token_copy).unwrap();
    let (mut child, stdin, mut stdout) = start(&deployed, 30);
    read_line(&mut stdout);
    drop(stdin);
    wait(&mut child);
    assert_gone(&deployed.dir);

    // Re-deploy the binary but not the token: the helper refuses to run.
    fs::create_dir_all(&deployed.dir).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_remotehub-agent"), &deployed.exe).unwrap();
    let (mut child, _stdin, _stdout) = start(&deployed, 30);
    let (code, stderr) = wait(&mut child);
    assert_eq!(code, 3, "{stderr}");
    assert!(stderr.contains("helper token unavailable"), "{stderr}");
    assert_gone(&deployed.dir);
    let _ = fs::remove_file(token_copy);
}
