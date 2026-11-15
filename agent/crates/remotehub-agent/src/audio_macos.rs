//! macOS system-audio capture using ScreenCaptureKit (macOS 13+).
//!
//! ScreenCaptureKit requires Screen Recording permission, even when only audio is captured.
//! Its audio configuration defaults to 48 kHz; we request stereo explicitly. The audio
//! sample buffers are treated as interleaved 32-bit float PCM and converted to signed
//! 16-bit little-endian PCM for the shared Desktop audio pipeline.

use core_foundation::base::TCFType;
use std::io;
use std::sync::{Arc, Mutex};

use screencapturekit::{
    shareable_content::SCShareableContent,
    stream::{
        configuration::SCStreamConfiguration, content_filter::SCContentFilter,
        output_trait::SCStreamOutputTrait, output_type::SCStreamOutputType, SCStream,
    },
};

use super::SoundQueue;

#[repr(C)]
struct AudioStreamBasicDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMAudioFormatDescriptionGetStreamBasicDescription(
        description: *const std::ffi::c_void,
    ) -> *const AudioStreamBasicDescription;
}

fn interleave_planar_stereo(left: &[u8], right: &[u8]) -> Option<Vec<u8>> {
    if left.len() % 4 != 0 || right.len() != left.len() {
        return None;
    }
    let mut pcm = Vec::with_capacity(left.len());
    for (left, right) in left.chunks_exact(4).zip(right.chunks_exact(4)) {
        pcm.extend_from_slice(&float_to_s16le(left));
        pcm.extend_from_slice(&float_to_s16le(right));
    }
    Some(pcm)
}

fn float_to_s16le(sample: &[u8]) -> [u8; 2] {
    let sample = f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]);
    let value = if sample.is_finite() {
        (sample.clamp(-1.0, 1.0)
            * if sample < 0.0 {
                i16::MIN.unsigned_abs() as f32
            } else {
                i16::MAX as f32
            })
        .round() as i16
    } else {
        0
    };
    value.to_le_bytes()
}

struct AudioOutput {
    queue: Arc<SoundQueue>,
    pending: Arc<Mutex<Vec<u8>>>,
}

impl SCStreamOutputTrait for AudioOutput {
    fn did_output_sample_buffer(
        &self,
        sample_buffer: core_media_rs::cm_sample_buffer::CMSampleBuffer,
        of_type: SCStreamOutputType,
    ) {
        if of_type != SCStreamOutputType::Audio {
            return;
        }

        let buffers = match sample_buffer.get_audio_buffer_list() {
            Ok(buffers) => buffers,
            Err(error) => {
                self.queue
                    .finish(format!("ScreenCaptureKit audio buffer failed: {error}"));
                return;
            }
        };
        let description = match sample_buffer.get_format_description() {
            Ok(description) => description,
            Err(error) => {
                self.queue
                    .finish(format!("ScreenCaptureKit audio format failed: {error}"));
                return;
            }
        };
        let format = unsafe {
            CMAudioFormatDescriptionGetStreamBasicDescription(
                description.as_concrete_TypeRef().cast(),
            )
        };
        if format.is_null() {
            self.queue
                .finish("ScreenCaptureKit returned no audio format description".into());
            return;
        }
        let format = unsafe { &*format };
        const LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");
        const FLOAT_FLAG: u32 = 1 << 0;
        const NON_INTERLEAVED_FLAG: u32 = 1 << 5;
        if format.sample_rate != super::RATE as f64
            || format.channels_per_frame != 2
            || format.format_id != LINEAR_PCM
            || format.bits_per_channel != 32
            || format.format_flags & FLOAT_FLAG == 0
        {
            self.queue
                .finish("ScreenCaptureKit returned an unsupported audio format".into());
            return;
        }

        let mut pcm = Vec::new();
        if format.format_flags & NON_INTERLEAVED_FLAG != 0 {
            if buffers.num_buffers() != 2 {
                self.queue
                    .finish("ScreenCaptureKit returned an unexpected planar stereo layout".into());
                return;
            }
            let (Some(left), Some(right)) = (buffers.get(0), buffers.get(1)) else {
                self.queue
                    .finish("ScreenCaptureKit returned an incomplete stereo audio buffer".into());
                return;
            };
            if left.number_channels != 1 || right.number_channels != 1 {
                self.queue
                    .finish("ScreenCaptureKit returned invalid planar audio channels".into());
                return;
            }
            let Some(interleaved) = interleave_planar_stereo(left.data(), right.data()) else {
                self.queue
                    .finish("ScreenCaptureKit returned mismatched planar stereo audio".into());
                return;
            };
            pcm = interleaved;
        } else {
            if buffers.num_buffers() != 1 {
                self.queue.finish(
                    "ScreenCaptureKit returned an unexpected interleaved audio layout".into(),
                );
                return;
            }
            let Some(buffer) = buffers.get(0) else {
                self.queue
                    .finish("ScreenCaptureKit returned an empty audio buffer".into());
                return;
            };
            if buffer.number_channels != 2 || buffer.data_bytes_size % 8 != 0 {
                self.queue
                    .finish("ScreenCaptureKit returned an unexpected stereo audio format".into());
                return;
            }
            let input = buffer.data();
            pcm.reserve(input.len() / 2);
            for frame in input.chunks_exact(8) {
                pcm.extend_from_slice(&float_to_s16le(&frame[..4]));
                pcm.extend_from_slice(&float_to_s16le(&frame[4..]));
            }
        }
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pending.extend_from_slice(&pcm);
        while pending.len() >= super::CHUNK_BYTES {
            self.queue
                .push(pending.drain(..super::CHUNK_BYTES).collect());
        }
    }
}

/// Running ScreenCaptureKit sound capture. Dropping it stops the stream and ends the queue.
pub(super) struct Backend {
    stream: SCStream,
    queue: Arc<SoundQueue>,
    pending: Arc<Mutex<Vec<u8>>>,
}

/// Start capturing the default display's system audio.
pub(super) fn start(queue: Arc<SoundQueue>) -> io::Result<Backend> {
    let content = SCShareableContent::get().map_err(|error| {
        io::Error::new(
            io::ErrorKind::Other,
            format!("could not query ScreenCaptureKit content: {error}"),
        )
    })?;
    let displays = content.displays();
    let display = displays.first().ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "ScreenCaptureKit found no display")
    })?;

    let configuration = SCStreamConfiguration::new()
        .set_captures_audio(true)
        .and_then(|config| config.set_channel_count(2))
        .and_then(|config| config.set_width(2))
        .and_then(|config| config.set_height(2))
        .map_err(|error| {
            io::Error::new(
                io::ErrorKind::Other,
                format!("could not configure ScreenCaptureKit audio: {error}"),
            )
        })?;
    let filter = SCContentFilter::new().with_display_excluding_windows(display, &[]);
    let mut stream = SCStream::new(&filter, &configuration);
    let pending = Arc::new(Mutex::new(Vec::with_capacity(super::CHUNK_BYTES * 2)));
    stream
        .add_output_handler(
            AudioOutput {
                queue: Arc::clone(&queue),
                pending: Arc::clone(&pending),
            },
            SCStreamOutputType::Audio,
        )
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Other,
                "could not attach ScreenCaptureKit audio output handler",
            )
        })?;
    stream.start_capture().map_err(|error| {
        io::Error::new(
            io::ErrorKind::Other,
            format!("could not start ScreenCaptureKit audio: {error}"),
        )
    })?;
    Ok(Backend {
        stream,
        queue,
        pending,
    })
}

impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.stream.stop_capture();
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let usable = pending.len() - pending.len() % 4;
        if usable > 0 {
            self.queue.push(pending.drain(..usable).collect());
        }
        self.queue
            .finish("ScreenCaptureKit sound capture stopped".into());
    }
}

#[cfg(test)]
mod tests {
    use super::{float_to_s16le, interleave_planar_stereo};

    #[test]
    fn planar_stereo_samples_are_interleaved_as_signed_little_endian_pcm() {
        let left = [0.5f32.to_le_bytes(), (-0.5f32).to_le_bytes()].concat();
        let right = [(-1.0f32).to_le_bytes(), 1.0f32.to_le_bytes()].concat();
        assert_eq!(
            interleave_planar_stereo(&left, &right).unwrap(),
            [
                16384i16.to_le_bytes(),
                (-32768i16).to_le_bytes(),
                (-16384i16).to_le_bytes(),
                32767i16.to_le_bytes()
            ]
            .concat()
        );
        assert!(interleave_planar_stereo(&left, &right[..4]).is_none());
    }

    #[test]
    fn float_samples_convert_to_signed_little_endian_pcm() {
        assert_eq!(
            float_to_s16le(&1.0f32.to_le_bytes()),
            i16::MAX.to_le_bytes()
        );
        assert_eq!(
            float_to_s16le(&(-1.0f32).to_le_bytes()),
            i16::MIN.to_le_bytes()
        );
        assert_eq!(float_to_s16le(&f32::NAN.to_le_bytes()), [0, 0]);
    }
}
