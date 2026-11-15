//! Versioned control protocol for the RemoteHub agent (foundation for SAA-295).
//!
//! The wire format is newline-delimited JSON. The agent sends an unsolicited
//! `hello` event on connect; the peer then sends requests and reads responses:
//!
//! ```text
//! agent  -> {"event":"hello","protocol":1,"name":"remotehub-agent","version":"0.1.0",
//!            "mode":"persistent","capabilities":{...}}
//! peer   -> {"id":1,"op":"info"}
//! agent  -> {"id":1,"ok":true,"result":{...}}
//! peer   -> {"id":2,"op":"fs.list","params":{"path":"."}}
//! agent  -> {"id":2,"ok":true,"result":{"entries":[...]}}
//! peer   -> {"id":3,"op":"shutdown"}
//! agent  -> {"id":3,"ok":true,"result":{"stopping":true}}
//! ```
//!
//! `PROTOCOL_VERSION` is the number to bump on any breaking change; SAA-295 owns
//! its evolution. This module defines the envelope and the handshake, and leaves
//! request dispatch to [`crate::lifecycle`].

use std::fmt;

use crate::capabilities::Capabilities;
use crate::config::{Mode, AGENT_NAME, AGENT_VERSION};
use crate::json::Value;

/// Breaking-change counter for the control protocol.
pub const PROTOCOL_VERSION: u32 = 1;

/// Operation names. Unknown operations are answered with an error, never ignored.
pub mod op {
    pub const HELLO: &str = "hello";
    pub const PING: &str = "ping";
    pub const HEARTBEAT: &str = "heartbeat";
    pub const INFO: &str = "info";
    pub const CAPABILITIES: &str = "capabilities";
    pub const FS_LIST: &str = "fs.list";
    /// Capability marker for bounded, cursor-based directory pages.
    pub const FS_LIST_PAGE: &str = "fs.list.page";
    pub const FS_READ: &str = "fs.read";
    pub const FS_WRITE: &str = "fs.write";
    pub const EXEC_RUN: &str = "exec.run";
    /// Legacy wire name; `requestId` identifies any queued agent operation.
    pub const EXEC_CANCEL: &str = "exec.cancel";
    pub const WATCH_DIRECTORY: &str = "watchDirectory";
    pub const UNWATCH_DIRECTORY: &str = "unwatchDirectory";
    pub const SHUTDOWN: &str = "shutdown";
    pub const SHUTDOWN_TEMPORARY: &str = "shutdownTemporary";
    /// Start/stop streaming the computer's sound output (`audio` events) on the outbound connection.
    pub const AUDIO_START: &str = "audio.start";
    pub const AUDIO_STOP: &str = "audio.stop";
    /// Capability marker in `hello.operations`: this agent can capture sound here.
    pub const AUDIO_CAPTURE: &str = "audio.capture";

    /// Reserved for native desktop signaling (SAA-307 and later). They parse, but
    /// the agent answers `reserved` until a desktop backend exists.
    pub const RESERVED_DESKTOP: [&str; 4] = ["desktopOffer", "desktopAnswer", "desktopIceCandidate", "desktopClose"];
}

/// Event names the agent emits unsolicited (no `id`).
pub mod event {
    pub const HELLO: &str = "hello";
    pub const AUTHENTICATED: &str = "authenticated";
    pub const FILESYSTEM_EVENT: &str = "filesystemEvent";
    /// `{"event":"audio","data":"<base64 audio/L16;rate=48000,channels=2>"}`
    pub const AUDIO: &str = "audio";
    /// `{"event":"audioEnd","reason":"..."}`: capture stopped on its own.
    pub const AUDIO_END: &str = "audioEnd";
}

/// Stable machine-readable error codes on the wire.
pub mod code {
    pub const BAD_REQUEST: &str = "bad_request";
    pub const UNKNOWN_OP: &str = "unknown_op";
    pub const INVALID_PARAMS: &str = "invalid_params";
    pub const PROTOCOL_MISMATCH: &str = "protocol_mismatch";
    pub const RESERVED: &str = "reserved";
    pub const UNSUPPORTED: &str = "unsupported";
    pub const WRONG_MODE: &str = "wrong_mode";
    pub const IO_ERROR: &str = "io_error";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const REVOKED: &str = "revoked";
    /// `unwatchDirectory` named a watch this connection does not have.
    pub const UNKNOWN_WATCH: &str = "unknown_watch";
    /// The connection already holds the maximum number of watches.
    pub const LIMIT_EXCEEDED: &str = "limit_exceeded";
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError {
    code: &'static str,
    message: String,
}

impl ProtocolError {
    pub fn new(message: impl Into<String>) -> ProtocolError {
        ProtocolError { code: code::BAD_REQUEST, message: message.into() }
    }

    pub fn with_code(code: &'static str, message: impl Into<String>) -> ProtocolError {
        ProtocolError { code, message: message.into() }
    }

    /// The wire error code for this failure.
    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProtocolError {}

/// A request line: `{ "id": <any>, "op": "<name>", "params": <any> }`.
///
/// `id` and `params` are optional; a missing `id` is echoed back as `null`.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: Value,
    pub op: String,
    pub params: Value,
}

impl Request {
    pub fn from_value(value: Value) -> Result<Request, ProtocolError> {
        let op = value
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| ProtocolError::new("request is missing a string \"op\""))?
            .to_string();
        Ok(Request {
            id: value.get("id").cloned().unwrap_or(Value::Null),
            op,
            params: value.get("params").cloned().unwrap_or(Value::Null),
        })
    }
}

/// A response line: `{ "id": <id>, "ok": true, "result": <any> }` on success, or
/// `{ "id": <id>, "ok": false, "error": { "code": ..., "message": ... } }` on failure.
#[derive(Clone, Debug, PartialEq)]
pub struct Response {
    pub id: Value,
    pub ok: bool,
    /// The result on success, or the error object on failure.
    pub body: Value,
}

impl Response {
    pub fn success(id: Value, result: Value) -> Response {
        Response { id, ok: true, body: result }
    }

    pub fn failure(id: Value, code: &str, message: impl Into<String>) -> Response {
        let error = Value::object(vec![
            ("code", Value::string(code)),
            ("message", Value::string(message.into())),
        ]);
        Response { id, ok: false, body: error }
    }

    pub fn to_value(&self) -> Value {
        if self.ok {
            Value::object(vec![
                ("id", self.id.clone()),
                ("ok", Value::Bool(true)),
                ("result", self.body.clone()),
            ])
        } else {
            Value::object(vec![
                ("id", self.id.clone()),
                ("ok", Value::Bool(false)),
                ("error", self.body.clone()),
            ])
        }
    }
}

/// The unsolicited handshake the agent sends as soon as a connection is ready.
/// This is where the agent "reports version and mode" (SAA-294 acceptance).
#[derive(Clone, Debug, PartialEq)]
pub struct Hello {
    pub protocol: u32,
    pub name: &'static str,
    pub version: &'static str,
    pub mode: Mode,
    pub capabilities: Capabilities,
    pub host_id: Option<String>,
    pub token: Option<String>,
}

impl Hello {
    pub fn current(mode: Mode, capabilities: Capabilities) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            name: AGENT_NAME,
            version: AGENT_VERSION,
            mode,
            capabilities,
            host_id: None,
            token: None,
        }
    }

    pub fn with_registration(mut self, host_id: impl Into<String>, token: impl Into<String>) -> Hello {
        self.host_id = Some(host_id.into());
        self.token = Some(token.into());
        self
    }

    pub fn to_value(&self) -> Value {
        let mut operations = vec![op::FS_LIST, op::FS_LIST_PAGE, op::FS_READ, op::FS_WRITE];
        if self.capabilities.commands.exec { operations.push(op::EXEC_RUN); }
        // Sound streams only over the registered outbound connection (the one with a host id).
        if crate::audio::SUPPORTED && self.host_id.is_some() { operations.push(op::AUDIO_CAPTURE); }
        let mut entries = vec![
            ("event", Value::string("hello")),
            ("protocol", Value::Number(self.protocol as f64)),
            ("name", Value::string(self.name)),
            ("version", Value::string(self.version)),
            ("mode", Value::string(self.mode.as_str())),
            ("capabilities", self.capabilities.to_value()),
            ("operations", Value::Array(operations.into_iter().map(Value::string).collect())),
            // SAA-300: the platform the agent actually runs on, so RemoteHub can show
            // OS/arch without guessing. Informational only; executable support is
            // reported through the explicit operations list.
            (
                "system",
                Value::object(vec![
                    ("os", Value::string(std::env::consts::OS)),
                    ("family", Value::string(std::env::consts::FAMILY)),
                    ("arch", Value::string(std::env::consts::ARCH)),
                ]),
            ),
        ];
        if let Some(host_id) = &self.host_id {
            entries.push(("hostId", Value::string(host_id.clone())));
        }
        if let Some(token) = &self.token {
            entries.push(("token", Value::string(token.clone())));
        }
        Value::object(entries)
    }
}

/// A request decoded into one of the fixed, typed operations the agent supports.
///
/// Each supported operation is enumerated here; unrecognized operations fail closed.
pub const MAX_COMMAND_ARGUMENTS: usize = 64;
pub const MAX_COMMAND_ARGUMENT_LENGTH: usize = 4096;
pub const MAX_COMMAND_ARGUMENT_BYTES: usize = 64 * 1024;
pub const MAX_COMMAND_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_COMMAND_TIMEOUT_MS: u64 = 300_000;

#[derive(Clone, Debug, PartialEq)]
pub enum ClientMessage {
    /// Optional version negotiation. `protocol` is the peer's version, if sent.
    Hello { protocol: Option<u32> },
    Ping,
    Heartbeat,
    Info,
    Capabilities,
    ListDirectory { path: String, cursor: Option<String>, limit: usize },
    ReadFile { path: String },
    WriteFile { path: String, content: String },
    RunCommand { executable: String, args: Vec<String>, stdin: Option<String>, timeout_ms: u64 },
    CancelRequest { request_id: String },
    WatchDirectory { path: String },
    UnwatchDirectory { watch_id: u64 },
    /// Stop the agent (any mode). Kept for SAA-294 compatibility.
    Shutdown,
    /// Stop a temporary helper; refused by a persistent service.
    ShutdownTemporary,
    /// A reserved desktop signaling message (not implemented yet).
    ReservedDesktop { op: String },
    /// Start streaming the computer's sound output (outbound connection only).
    AudioStart,
    AudioStop,
}

fn string_param(params: &Value, key: &str) -> Result<String, ProtocolError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ProtocolError::with_code(code::INVALID_PARAMS, format!("params.{key} must be a string")))
}

fn optional_string_param(params: &Value, key: &str, max_bytes: usize) -> Result<Option<String>, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.len() <= max_bytes => Ok(Some(value.clone())),
        _ => Err(ProtocolError::with_code(code::INVALID_PARAMS, format!("params.{key} must be text no larger than {max_bytes} UTF-8 bytes"))),
    }
}

fn directory_page_limit(params: &Value) -> Result<usize, ProtocolError> {
    match params.get("limit") {
        None | Some(Value::Null) => Ok(crate::files::DEFAULT_DIRECTORY_PAGE_SIZE),
        Some(value) => value.as_i64()
            .filter(|limit| (1..=crate::files::MAX_DIRECTORY_PAGE_SIZE as i64).contains(limit))
            .map(|limit| limit as usize)
            .ok_or_else(|| ProtocolError::with_code(code::INVALID_PARAMS, "params.limit must be an integer between 1 and 256")),
    }
}

impl ClientMessage {
    pub fn parse(request: &Request) -> Result<ClientMessage, ProtocolError> {
        let params = &request.params;
        if !matches!(params, Value::Null | Value::Object(_)) {
            return Err(ProtocolError::with_code(code::INVALID_PARAMS, "params must be an object when present"));
        }
        let message = match request.op.as_str() {
            op::HELLO => {
                let protocol = match params.get("protocol") {
                    None | Some(Value::Null) => None,
                    Some(value) => match value.as_i64() {
                        Some(number) if (0..=u32::MAX as i64).contains(&number) => Some(number as u32),
                        _ => return Err(ProtocolError::with_code(code::INVALID_PARAMS, "params.protocol must be a non-negative integer")),
                    },
                };
                ClientMessage::Hello { protocol }
            }
            op::PING => ClientMessage::Ping,
            op::HEARTBEAT => ClientMessage::Heartbeat,
            op::AUDIO_START => ClientMessage::AudioStart,
            op::AUDIO_STOP => ClientMessage::AudioStop,
            op::INFO => ClientMessage::Info,
            op::CAPABILITIES => ClientMessage::Capabilities,
            op::FS_LIST => ClientMessage::ListDirectory {
                path: match params.get("path") {
                    None | Some(Value::Null) => ".".to_string(),
                    Some(_) => string_param(params, "path")?,
                },
                cursor: optional_string_param(params, "cursor", 4096)?,
                limit: directory_page_limit(params)?,
            },
            op::FS_READ => ClientMessage::ReadFile { path: string_param(params, "path")? },
            op::FS_WRITE => {
                let content = string_param(params, "content")?;
                if content.len() > crate::files::MAX_WRITE_FILE {
                    return Err(ProtocolError::with_code(
                        code::INVALID_PARAMS,
                        "params.content exceeds 1 MiB in UTF-8 bytes",
                    ));
                }
                ClientMessage::WriteFile { path: string_param(params, "path")?, content }
            }
            op::EXEC_RUN => {
                let executable = string_param(params, "executable")?;
                if executable.is_empty() || executable.len() > 256 || executable.chars().any(|c| c == char::from(0)) {
                    return Err(ProtocolError::with_code(code::INVALID_PARAMS, "params.executable must be 1 to 256 bytes and contain no NUL"));
                }
                let mut args = Vec::new();
                let mut total_argument_bytes = 0usize;
                if let Some(value) = params.get("args") {
                    let items = value.as_array().ok_or_else(|| ProtocolError::with_code(code::INVALID_PARAMS, "params.args must be an array of strings"))?;
                    if items.len() > MAX_COMMAND_ARGUMENTS {
                        return Err(ProtocolError::with_code(code::INVALID_PARAMS, "params.args may contain at most 64 entries"));
                    }
                    for item in items {
                        let arg = item.as_str().ok_or_else(|| ProtocolError::with_code(code::INVALID_PARAMS, "params.args must contain only strings"))?;
                        if arg.len() > MAX_COMMAND_ARGUMENT_LENGTH || arg.chars().any(|c| c == char::from(0)) {
                            return Err(ProtocolError::with_code(code::INVALID_PARAMS, "each argument must be at most 4096 bytes and contain no NUL"));
                        }
                        total_argument_bytes = total_argument_bytes.saturating_add(arg.len());
                        if total_argument_bytes > MAX_COMMAND_ARGUMENT_BYTES {
                            return Err(ProtocolError::with_code(code::INVALID_PARAMS, "combined arguments exceed 64 KiB"));
                        }
                        args.push(arg.to_string());
                    }
                }
                let stdin = match params.get("stdin") {
                    None | Some(Value::Null) => None,
                    Some(value) => {
                        let input = value.as_str().ok_or_else(|| ProtocolError::with_code(code::INVALID_PARAMS, "params.stdin must be a string"))?;
                        if input.len() > MAX_COMMAND_INPUT_BYTES {
                            return Err(ProtocolError::with_code(code::INVALID_PARAMS, "params.stdin exceeds 64 KiB"));
                        }
                        Some(input.to_string())
                    }
                };
                let timeout_ms = match params.get("timeoutMs") {
                    None => 10_000,
                    Some(value) => value.as_i64().filter(|n| *n >= 1_000 && *n <= MAX_COMMAND_TIMEOUT_MS as i64)
                        .ok_or_else(|| ProtocolError::with_code(code::INVALID_PARAMS, "params.timeoutMs must be between 1000 and 300000"))? as u64,
                };
                ClientMessage::RunCommand { executable, args, stdin, timeout_ms }
            }
            op::EXEC_CANCEL => {
                let request_id = string_param(params, "requestId")?;
                if request_id.is_empty() || request_id.len() > 128 || request_id.chars().any(|ch| ch == char::from(0)) {
                    return Err(ProtocolError::with_code(code::INVALID_PARAMS, "params.requestId must contain 1 to 128 non-NUL bytes"));
                }
                ClientMessage::CancelRequest { request_id }
            }
            op::WATCH_DIRECTORY => ClientMessage::WatchDirectory { path: string_param(params, "path")? },
            op::UNWATCH_DIRECTORY => {
                let watch_id = params
                    .get("watchId")
                    .and_then(Value::as_i64)
                    .filter(|id| *id >= 0)
                    .ok_or_else(|| ProtocolError::with_code(code::INVALID_PARAMS, "params.watchId must be a non-negative integer"))?;
                ClientMessage::UnwatchDirectory { watch_id: watch_id as u64 }
            }
            op::SHUTDOWN => ClientMessage::Shutdown,
            op::SHUTDOWN_TEMPORARY => ClientMessage::ShutdownTemporary,
            other if op::RESERVED_DESKTOP.contains(&other) => ClientMessage::ReservedDesktop { op: other.to_string() },
            other => return Err(ProtocolError::with_code(code::UNKNOWN_OP, format!("unknown operation \"{other}\""))),
        };
        Ok(message)
    }

    /// Serialize back to a request line. Used by tests and by future Rust peers.
    pub fn to_request(&self, id: Value) -> Request {
        let (name, params) = match self {
            ClientMessage::Hello { protocol } => (
                op::HELLO.to_string(),
                protocol.map_or(Value::Null, |p| Value::object(vec![("protocol", Value::Number(p as f64))])),
            ),
            ClientMessage::Ping => (op::PING.to_string(), Value::Null),
            ClientMessage::Heartbeat => (op::HEARTBEAT.to_string(), Value::Null),
            ClientMessage::AudioStart => (op::AUDIO_START.to_string(), Value::Null),
            ClientMessage::AudioStop => (op::AUDIO_STOP.to_string(), Value::Null),
            ClientMessage::Info => (op::INFO.to_string(), Value::Null),
            ClientMessage::Capabilities => (op::CAPABILITIES.to_string(), Value::Null),
            ClientMessage::ListDirectory { path, cursor, limit } => {
                let mut params = vec![
                    ("path", Value::string(path.clone())),
                    ("limit", Value::Number(*limit as f64)),
                ];
                if let Some(cursor) = cursor { params.push(("cursor", Value::string(cursor.clone()))); }
                (op::FS_LIST.to_string(), Value::object(params))
            }
            ClientMessage::ReadFile { path } => (op::FS_READ.to_string(), Value::object(vec![("path", Value::string(path.clone()))])),
            ClientMessage::WriteFile { path, content } => (op::FS_WRITE.to_string(), Value::object(vec![("path", Value::string(path.clone())), ("content", Value::string(content.clone()))])),
            ClientMessage::RunCommand { executable, args, stdin, timeout_ms } => {
                let mut params = vec![
                    ("executable", Value::string(executable.clone())),
                    ("args", Value::Array(args.iter().cloned().map(Value::string).collect())),
                    ("timeoutMs", Value::Number(*timeout_ms as f64)),
                ];
                if let Some(input) = stdin { params.push(("stdin", Value::string(input.clone()))); }
                (op::EXEC_RUN.to_string(), Value::object(params))
            },
            ClientMessage::CancelRequest { request_id } => (op::EXEC_CANCEL.to_string(), Value::object(vec![("requestId", Value::string(request_id.clone()))])),
            ClientMessage::WatchDirectory { path } => (op::WATCH_DIRECTORY.to_string(), Value::object(vec![("path", Value::string(path.clone()))])),
            ClientMessage::UnwatchDirectory { watch_id } => (op::UNWATCH_DIRECTORY.to_string(), Value::object(vec![("watchId", Value::Number(*watch_id as f64))])),
            ClientMessage::Shutdown => (op::SHUTDOWN.to_string(), Value::Null),
            ClientMessage::ShutdownTemporary => (op::SHUTDOWN_TEMPORARY.to_string(), Value::Null),
            ClientMessage::ReservedDesktop { op } => (op.clone(), Value::Null),
        };
        Request { id, op: name, params }
    }
}

impl Request {
    pub fn to_value(&self) -> Value {
        let mut entries = vec![("id", self.id.clone()), ("op", Value::string(self.op.clone()))];
        if self.params != Value::Null {
            entries.push(("params", self.params.clone()));
        }
        Value::object(entries)
    }
}

/// Reply to a successful `hello` negotiation.
/// One piece of captured sound, as an unsolicited event.
pub fn audio_event(pcm: &[u8]) -> Value {
    Value::object(vec![("event", Value::string(event::AUDIO)), ("data", Value::string(crate::audio::base64(pcm)))])
}

/// Capture stopped without being asked to (the recorder exited).
pub fn audio_end_event(reason: &str) -> Value {
    Value::object(vec![("event", Value::string(event::AUDIO_END)), ("reason", Value::string(reason))])
}

pub fn authenticated(mode: Mode) -> Value {
    Value::object(vec![
        ("event", Value::string(event::AUTHENTICATED)),
        ("protocol", Value::Number(PROTOCOL_VERSION as f64)),
        ("mode", Value::string(mode.as_str())),
    ])
}

/// Normalized filesystem change kinds the browser consumes (produced by SAA-297).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsChange {
    Create,
    Delete,
    Modify,
    Rename,
    /// The watched directory itself disappeared or became unreadable; the watch ended.
    Unavailable,
}

impl FsChange {
    pub fn as_str(self) -> &'static str {
        match self {
            FsChange::Create => "create",
            FsChange::Delete => "delete",
            FsChange::Modify => "modify",
            FsChange::Rename => "rename",
            FsChange::Unavailable => "unavailable",
        }
    }

    pub fn parse(value: &str) -> Option<FsChange> {
        [FsChange::Create, FsChange::Delete, FsChange::Modify, FsChange::Rename, FsChange::Unavailable]
            .into_iter()
            .find(|change| change.as_str() == value)
    }
}

/// `{"event":"filesystemEvent","watchId":N,"change":"...","path":"...","from":"..."}`
#[derive(Clone, Debug, PartialEq)]
pub struct FilesystemEvent {
    pub watch_id: u64,
    pub change: FsChange,
    pub path: String,
    /// The previous path for a rename.
    pub from: Option<String>,
}

impl FilesystemEvent {
    pub fn to_value(&self) -> Value {
        let mut entries = vec![
            ("event", Value::string(event::FILESYSTEM_EVENT)),
            ("watchId", Value::Number(self.watch_id as f64)),
            ("change", Value::string(self.change.as_str())),
            ("path", Value::string(self.path.clone())),
        ];
        if let Some(from) = &self.from {
            entries.push(("from", Value::string(from.clone())));
        }
        Value::object(entries)
    }

    pub fn from_value(value: &Value) -> Result<FilesystemEvent, ProtocolError> {
        if value.get("event").and_then(Value::as_str) != Some(event::FILESYSTEM_EVENT) {
            return Err(ProtocolError::new("not a filesystemEvent"));
        }
        let watch_id = value.get("watchId").and_then(Value::as_i64).filter(|id| *id >= 0).ok_or_else(|| ProtocolError::new("watchId must be a non-negative integer"))?;
        let change = value.get("change").and_then(Value::as_str).and_then(FsChange::parse).ok_or_else(|| ProtocolError::new("unknown change kind"))?;
        let path = value.get("path").and_then(Value::as_str).ok_or_else(|| ProtocolError::new("path must be a string"))?.to_string();
        let from = value.get("from").and_then(Value::as_str).map(str::to_string);
        Ok(FilesystemEvent { watch_id: watch_id as u64, change, path, from })
    }
}

#[cfg(test)]
mod tests {
    fn parse(line: &str) -> Result<ClientMessage, ProtocolError> {
        ClientMessage::parse(&Request::from_value(json::decode(line).unwrap()).unwrap())
    }

    #[test]
    fn every_typed_message_round_trips_through_the_wire_format() {
        let messages = vec![
            ClientMessage::Hello { protocol: Some(1) },
            ClientMessage::Hello { protocol: None },
            ClientMessage::Ping,
            ClientMessage::Heartbeat,
            ClientMessage::Info,
            ClientMessage::Capabilities,
            ClientMessage::ListDirectory { path: "docs".into(), cursor: Some("README.md".into()), limit: 25 },
            ClientMessage::WatchDirectory { path: "docs".into() },
            ClientMessage::UnwatchDirectory { watch_id: 4 },
            ClientMessage::Shutdown,
            ClientMessage::ShutdownTemporary,
            ClientMessage::ReservedDesktop { op: "desktopOffer".into() },
            ClientMessage::CancelRequest { request_id: "remotehub-123".into() },
        ];
        for message in messages {
            let line = message.to_request(Value::Number(7.0)).to_value().encode();
            assert_eq!(parse(&line).unwrap(), message, "round trip of {line}");
        }
    }

    #[test]
    fn unknown_and_malformed_messages_fail_with_stable_codes() {
        assert_eq!(parse("{\"op\":\"exec\",\"params\":{\"cmd\":\"rm -rf /\"}}").unwrap_err().code(), code::UNKNOWN_OP);
        assert_eq!(parse("{\"op\":\"watchDirectory\"}").unwrap_err().code(), code::INVALID_PARAMS);
        assert_eq!(parse("{\"op\":\"unwatchDirectory\",\"params\":{\"watchId\":-1}}").unwrap_err().code(), code::INVALID_PARAMS);
        assert_eq!(parse("{\"op\":\"hello\",\"params\":{\"protocol\":\"one\"}}").unwrap_err().code(), code::INVALID_PARAMS);
        assert_eq!(parse("{\"op\":\"ping\",\"params\":[1]}").unwrap_err().code(), code::INVALID_PARAMS);
        assert_eq!(parse("{\"op\":\"fs.list\",\"params\":{\"path\":5}}").unwrap_err().code(), code::INVALID_PARAMS);
        assert_eq!(parse("{\"op\":\"fs.list\"}").unwrap(), ClientMessage::ListDirectory { path: ".".into(), cursor: None, limit: crate::files::DEFAULT_DIRECTORY_PAGE_SIZE });
        assert_eq!(parse("{\"op\":\"fs.list\",\"params\":{\"limit\":257}}").unwrap_err().code(), code::INVALID_PARAMS);
        assert_eq!(parse("{\"op\":\"fs.list\",\"params\":{\"cursor\":5}}").unwrap_err().code(), code::INVALID_PARAMS);
        assert_eq!(parse("{\"op\":\"exec.cancel\",\"params\":{\"requestId\":\"remotehub-1\"}}").unwrap(), ClientMessage::CancelRequest { request_id: "remotehub-1".into() });
        assert_eq!(parse("{\"op\":\"exec.cancel\",\"params\":{\"requestId\":\"\"}}").unwrap_err().code(), code::INVALID_PARAMS);
    }

    #[test]
    fn rejects_file_write_above_utf8_byte_limit_with_explicit_units() {
        let content = "a".repeat(crate::files::MAX_WRITE_FILE + 1);
        let json = format!(
            r#"{{"op":"fs.write","params":{{"path":"too-large.txt","content":"{content}"}}}}"#
        );
        let error = parse(&json).unwrap_err();
        assert_eq!(error.code(), code::INVALID_PARAMS);
        assert_eq!(
            error.to_string(),
            "params.content exceeds 1 MiB in UTF-8 bytes"
        );
    }

    #[test]
    fn filesystem_events_round_trip() {
        let event = FilesystemEvent { watch_id: 2, change: FsChange::Rename, path: "/r/b".into(), from: Some("/r/a".into()) };
        let value = event.to_value();
        assert_eq!(value.encode(), "{\"change\":\"rename\",\"event\":\"filesystemEvent\",\"from\":\"/r/a\",\"path\":\"/r/b\",\"watchId\":2}");
        assert_eq!(FilesystemEvent::from_value(&value).unwrap(), event);
        let bad = json::decode("{\"event\":\"filesystemEvent\",\"watchId\":1,\"change\":\"explode\",\"path\":\"x\"}").unwrap();
        assert!(FilesystemEvent::from_value(&bad).is_err());
    }

    use super::*;
    use crate::json;

    #[test]
    fn parses_a_request_and_defaults_optional_fields() {
        let request = Request::from_value(json::decode("{\"id\":3,\"op\":\"fs.list\",\"params\":{\"path\":\".\"}}").unwrap()).unwrap();
        assert_eq!(request.id, Value::Number(3.0));
        assert_eq!(request.op, "fs.list");
        assert_eq!(request.params.get("path").and_then(Value::as_str), Some("."));

        let bare = Request::from_value(json::decode("{\"op\":\"ping\"}").unwrap()).unwrap();
        assert_eq!(bare.id, Value::Null);
        assert_eq!(bare.params, Value::Null);
    }

    #[test]
    fn rejects_requests_without_an_op() {
        assert!(Request::from_value(json::decode("{\"id\":1}").unwrap()).is_err());
        assert!(Request::from_value(json::decode("{\"op\":7}").unwrap()).is_err());
    }

    #[test]
    fn responses_shapes_match_ok_and_error() {
        let ok = Response::success(Value::Number(1.0), Value::string("done")).to_value();
        assert_eq!(ok.encode(), "{\"id\":1,\"ok\":true,\"result\":\"done\"}");
        let error = Response::failure(Value::Null, "unknown_op", "nope").to_value();
        assert_eq!(error.encode(), "{\"error\":{\"code\":\"unknown_op\",\"message\":\"nope\"},\"id\":null,\"ok\":false}");
    }

    #[test]
    fn hello_reports_version_and_mode() {
        let hello = Hello::current(Mode::Temporary, Capabilities::for_agent(Mode::Temporary, "0.1.0")).to_value();
        assert_eq!(hello.get("event").and_then(Value::as_str), Some("hello"));
        assert_eq!(hello.get("protocol").and_then(Value::as_i64), Some(1));
        assert_eq!(hello.get("version").and_then(Value::as_str), Some(AGENT_VERSION));
        assert_eq!(hello.get("mode").and_then(Value::as_str), Some("temporary"));
        assert_eq!(hello.get("capabilities").and_then(|value| value.get("agent")).and_then(|value| value.get("available")).and_then(Value::as_bool), Some(true));
        assert_eq!(hello.get("hostId"), None);
        assert_eq!(hello.get("token"), None);
    }

    #[test]
    fn hello_reports_the_running_os_and_architecture() {
        let hello = Hello::current(Mode::Persistent, Capabilities::for_agent(Mode::Persistent, "0.1.0")).to_value();
        let system = hello.get("system").expect("system block");
        assert_eq!(system.get("os").and_then(Value::as_str), Some(std::env::consts::OS));
        assert_eq!(system.get("arch").and_then(Value::as_str), Some(std::env::consts::ARCH));
        assert_eq!(system.get("family").and_then(Value::as_str), Some(std::env::consts::FAMILY));
    }

    #[test]
    fn outbound_hello_includes_registration_fields() {
        let hello = Hello::current(Mode::Persistent, Capabilities::for_agent(Mode::Persistent, "0.1.0"))
            .with_registration("host-1", "rhag_1_secret");
        let value = hello.to_value();
        assert_eq!(value.get("hostId").and_then(Value::as_str), Some("host-1"));
        assert_eq!(value.get("token").and_then(Value::as_str), Some("rhag_1_secret"));
        let operations = value
            .get("operations")
            .and_then(Value::as_array)
            .expect("operations list");
        assert_eq!(
            operations
                .iter()
                .any(|operation| operation.as_str() == Some(op::AUDIO_CAPTURE)),
            crate::audio::SUPPORTED
        );
    }
}
