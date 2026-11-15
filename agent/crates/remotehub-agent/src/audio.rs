//! System sound capture for the Desktop surface.
//!
//! Platform capture backends preserve the Desktop player's raw stereo s16le format.
//! Linux uses PipeWire/PulseAudio in the signed-in sound session; macOS uses
//! ScreenCaptureKit (permission required); Windows uses WASAPI render loopback.
//! Capture lifetime remains tied to the authenticated agent connection.
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{self, Read};
#[cfg(any(target_os = "linux", all(test, unix)))]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

pub const RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
pub const MIMETYPE: &str = "audio/L16;rate=48000,channels=2";
const BYTES_PER_FRAME: usize = 2 * CHANNELS as usize;
/// 20 ms of sound per event: small enough for low latency, few enough frames per second.
pub const CHUNK_BYTES: usize = (RATE as usize / 50) * BYTES_PER_FRAME;
/// At most 1 s of sound waits for the connection. When it is full the OLDEST chunk is
/// dropped, so what the listener hears stays live after a stall.
const QUEUE_CHUNKS: usize = 50;
const STDERR_TAIL: usize = 512;

/// What the capture thread hands to the connection loop.
#[derive(Debug, PartialEq, Eq)]
pub enum Chunk {
    Data(Vec<u8>),
    /// The recorder stopped; the reason is safe to show (no secrets are involved).
    End(String),
}

/// One recorder command: program and arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recorder {
    pub program: String,
    pub args: Vec<String>,
}

impl Recorder {
    pub fn new(program: &str, args: &[&str]) -> Recorder {
        Recorder {
            program: program.to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
        }
    }
}

/// Recorders to try, best first, for a sound session in `runtime_dir`. PipeWire's own
/// recorder is preferred where PipeWire runs; `parec` covers PulseAudio and PipeWire's
/// PulseAudio layer. `available` reports whether a program is on PATH.
#[cfg(target_os = "linux")]
pub fn recorders(runtime_dir: &Path, available: impl Fn(&str) -> bool) -> Vec<Recorder> {
    let rate = RATE.to_string();
    let channels = CHANNELS.to_string();
    let pw_record = Recorder::new(
        "pw-record",
        &[
            "-P",
            "{ stream.capture.sink=true }",
            "--rate",
            &rate,
            "--channels",
            &channels,
            "--format",
            "s16",
            "--latency",
            "20ms",
            "-",
        ],
    );
    let parec = Recorder::new(
        "parec",
        &[
            "--device=@DEFAULT_MONITOR@",
            "--raw",
            "--format=s16le",
            &format!("--rate={rate}"),
            &format!("--channels={channels}"),
            "--latency-msec=20",
        ],
    );
    let mut out = Vec::new();
    if runtime_dir.join("pipewire-0").exists() && available("pw-record") {
        out.push(pw_record);
    }
    if runtime_dir.join("pulse").join("native").exists() && available("parec") {
        out.push(parec);
    }
    out
}

/// The current user's sound session directory: `XDG_RUNTIME_DIR`, else `/run/user/<uid>`.
#[cfg(target_os = "linux")]
pub fn runtime_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    current_uid().map(|uid| PathBuf::from(format!("/run/user/{uid}")))
}

#[cfg(target_os = "linux")]
fn current_uid() -> Option<u32> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|uid| uid.parse().ok())
}

#[cfg(target_os = "linux")]
fn on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
        .unwrap_or(false)
}

/// Whether this build has a native system-output capture backend.
pub const SUPPORTED: bool = cfg!(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows"
));

#[cfg(target_os = "macos")]
#[path = "audio_macos.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "audio_windows.rs"]
mod platform;

#[cfg(target_os = "macos")]
type PlatformBackend = platform::Backend;
#[cfg(target_os = "windows")]
type PlatformBackend = platform::Backend;

/// Sound waiting for the connection, shared by the reader thread and the connection loop.
/// Pushing never blocks: a full queue drops its oldest chunk instead.
#[derive(Default)]
struct SoundQueue {
    state: Mutex<QueueState>,
}

#[derive(Default)]
struct QueueState {
    chunks: VecDeque<Vec<u8>>,
    end: Option<String>,
    end_delivered: bool,
    dropped: u64,
}

impl SoundQueue {
    fn lock(&self) -> std::sync::MutexGuard<'_, QueueState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn push(&self, chunk: Vec<u8>) {
        let mut state = self.lock();
        if state.end.is_some() || state.end_delivered {
            return;
        }
        if state.chunks.len() >= QUEUE_CHUNKS {
            state.chunks.pop_front();
            state.dropped += 1;
        }
        state.chunks.push_back(chunk);
    }

    /// Record why capture stopped. The first reason wins, and nothing is added once
    /// the end has been handed out.
    fn finish(&self, reason: String) {
        let mut state = self.lock();
        if !state.end_delivered {
            state.end.get_or_insert(reason);
        }
    }

    /// Queued sound first, then the end (once).
    fn pop(&self) -> Option<Chunk> {
        let mut state = self.lock();
        if let Some(chunk) = state.chunks.pop_front() {
            return Some(Chunk::Data(chunk));
        }
        let end = state.end.take()?;
        state.end_delivered = true;
        Some(Chunk::End(end))
    }

    /// The next chunk for the connection loop. `reader_gone` covers a reader that died
    /// without reporting an end: never discard what it did queue, and keep its own reason.
    fn next(&self, reader_gone: bool) -> Option<Chunk> {
        if let Some(chunk) = self.pop() {
            return Some(chunk);
        }
        if reader_gone {
            self.finish("sound capture stopped".to_string()); // no-op if the reader gave a reason
            return self.pop();
        }
        None
    }
}

/// A running recorder. Dropping it stops the recorder and its reader thread.
pub struct Capture {
    child: Option<Child>,
    queue: Arc<SoundQueue>,
    reader: Option<JoinHandle<()>>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    platform: Option<PlatformBackend>,
}

impl Capture {
    /// Start recording the computer's sound output with the first recorder that runs.
    pub fn start() -> io::Result<Capture> {
        #[cfg(target_os = "macos")]
        {
            let queue = Arc::new(SoundQueue::default());
            let platform = platform::start(Arc::clone(&queue))?;
            return Ok(Capture {
                child: None,
                queue,
                reader: None,
                platform: Some(platform),
            });
        }
        #[cfg(target_os = "windows")]
        {
            let queue = Arc::new(SoundQueue::default());
            let platform = platform::start(Arc::clone(&queue))?;
            return Ok(Capture {
                child: None,
                queue,
                reader: None,
                platform: Some(platform),
            });
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "sound capture is not available on this platform",
        ));
        #[cfg(target_os = "linux")]
        let runtime = runtime_dir().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "no sound session for this user")
        })?;
        #[cfg(target_os = "linux")]
        let candidates = recorders(&runtime, on_path);
        #[cfg(target_os = "linux")]
        if candidates.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "no PipeWire or PulseAudio sound session is running for this user",
            ));
        }
        #[cfg(target_os = "linux")]
        {
            let mut last = None;
            for recorder in &candidates {
                match Capture::spawn(
                    recorder,
                    &[(
                        OsString::from("XDG_RUNTIME_DIR"),
                        runtime.clone().into_os_string(),
                    )],
                ) {
                    Ok(capture) => return Ok(capture),
                    Err(error) => last = Some(error),
                }
            }
            Err(last.unwrap_or_else(|| io::Error::other("no recorder started")))
        }
    }

    /// Run `recorder` and stream its stdout in [`CHUNK_BYTES`] pieces.
    pub fn spawn(recorder: &Recorder, env: &[(OsString, OsString)]) -> io::Result<Capture> {
        let mut command = Command::new(&recorder.program);
        command
            .args(&recorder.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("recorder has no stdout"))?;
        let stderr = child.stderr.take();
        let queue = Arc::new(SoundQueue::default());
        let program = recorder.program.clone();
        let reader_queue = Arc::clone(&queue);
        let reader = thread::spawn(move || pump(stdout, stderr, &reader_queue, &program));
        Ok(Capture {
            child: Some(child),
            queue,
            reader: Some(reader),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            platform: None,
        })
    }

    /// The next waiting chunk, without blocking.
    pub fn try_next(&self) -> Option<Chunk> {
        let reader_gone = self.reader.as_ref().map_or(true, JoinHandle::is_finished);
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let reader_gone = reader_gone && self.platform.is_none();
        self.queue.next(reader_gone)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        // Nothing ever blocks on the queue, so stopping the recorder ends the reader.
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        drop(self.platform.take());
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn pump(
    mut stdout: impl Read,
    stderr: Option<impl Read + Send + 'static>,
    queue: &SoundQueue,
    program: &str,
) {
    let stderr_reader = stderr.map(|mut stderr| {
        thread::spawn(move || {
            let mut text = Vec::new();
            let _ = stderr.read_to_end(&mut text);
            let text = String::from_utf8_lossy(&text).trim().to_string();
            let start = text.len().saturating_sub(STDERR_TAIL);
            text.get(start..).unwrap_or("").to_string()
        })
    });
    let mut pending = Vec::with_capacity(CHUNK_BYTES * 2);
    let mut buffer = [0u8; 8192];
    loop {
        match stdout.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                pending.extend_from_slice(&buffer[..read]);
                while pending.len() >= CHUNK_BYTES {
                    queue.push(pending.drain(..CHUNK_BYTES).collect());
                }
            }
        }
    }
    let usable = pending.len() - pending.len() % BYTES_PER_FRAME;
    if usable > 0 {
        queue.push(pending[..usable].to_vec());
    }
    let detail = stderr_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let reason = if detail.is_empty() {
        format!("{program} stopped")
    } else {
        format!("{program} stopped: {detail}")
    };
    queue.finish(reason);
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding, for sound bytes in a JSON event.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let b = [
            group[0],
            *group.get(1).unwrap_or(&0),
            *group.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(BASE64[(n >> 18) as usize & 63] as char);
        out.push(BASE64[(n >> 12) as usize & 63] as char);
        out.push(if group.len() > 1 {
            BASE64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if group.len() > 2 {
            BASE64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0xff, 0xfe, 0x00, 0x01]), "//4AAQ==");
    }

    #[test]
    fn chunks_are_twenty_milliseconds_of_stereo_s16() {
        assert_eq!(CHUNK_BYTES, 3840);
        assert_eq!(CHUNK_BYTES % BYTES_PER_FRAME, 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recorders_follow_the_running_sound_server() {
        let dir = std::env::temp_dir().join(format!("rh-audio-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("pulse")).unwrap();
        let everything = |_: &str| true;
        assert!(
            recorders(&dir, everything).is_empty(),
            "no sound server socket, nothing to try"
        );
        std::fs::write(dir.join("pulse").join("native"), b"").unwrap();
        assert_eq!(
            recorders(&dir, everything)
                .iter()
                .map(|r| r.program.as_str())
                .collect::<Vec<_>>(),
            ["parec"]
        );
        std::fs::write(dir.join("pipewire-0"), b"").unwrap();
        assert_eq!(
            recorders(&dir, everything)
                .iter()
                .map(|r| r.program.as_str())
                .collect::<Vec<_>>(),
            ["pw-record", "parec"]
        );
        let no_pw = |program: &str| program != "pw-record";
        assert_eq!(
            recorders(&dir, no_pw)
                .iter()
                .map(|r| r.program.as_str())
                .collect::<Vec<_>>(),
            ["parec"],
            "a missing tool is skipped"
        );
        let parec = &recorders(&dir, everything)[1];
        assert!(parec
            .args
            .contains(&"--device=@DEFAULT_MONITOR@".to_string()));
        assert!(parec.args.contains(&"--raw".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    fn collect(capture: &Capture, until_end: bool) -> (Vec<Vec<u8>>, Option<String>) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let (mut data, mut end) = (Vec::new(), None);
        while Instant::now() < deadline {
            match capture.try_next() {
                Some(Chunk::Data(bytes)) => data.push(bytes),
                Some(Chunk::End(reason)) => {
                    end = Some(reason);
                    break;
                }
                None if !until_end && !data.is_empty() => break,
                None => thread::sleep(Duration::from_millis(5)),
            }
        }
        (data, end)
    }

    #[cfg(unix)]
    #[test]
    fn a_recorder_streams_whole_frames_then_reports_why_it_stopped() {
        // 10000 bytes: two full chunks, then 2320 bytes (580 whole frames).
        let recorder = Recorder::new(
            "sh",
            &["-c", "head -c 10000 /dev/zero; echo 'no default sink' >&2"],
        );
        let capture = Capture::spawn(&recorder, &[]).unwrap();
        let (data, end) = collect(&capture, true);
        assert_eq!(
            data.iter().map(Vec::len).collect::<Vec<_>>(),
            [3840, 3840, 2320]
        );
        assert_eq!(end.as_deref(), Some("sh stopped: no default sink"));
    }

    #[cfg(unix)]
    #[test]
    fn dropping_a_capture_stops_the_recorder() {
        let recorder = Recorder::new("sh", &["-c", "exec cat /dev/zero"]);
        let capture = Capture::spawn(&recorder, &[]).unwrap();
        let (data, _) = collect(&capture, false);
        assert!(!data.is_empty(), "sound flows while capturing");
        let pid = capture.child.as_ref().unwrap().id();
        drop(capture);
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists()
                || std::fs::read_to_string(format!("/proc/{pid}/status"))
                    .map(|s| s.contains("State:\tZ"))
                    .unwrap_or(true),
            "recorder process is gone"
        );
    }

    // Real capture from the user's running sound server. Opt-in: set REMOTEHUB_REAL_AUDIO=1
    // and play something (the check wants non-silent sound within 3 s).
    #[test]
    fn real_sound_server_capture_when_enabled() {
        if std::env::var_os("REMOTEHUB_REAL_AUDIO").is_none() || !SUPPORTED {
            return;
        }
        let capture = Capture::start().expect("a recorder starts in the running sound session");
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut peak = 0i32;
        while Instant::now() < deadline && peak < 1000 {
            match capture.try_next() {
                Some(Chunk::Data(bytes)) => {
                    for sample in bytes.chunks_exact(2) {
                        peak =
                            peak.max(i32::from(i16::from_le_bytes([sample[0], sample[1]])).abs());
                    }
                }
                Some(Chunk::End(reason)) => panic!("capture ended: {reason}"),
                None => thread::sleep(Duration::from_millis(5)),
            }
        }
        eprintln!("real capture peak: {peak}");
        assert!(
            peak >= 1000,
            "heard what the computer is playing (peak {peak})"
        );
    }

    #[test]
    fn a_full_queue_drops_the_oldest_sound_so_playback_stays_live() {
        let queue = SoundQueue::default();
        for marker in 0..(QUEUE_CHUNKS as u8 + 10) {
            queue.push(vec![marker; 4]);
        }
        queue.finish("parec stopped".to_string());
        let mut kept = Vec::new();
        while let Some(chunk) = queue.pop() {
            kept.push(chunk);
        }
        assert_eq!(
            kept.len(),
            QUEUE_CHUNKS + 1,
            "one second of sound, then the end"
        );
        assert_eq!(
            kept[0],
            Chunk::Data(vec![10; 4]),
            "the ten oldest chunks were dropped"
        );
        assert_eq!(
            kept[QUEUE_CHUNKS - 1],
            Chunk::Data(vec![QUEUE_CHUNKS as u8 + 9; 4]),
            "the newest is kept"
        );
        assert_eq!(kept[QUEUE_CHUNKS], Chunk::End("parec stopped".to_string()));
        assert_eq!(queue.lock().dropped, 10);
        assert_eq!(queue.pop(), None, "the end is reported once");
        queue.push(vec![99; 4]);
        assert_eq!(queue.pop(), None, "no sound arrives after the terminal end");
    }

    #[test]
    fn a_finished_reader_loses_neither_its_last_sound_nor_its_reason() {
        // The reader queued its last chunk and its real reason, then finished, between the
        // loop's checks: both must still come out, in order, and the end only once.
        let queue = SoundQueue::default();
        queue.push(vec![7; 4]);
        queue.finish("pw-record stopped: no default sink".to_string());
        assert_eq!(
            queue.next(true),
            Some(Chunk::Data(vec![7; 4])),
            "the last sound is not discarded"
        );
        assert_eq!(
            queue.next(true),
            Some(Chunk::End("pw-record stopped: no default sink".to_string())),
            "the reader's own reason"
        );
        assert_eq!(queue.next(true), None, "no second, generic end");
        // A reader that died without a reason still yields one end.
        let silent = SoundQueue::default();
        assert_eq!(
            silent.next(false),
            None,
            "a live reader with nothing queued: nothing yet"
        );
        assert_eq!(
            silent.next(true),
            Some(Chunk::End("sound capture stopped".to_string()))
        );
        assert_eq!(silent.next(true), None);
    }

    #[cfg(unix)]
    #[test]
    fn dropping_a_capture_with_a_full_queue_does_not_hang() {
        // More than a full queue (50 chunks) of sound, never drained, then the recorder exits:
        // the reader thread is left wanting to report the end into a full queue.
        let recorder = Recorder::new("sh", &["-c", "head -c 400000 /dev/zero"]);
        let capture = Capture::spawn(&recorder, &[]).unwrap();
        thread::sleep(Duration::from_millis(300));
        let (done, finished) = mpsc::channel();
        thread::spawn(move || {
            drop(capture);
            let _ = done.send(());
        });
        assert!(
            finished.recv_timeout(Duration::from_secs(3)).is_ok(),
            "drop finished instead of waiting on a full queue forever"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_recorder_fails_to_start() {
        assert!(Capture::spawn(&Recorder::new("remotehub-no-such-recorder", &[]), &[]).is_err());
    }
}
