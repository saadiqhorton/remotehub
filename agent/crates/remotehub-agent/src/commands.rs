//! Bounded Windows Job Object command execution for the explicitly authorized exec surface.
//! Other platforms fail closed because detached descendants can keep inherited pipes open.
//! The agent's configured filesystem root is only the working directory; it is not a sandbox.

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);

impl Cancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[cfg(windows)]
mod supported {
    use super::Cancellation;
    use command_group::CommandGroup;
    use std::io::{self, Read, Write};
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    const MAX_CAPTURE_BYTES_PER_STREAM: usize = 32 * 1024;
    const MAX_TEXT_BYTES_PER_STREAM: usize = 12 * 1024;

    fn drain<R: Read>(mut reader: R) -> io::Result<(Vec<u8>, bool)> {
        let mut captured = Vec::with_capacity(MAX_CAPTURE_BYTES_PER_STREAM);
        let mut truncated = false;
        let mut buffer = [0u8; 8192];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 { break; }
            let remaining = MAX_CAPTURE_BYTES_PER_STREAM.saturating_sub(captured.len());
            let keep = remaining.min(read);
            captured.extend_from_slice(&buffer[..keep]);
            truncated |= keep < read;
        }
        Ok((captured, truncated))
    }

    fn text_output(bytes: &[u8]) -> (String, bool) {
        let decoded = String::from_utf8_lossy(bytes);
        let mut output = decoded.chars().map(|ch| {
            if ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t' { '�' } else { ch }
        }).collect::<String>();
        let mut truncated = false;
        if output.len() > MAX_TEXT_BYTES_PER_STREAM {
            let mut end = MAX_TEXT_BYTES_PER_STREAM;
            while !output.is_char_boundary(end) { end -= 1; }
            output.truncate(end);
            truncated = true;
        }
        (output, truncated)
    }

    fn join_reader(handle: thread::JoinHandle<io::Result<(Vec<u8>, bool)>>) -> io::Result<(Vec<u8>, bool)> {
        handle.join().map_err(|_| io::Error::new(io::ErrorKind::Other, "command output reader failed"))?
    }

    fn kill_group(child: &mut command_group::GroupChild) -> io::Result<()> {
        match child.kill() {
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => Ok(()),
            result => result,
        }
    }

    pub fn run(root: &Path, executable: &str, args: &[String], input: Option<&str>, timeout: Duration, cancellation: &Cancellation) -> io::Result<crate::json::Value> {
        let mut command = Command::new(executable);
        command.args(args).current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let started = Instant::now();
        let mut child = command.group_spawn()?;
        let (stdin, stdout, stderr) = {
            let process = child.inner();
            (process.stdin.take(), process.stdout.take(), process.stderr.take())
        };
        let stdout = stdout.ok_or_else(|| io::Error::new(io::ErrorKind::Other, "command stdout pipe was unavailable"))?;
        let stderr = stderr.ok_or_else(|| io::Error::new(io::ErrorKind::Other, "command stderr pipe was unavailable"))?;
        let out_reader = thread::spawn(move || drain(stdout));
        let err_reader = thread::spawn(move || drain(stderr));
        let input_bytes = input.unwrap_or("").as_bytes().to_vec();
        let input_writer = thread::spawn(move || -> io::Result<()> {
            if let Some(mut stdin) = stdin {
                stdin.write_all(&input_bytes)?;
            }
            Ok(())
        });

        let mut timed_out = false;
        let mut cancelled = false;
        loop {
            if child.try_wait()?.is_some() { break; }
            if cancellation.is_cancelled() {
                cancelled = true;
                break;
            }
            if started.elapsed() >= timeout {
                timed_out = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        // Windows Job Objects retain child processes unless breakaway is enabled,
        // which this runner does not enable. Terminate the job, then wait for every
        // job process to exit before joining readers of inherited output pipes.
        kill_group(&mut child)?;
        let status = child.wait()?;

        let input_result = input_writer.join().map_err(|_| io::Error::new(io::ErrorKind::Other, "command stdin writer failed"))?;
        if let Err(error) = input_result {
            if error.kind() != io::ErrorKind::BrokenPipe { return Err(error); }
        }
        let (stdout_bytes, stdout_truncated) = join_reader(out_reader)?;
        let (stderr_bytes, stderr_truncated) = join_reader(err_reader)?;
        let (stdout_text, stdout_text_truncated) = text_output(&stdout_bytes);
        let (stderr_text, stderr_text_truncated) = text_output(&stderr_bytes);
        let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        Ok(crate::json::Value::object(vec![
            ("success", crate::json::Value::Bool(status.success())),
            ("exitCode", status.code().map_or(crate::json::Value::Null, |code| crate::json::Value::Number(code as f64))),
            ("timedOut", crate::json::Value::Bool(timed_out)),
            ("cancelled", crate::json::Value::Bool(cancelled)),
            ("elapsedMs", crate::json::Value::Number(elapsed_ms as f64)),
            ("stdout", crate::json::Value::string(stdout_text)),
            ("stderr", crate::json::Value::string(stderr_text)),
            ("stdoutTruncated", crate::json::Value::Bool(stdout_truncated || stdout_text_truncated)),
            ("stderrTruncated", crate::json::Value::Bool(stderr_truncated || stderr_text_truncated)),
        ]))
    }
}

#[cfg(windows)]
pub const SUPPORTED: bool = true;
#[cfg(not(windows))]
pub const SUPPORTED: bool = false;

#[cfg(windows)]
pub fn run(root: &Path, executable: &str, args: &[String], input: Option<&str>, timeout: Duration) -> io::Result<crate::json::Value> {
    run_cancellable(root, executable, args, input, timeout, &Cancellation::new())
}

#[cfg(not(windows))]
pub fn run(_root: &Path, _executable: &str, _args: &[String], _input: Option<&str>, _timeout: Duration) -> io::Result<crate::json::Value> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "process-group command execution is not supported on this platform"))
}

#[cfg(windows)]
pub fn run_cancellable(root: &Path, executable: &str, args: &[String], input: Option<&str>, timeout: Duration, cancellation: &Cancellation) -> io::Result<crate::json::Value> {
    supported::run(root, executable, args, input, timeout, cancellation)
}

#[cfg(not(windows))]
pub fn run_cancellable(_root: &Path, _executable: &str, _args: &[String], _input: Option<&str>, _timeout: Duration, _cancellation: &Cancellation) -> io::Result<crate::json::Value> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "process-group command execution is not supported on this platform"))
}

#[cfg(all(test, windows))]
mod cancellation_tests {
    use super::{run_cancellable, Cancellation};
    use std::path::Path;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn cancellation_terminates_the_command_group_and_joins_its_output_readers() {
        let cancellation = Cancellation::new();
        let worker_cancellation = cancellation.clone();
        let executable = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let args = vec![
            "/d".to_string(),
            "/c".to_string(),
            "start /b ping -n 30 127.0.0.1 & ping -n 30 127.0.0.1".to_string(),
        ];
        let started = Instant::now();
        let worker = thread::spawn(move || {
            run_cancellable(Path::new("."), &executable, &args, None, Duration::from_secs(60), &worker_cancellation)
        });

        thread::sleep(Duration::from_millis(250));
        cancellation.cancel();
        let result = worker.join().expect("command worker joined").expect("command cleanup succeeded");

        assert_eq!(result.get("cancelled").and_then(crate::json::Value::as_bool), Some(true));
        assert!(started.elapsed() < Duration::from_secs(5), "the process group and inherited output pipes were cleaned promptly");
    }
}
