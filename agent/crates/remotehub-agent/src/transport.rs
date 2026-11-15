//! Framing for the agent control protocol (SAA-294, consumed by SAA-295).
//!
//! The wire format is newline-delimited JSON: exactly one JSON value per line.
//! The same framing carries both transports — stdin/stdout for a temporary helper
//! and an accepted TCP stream for the persistent service — so request handling is
//! written once.
//!
//! Reading is byte-oriented (`read_until`) rather than `read_line`, so a stray
//! invalid byte becomes a recoverable [`Incoming::Malformed`] frame instead of an
//! unbounded read error, and the offending line is always consumed.

use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};

use crate::json::{self, Value};

/// One frame read from the transport.
#[derive(Debug)]
pub enum Incoming {
    /// A well-formed JSON document.
    Message(Value),
    /// A WebSocket Ping was answered with Pong; no application message was received.
    Keepalive,
    /// A timed socket read expired. WebSocket transports retain any partial frame bytes.
    Timeout,
    /// A non-empty line that is not valid UTF-8 or not valid JSON. The caller
    /// decides whether to report it and keep reading.
    Malformed(String),
    /// The peer closed the stream.
    Eof,
}

/// Newline-delimited JSON over any buffered reader and writer.
pub struct JsonLines<R: BufRead, W: Write> {
    reader: R,
    writer: W,
    buffer: Vec<u8>,
}

impl<R: BufRead, W: Write> JsonLines<R, W> {
    pub fn new(reader: R, writer: W) -> JsonLines<R, W> {
        JsonLines { reader, writer, buffer: Vec::with_capacity(1024) }
    }

    /// Read the next non-empty frame. Blank lines are skipped.
    pub fn next_message(&mut self) -> io::Result<Incoming> {
        loop {
            self.buffer.clear();
            if self.reader.read_until(b'\n', &mut self.buffer)? == 0 {
                return Ok(Incoming::Eof);
            }
            let text = match std::str::from_utf8(&self.buffer) {
                Ok(text) => text.trim(),
                Err(error) => return Ok(Incoming::Malformed(format!("invalid UTF-8: {error}"))),
            };
            if text.is_empty() {
                continue;
            }
            return match json::decode(text) {
                Ok(value) => Ok(Incoming::Message(value)),
                Err(error) => Ok(Incoming::Malformed(error.to_string())),
            };
        }
    }

    /// Write one frame followed by a newline and flush it. The frame goes out in a
    /// single `write_all`, so with a [`SharedWriter`] it never interleaves with a
    /// frame written from another thread (e.g. a `filesystemEvent`).
    pub fn write_message(&mut self, value: &Value) -> io::Result<()> {
        self.writer.write_all(&frame(value))?;
        self.writer.flush()
    }

    /// Borrow the underlying writer, e.g. to inspect a transport's output.
    pub fn writer(&self) -> &W {
        &self.writer
    }
}

/// Encode one newline-terminated frame.
pub fn frame(value: &Value) -> Vec<u8> {
    let mut bytes = value.encode().into_bytes();
    bytes.push(b'\n');
    bytes
}

/// A cloneable writer that serializes whole writes behind a mutex, so responses
/// from the request loop and events from watch threads share one stream safely.
pub struct SharedWriter<W: Write>(Arc<Mutex<W>>);

impl<W: Write> SharedWriter<W> {
    pub fn new(inner: W) -> SharedWriter<W> {
        SharedWriter(Arc::new(Mutex::new(inner)))
    }

    /// Lock the inner writer (tests use this to read what was written).
    pub fn lock(&self) -> std::sync::MutexGuard<'_, W> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl<W: Write> Clone for SharedWriter<W> {
    fn clone(&self) -> SharedWriter<W> {
        SharedWriter(Arc::clone(&self.0))
    }
}

impl<W: Write> Write for SharedWriter<W> {
    /// Writes the whole buffer under one lock so a frame is never split.
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.lock().write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.lock().flush()
    }
}

/// Temporary-mode transport: the control channel is the helper's own stdin/stdout.
pub fn stdio() -> JsonLines<io::BufReader<io::Stdin>, SharedWriter<io::Stdout>> {
    JsonLines::new(io::BufReader::new(io::stdin()), SharedWriter::new(io::stdout()))
}

/// Persistent-mode transport: the control channel is an accepted TCP stream.
pub fn from_tcp(stream: std::net::TcpStream) -> io::Result<JsonLines<io::BufReader<std::net::TcpStream>, SharedWriter<std::net::TcpStream>>> {
    let reader = io::BufReader::new(stream.try_clone()?);
    Ok(JsonLines::new(reader, SharedWriter::new(stream)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_messages_skips_blanks_and_reports_malformed_and_eof() {
        let input = Cursor::new(b"{\"op\":\"ping\"}\n\n  \nnot json\n".to_vec());
        let output = Cursor::new(Vec::new());
        let mut transport = JsonLines::new(input, output);

        match transport.next_message().unwrap() {
            Incoming::Message(value) => assert_eq!(value.get("op").and_then(Value::as_str), Some("ping")),
            other => panic!("expected a message, got {other:?}"),
        }
        assert!(matches!(transport.next_message().unwrap(), Incoming::Malformed(_)));
        assert!(matches!(transport.next_message().unwrap(), Incoming::Eof));
    }

    #[test]
    fn writes_newline_delimited_json() {
        let input = Cursor::new(Vec::new());
        let output = Cursor::new(Vec::new());
        let mut transport = JsonLines::new(input, output);
        transport.write_message(&Value::object(vec![("ok", Value::Bool(true))])).unwrap();
        assert_eq!(String::from_utf8(transport.writer().get_ref().clone()).unwrap(), "{\"ok\":true}\n");
    }
}
