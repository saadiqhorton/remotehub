//! Windows system-output capture using WASAPI shared-mode loopback.
//!
//! This module uses `wasapi` 0.16, whose declared MSRV is Rust 1.74. It captures the
//! default render endpoint and asks the shared audio engine to convert to stereo s16/48 kHz.

use super::SoundQueue;
use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use wasapi::{
    deinitialize, get_default_device, initialize_mta, Direction, SampleType, ShareMode,
    WasapiError, WaveFormat,
};

const RATE: usize = 48_000;
const CHANNELS: usize = 2;
const BYTES_PER_SAMPLE: usize = 2;
const BYTES_PER_FRAME: usize = CHANNELS * BYTES_PER_SAMPLE;
const CHUNK_BYTES: usize = (RATE / 50) * BYTES_PER_FRAME;

/// A running WASAPI loopback reader. Dropping it signals and joins its capture thread.
pub(super) struct Backend {
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

pub(super) fn start(queue: Arc<SoundQueue>) -> io::Result<Backend> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let worker_stop = Arc::clone(&stop);
    let reader = thread::Builder::new()
        .name("remotehub-wasapi-loopback".to_string())
        .spawn(move || capture_thread(queue, worker_stop, ready_tx))?;

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(Backend {
            stop,
            reader: Some(reader),
        }),
        Ok(Err(reason)) => {
            let _ = reader.join();
            Err(io::Error::new(io::ErrorKind::Other, reason))
        }
        Err(error) => {
            let _ = reader.join();
            Err(io::Error::new(
                io::ErrorKind::Other,
                format!("WASAPI capture thread stopped during startup: {error}"),
            ))
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn capture_thread(
    queue: Arc<SoundQueue>,
    stop: Arc<AtomicBool>,
    ready: mpsc::SyncSender<Result<(), String>>,
) {
    if let Err(error) = initialize_mta().ok() {
        let _ = ready.send(Err(format!("initialize WASAPI COM apartment: {error}")));
        return;
    }
    let result = run_capture(&queue, &stop, ready.clone());
    deinitialize();
    if let Err(reason) = result {
        let _ = ready.send(Err(reason.clone()));
        queue.finish(reason);
    }
}

fn run_capture(
    queue: &SoundQueue,
    stop: &AtomicBool,
    ready: mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let device = get_default_device(&Direction::Render)
        .map_err(|error| format!("get default render device: {error}"))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|error| format!("open default render device: {error}"))?;
    let format = WaveFormat::new(16, 16, &SampleType::Int, RATE, CHANNELS, None);
    let (_default_period, min_period) = audio_client
        .get_periods()
        .map_err(|error| format!("get render period: {error}"))?;
    // Per WASAPI loopback setup, use the render endpoint with capture direction.
    audio_client
        .initialize_client(
            &format,
            min_period,
            &Direction::Capture,
            &ShareMode::Shared,
            true,
        )
        .map_err(|error| format!("initialize render loopback: {error}"))?;
    let event = audio_client
        .set_get_eventhandle()
        .map_err(|error| format!("create loopback event: {error}"))?;
    let frames = audio_client
        .get_bufferframecount()
        .map_err(|error| format!("get loopback buffer size: {error}"))? as usize;
    let capture = audio_client
        .get_audiocaptureclient()
        .map_err(|error| format!("get loopback capture client: {error}"))?;
    audio_client
        .start_stream()
        .map_err(|error| format!("start render loopback: {error}"))?;
    if ready.send(Ok(())).is_err() {
        let _ = audio_client.stop_stream();
        return Ok(());
    }

    let mut pending = VecDeque::with_capacity(frames.saturating_mul(BYTES_PER_FRAME));
    let mut buffer = vec![0u8; frames.saturating_mul(BYTES_PER_FRAME)];
    while !stop.load(Ordering::Acquire) {
        // On older Windows versions loopback event notifications may not fire; keep
        // checking for queued packets on timeout rather than waiting forever for an event.
        match event.wait_for_event(100) {
            Ok(()) => {}
            Err(WasapiError::EventTimeout) => {}
            Err(_error) if stop.load(Ordering::Acquire) => break,
            Err(error) => return Err(format!("wait for render loopback event: {error}")),
        }
        if stop.load(Ordering::Acquire) {
            break;
        }
        loop {
            let Some(available_frames) = capture
                .get_next_nbr_frames()
                .map_err(|error| format!("query render loopback packet: {error}"))?
            else {
                return Err("WASAPI shared loopback did not report packet availability".into());
            };
            if available_frames == 0 {
                break;
            }
            let needed = (available_frames as usize).saturating_mul(BYTES_PER_FRAME);
            if needed > buffer.len() {
                buffer.resize(needed, 0);
            }
            let (read_frames, flags) = capture
                .read_from_device(&mut buffer)
                .map_err(|error| format!("read render loopback: {error}"))?;
            if read_frames == 0 {
                break;
            }
            let read_bytes = (read_frames as usize).saturating_mul(BYTES_PER_FRAME);
            if flags.silent {
                pending.extend(std::iter::repeat(0).take(read_bytes));
            } else {
                pending.extend(buffer[..read_bytes].iter().copied());
            }
            while pending.len() >= CHUNK_BYTES {
                queue.push(pending.drain(..CHUNK_BYTES).collect());
            }
        }
    }
    let usable = pending.len() - pending.len() % BYTES_PER_FRAME;
    if usable > 0 {
        queue.push(pending.drain(..usable).collect());
    }
    audio_client
        .stop_stream()
        .map_err(|error| format!("stop render loopback: {error}"))?;
    Ok(())
}
