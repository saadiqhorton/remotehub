//! Startup, request loop, and shutdown for both execution modes (SAA-294).
//!
//! The two modes differ only in transport and lifetime:
//!
//! * **persistent** binds a TCP listener and serves one control connection at a
//!   time, returning to `accept()` after each disconnect. A `shutdown` request
//!   ends the process.
//! * **temporary** speaks the same framed protocol over stdin/stdout and exits as
//!   soon as the peer disconnects or asks it to stop — the shape SAA-299 will use
//!   to run a helper on an existing SSH channel.
//!
//! Idle behaviour is deliberate: no timers, no polling, no background threads.
//! Persistent mode blocks in `accept()` between connections, so an idle agent
//! consumes effectively no CPU.

use std::io::{self, BufRead, Write};
use std::net::TcpListener;
use std::process::ExitCode;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::audio;
use crate::capabilities::Capabilities;
use crate::config::{self, Config, Mode};
use crate::commands;
use crate::files;
use crate::helper;
use crate::json::Value;
use crate::local_auth;
use crate::protocol::{self, code, ClientMessage, FilesystemEvent, FsChange, Hello, Request, Response};
use crate::system::SystemInfo;
use crate::transport::{self, Incoming, JsonLines, SharedWriter};
use crate::watcher::{Change, ChangeKind, DirectoryWatch};
use crate::websocket::{self, Outbound, ServerUrl};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

// Reserve 124 KiB below the agent WebSocket payload cap for listing responses.
const MAX_LIST_RESPONSE_BYTES: usize = crate::websocket::MAX_OUTBOUND_FRAME_BYTES - 124 * 1024;

/// Why a served connection stopped. `Shutdown` ends the process; `Disconnected`
/// lets persistent mode wait for the next connection.
enum Outcome {
    Shutdown,
    Disconnected,
    /// The server closed a live session because the credential stopped being
    /// valid (revoked or replaced). Retrying cannot succeed, so the agent exits.
    Rejected(AuthFailure),
}

/// Why an outbound registration attempt stopped retrying.
enum AuthFailure {
    Revoked,
    Unauthorized,
}

struct PendingOutboundCommand {
    request_id: Value,
    cancellation: commands::Cancellation,
    receiver: Receiver<Response>,
    worker: Option<JoinHandle<()>>,
}

trait OutboundConnection {
    fn next_message(&mut self) -> io::Result<Incoming>;
    fn next_message_timeout(&mut self, timeout: Duration) -> io::Result<Incoming>;
    fn write_message(&mut self, value: &Value) -> io::Result<()>;
}

impl OutboundConnection for Outbound {
    fn next_message(&mut self) -> io::Result<Incoming> {
        Outbound::next_message(self)
    }

    fn next_message_timeout(&mut self, timeout: Duration) -> io::Result<Incoming> {
        Outbound::next_message_timeout(self, timeout)
    }

    fn write_message(&mut self, value: &Value) -> io::Result<()> {
        Outbound::write_message(self, value)
    }
}

impl PendingOutboundCommand {
    fn cancel(&self, request_id: &str) -> bool {
        if self.request_id.as_str() != Some(request_id) {
            return false;
        }
        self.cancellation.cancel();
        true
    }

    fn join_worker(&mut self) {
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for PendingOutboundCommand {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.join_worker();
    }
}

/// Run the agent to completion and return the process exit code.
pub fn run(config: Config) -> ExitCode {
    let capabilities = Capabilities::for_agent(config.mode, config::AGENT_VERSION);
    match config.mode {
        Mode::Temporary => run_temporary(&config, capabilities),
        Mode::Persistent if config.outbound() => run_outbound(&config, capabilities),
        Mode::Persistent => run_persistent(&config, capabilities),
    }
}

/// The human-readable line that reports version and mode at startup. The same
/// facts are also on the wire in the `hello` event.
fn banner(config: &Config) {
    eprintln!(
        "{} {} (protocol {}) starting in {} mode [root: {}]",
        config::AGENT_NAME,
        config::AGENT_VERSION,
        protocol::PROTOCOL_VERSION,
        config.mode,
        config.root.display(),
    );
}

fn run_temporary(config: &Config, capabilities: Capabilities) -> ExitCode {
    banner(config);
    let mut session = Session::new(config, capabilities);
    // SAA-299: as a deployed helper, take the single-use token (deleting its
    // file) and arm the expiry watchdog before speaking on the channel.
    let authenticated = Arc::new(AtomicBool::new(false));
    if let Some(path) = config.helper_token_file.as_deref() {
        match helper::take_token(path) {
            Ok(token) => session = session.requiring_token(&token),
            Err(error) => {
                eprintln!("{}: helper token unavailable: {error}", config::AGENT_NAME);
                return finish_helper(config, ExitCode::from(3));
            }
        }
        session.authenticated = Some(Arc::clone(&authenticated));
        let ttl = Duration::from_secs(config.helper_ttl_secs);
        let watchdog_config = config.clone();
        let flag = Arc::clone(&authenticated);
        thread::spawn(move || {
            thread::sleep(ttl);
            if !flag.load(Ordering::SeqCst) {
                eprintln!("{}: helper token expired before use; exiting", config::AGENT_NAME);
                let code = finish_helper(&watchdog_config, ExitCode::from(3));
                std::process::exit(if code == ExitCode::SUCCESS { 0 } else { 3 });
            }
        });
    }
    let mut transport = transport::stdio();
    if let Err(error) = session.greet(&mut transport) {
        eprintln!("{}: handshake failed: {error}", config::AGENT_NAME);
        return finish_helper(config, ExitCode::from(1));
    }
    let code = match session.serve(&mut transport) {
        Ok(Outcome::Disconnected) if session.required_token.is_some() && !authenticated.load(Ordering::SeqCst) => {
            eprintln!("{}: helper session refused (missing or wrong token)", config::AGENT_NAME);
            ExitCode::from(3)
        }
        Ok(_) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}: {error}", config::AGENT_NAME);
            ExitCode::from(1)
        }
    };
    finish_helper(config, code)
}

/// A helper removes itself on every exit path; other temporary runs are untouched.
fn finish_helper(config: &Config, code: ExitCode) -> ExitCode {
    if !config.helper_cleanup {
        return code;
    }
    match helper::cleanup_current(config.helper_token_file.as_deref()) {
        Ok(helper::Cleanup::Removed) => eprintln!("{}: helper removed its binary and temporary directory", config::AGENT_NAME),
        Ok(helper::Cleanup::Scheduled) => eprintln!("{}: helper scheduled removal of its binary and temporary directory", config::AGENT_NAME),
        Ok(helper::Cleanup::Refused) => eprintln!("{}: not inside a {}* directory; nothing removed", config::AGENT_NAME, helper::HELPER_DIR_PREFIX),
        Err(error) => eprintln!("{}: helper cleanup incomplete: {error}", config::AGENT_NAME),
    }
    code
}

fn run_outbound(config: &Config, capabilities: Capabilities) -> ExitCode {
    banner(config);
    let server = match ServerUrl::parse(config.server.as_deref().unwrap_or("")) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("{}: {error}", config::AGENT_NAME);
            return ExitCode::from(2);
        }
    };
    let host_id = config.host_id.as_deref().unwrap_or("");
    eprintln!("{}: connecting outbound to {} as host {host_id}", config::AGENT_NAME, server.display());

    let mut delay = 1u64;
    loop {
        match connect_outbound(config, &server, capabilities.clone()) {
            Ok(Outcome::Shutdown) => return ExitCode::SUCCESS,
            Ok(Outcome::Disconnected) => {
                eprintln!("{}: disconnected; reconnecting in {delay}s", config::AGENT_NAME);
                delay = 1;
            }
            Ok(Outcome::Rejected(failure)) | Err(OutboundError::Fatal(failure)) => {
                match failure {
                    AuthFailure::Revoked => eprintln!("{}: rejected: credential revoked", config::AGENT_NAME),
                    AuthFailure::Unauthorized => eprintln!("{}: rejected: unauthorized", config::AGENT_NAME),
                }
                return ExitCode::from(1);
            }
            Err(OutboundError::Io(error)) => {
                eprintln!("{}: {error}; retrying in {delay}s", config::AGENT_NAME);
            }
        }
        thread::sleep(Duration::from_secs(delay));
        delay = (delay.saturating_mul(2)).min(15);
    }
}

enum OutboundError {
    Fatal(AuthFailure),
    Io(io::Error),
}

fn connect_outbound(config: &Config, server: &ServerUrl, capabilities: Capabilities) -> Result<Outcome, OutboundError> {
    let mut transport = websocket::connect(server, config.tls_ca.as_deref(), config.tls_insecure).map_err(OutboundError::Io)?;
    // Live watching is not wired to the outbound transport yet; don't advertise it there.
    let mut capabilities = capabilities;
    capabilities.files.watch = false;
    let mut session = Session::new(config, capabilities);
    if let (Some(host_id), Some(token)) = (config.host_id.clone(), config.token.clone()) {
        session.hello = session.hello.clone().with_registration(host_id, token);
    }
    session.greet_outbound(&mut transport).map_err(OutboundError::Io)?;
    match wait_authenticated(&mut transport) {
        Ok(()) => {
            eprintln!("{}: authenticated", config::AGENT_NAME);
            session.serve_outbound(&mut transport).map_err(OutboundError::Io)
        }
        Err(OutboundError::Io(error)) => Err(OutboundError::Io(error)),
        Err(other) => Err(other),
    }
}

/// A server-initiated rejection of a live session (close code 4003/4001,
/// surfaced by the transport as `{ok:false,error:{code}}` with no request id).
fn session_rejection(message: &Value) -> Option<AuthFailure> {
    if message.get("ok").and_then(Value::as_bool) != Some(false) || message.get("id").is_some() {
        return None;
    }
    match message.get("error").and_then(|error| error.get("code")).and_then(Value::as_str) {
        Some(code) if code == protocol::code::REVOKED => Some(AuthFailure::Revoked),
        Some("unauthorized") => Some(AuthFailure::Unauthorized),
        _ => None,
    }
}

fn wait_authenticated(transport: &mut Outbound) -> Result<(), OutboundError> {
    loop {
        match transport.next_message().map_err(OutboundError::Io)? {
            Incoming::Message(value) => {
                if value.get("event").and_then(Value::as_str) == Some(protocol::event::AUTHENTICATED) {
                    return Ok(());
                }
                if value.get("ok").and_then(Value::as_bool) == Some(false) {
                    let code = value
                        .get("error")
                        .and_then(|error| error.get("code"))
                        .and_then(Value::as_str)
                        .unwrap_or("unauthorized");
                    return Err(match code {
                        protocol::code::REVOKED => OutboundError::Fatal(AuthFailure::Revoked),
                        _ => OutboundError::Fatal(AuthFailure::Unauthorized),
                    });
                }
            }
            Incoming::Malformed(_) => continue,
            Incoming::Keepalive | Incoming::Timeout => continue,
            Incoming::Eof => return Err(OutboundError::Io(io::Error::new(io::ErrorKind::ConnectionAborted, "closed before authentication"))),
        }
    }
}

fn run_persistent(config: &Config, capabilities: Capabilities) -> ExitCode {
    banner(config);
    // SAA-298: loopback only, and a fresh per-start token in a user-private file.
    let address = match local_auth::require_loopback(&config.listen) {
        Ok(address) => address,
        Err(error) => {
            eprintln!("{}: {error}", config::AGENT_NAME);
            return ExitCode::from(2);
        }
    };
    let token_path = match config.local_token_file.clone().map(Ok).unwrap_or_else(local_auth::default_token_path) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{}: {error}", config::AGENT_NAME);
            return ExitCode::from(1);
        }
    };
    let token = match local_auth::generate_token() {
        Ok(token) => token,
        Err(error) => {
            eprintln!("{}: cannot generate the local access token: {error}", config::AGENT_NAME);
            return ExitCode::from(1);
        }
    };
    if let Err(error) = local_auth::write_token_file(&token_path, &token) {
        eprintln!("{}: cannot write the local access token to {}: {error}", config::AGENT_NAME, token_path.display());
        return ExitCode::from(1);
    }
    // Only the path is ever logged, never the token itself.
    eprintln!("{}: local access token written to {}", config::AGENT_NAME, token_path.display());
    let listener = match TcpListener::bind(address) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("{}: cannot bind {}: {error}", config::AGENT_NAME, config.listen);
            return ExitCode::from(1);
        }
    };
    let address = listener.local_addr().map(|address| address.to_string()).unwrap_or_else(|_| config.listen.clone());
    eprintln!("{}: listening on {address}", config::AGENT_NAME);

    serve_listener(&listener, config, &capabilities, &token)
}

/// Accept control connections until one asks the agent to shut down. Every
/// connection gets the `hello` handshake first, as the protocol requires
/// (SAA-327: persistent mode used to skip it). Every connection must then
/// present `token` in its first request, a `hello` (SAA-298).
fn serve_listener(listener: &TcpListener, config: &Config, capabilities: &Capabilities, token: &str) -> ExitCode {
    loop {
        let stream = match listener.accept() {
            Ok((stream, _peer)) => stream,
            Err(error) => {
                eprintln!("{}: accept failed: {error}", config::AGENT_NAME);
                return ExitCode::from(1);
            }
        };
        let mut transport = match transport::from_tcp(stream) {
            Ok(transport) => transport,
            Err(error) => {
                eprintln!("{}: cannot prepare connection: {error}", config::AGENT_NAME);
                continue;
            }
        };
        let session = Session::new(config, capabilities.clone()).requiring_token(token);
        if let Err(error) = session.greet(&mut transport) {
            eprintln!("{}: handshake failed: {error}", config::AGENT_NAME);
            continue;
        }
        match session.serve(&mut transport) {
            Ok(Outcome::Shutdown) => return ExitCode::SUCCESS,
            Ok(Outcome::Disconnected) | Ok(Outcome::Rejected(_)) => continue,
            Err(error) => {
                eprintln!("{}: connection error: {error}", config::AGENT_NAME);
                continue;
            }
        }
    }
}

fn is_event(value: &Value) -> bool {
    value.get("event").and_then(Value::as_str).is_some() && value.get("op").is_none()
}

/// Per-connection state: everything a request handler needs, plus the handshake
/// the agent sends as soon as a connection is established.
struct Session<'a> {
    config: &'a Config,
    capabilities: Capabilities,
    hello: Hello,
    system: SystemInfo,
    /// Set on loopback-listener sessions: the first request must be a `hello`
    /// carrying this token (SAA-298). Never logged.
    required_token: Option<String>,
    /// Set once the token was accepted (the helper's expiry watchdog reads it).
    authenticated: Option<Arc<AtomicBool>>,
    /// Starts sound capture for `audio.start` (tests substitute a fake recorder).
    start_audio: fn() -> io::Result<audio::Capture>,
}

impl<'a> Session<'a> {
    fn new(config: &'a Config, capabilities: Capabilities) -> Session<'a> {
        let hello = Hello::current(config.mode, capabilities.clone());
        let system = SystemInfo::collect(config.mode);
        Session { config, capabilities, hello, system, required_token: None, authenticated: None, start_audio: audio::Capture::start }
    }

    fn requiring_token(mut self, token: &str) -> Session<'a> {
        self.required_token = Some(token.to_string());
        self
    }

    /// Whether `request` is a `hello` presenting the required token.
    fn presents_token(&self, request: &Request) -> bool {
        let Some(expected) = self.required_token.as_deref() else { return true };
        request.op == "hello"
            && request
                .params
                .get("token")
                .and_then(Value::as_str)
                .is_some_and(|presented| local_auth::tokens_match(expected, presented))
    }

    /// Send the unsolicited `hello` event — the machine-readable "version and
    /// mode" report required by SAA-294.
    fn greet<R: BufRead, W: Write>(&self, transport: &mut JsonLines<R, W>) -> io::Result<()> {
        transport.write_message(&self.hello.to_value())
    }

    fn greet_outbound(&self, transport: &mut Outbound) -> io::Result<()> {
        transport.write_message(&self.hello.to_value())
    }

    fn serve<R: BufRead, W: Write + Send + 'static>(&self, transport: &mut JsonLines<R, SharedWriter<W>>) -> io::Result<Outcome> {
        let mut watches = Watches::start(transport.writer().clone());
        let outcome = self.serve_loop(transport, &mut watches);
        // Unregister every OS watch and let queued events drain before returning,
        // whether the peer disconnected, asked to stop, or the stream failed.
        watches.close();
        outcome
    }

    fn serve_loop<R: BufRead, W: Write>(&self, transport: &mut JsonLines<R, W>, watches: &mut Watches) -> io::Result<Outcome> {
        let mut authorized = self.required_token.is_none();
        loop {
            let message = match transport.next_message()? {
                Incoming::Message(message) => message,
                Incoming::Malformed(reason) => {
                    let response = Response::failure(Value::Null, "bad_request", reason);
                    transport.write_message(&response.to_value())?;
                    continue;
                }
                Incoming::Keepalive | Incoming::Timeout => continue,
                Incoming::Eof => return Ok(Outcome::Disconnected),
            };
            if is_event(&message) && authorized {
                continue;
            }
            let request = match Request::from_value(message) {
                Ok(request) => request,
                Err(error) if authorized => {
                    let response = Response::failure(Value::Null, "bad_request", error.to_string());
                    transport.write_message(&response.to_value())?;
                    continue;
                }
                Err(_) => {
                    return self.refuse(transport, Value::Null);
                }
            };
            if !authorized {
                if !self.presents_token(&request) {
                    return self.refuse(transport, request.id.clone());
                }
                authorized = true;
                if let Some(flag) = &self.authenticated {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            let message = match ClientMessage::parse(&request) {
                Ok(message) => message,
                Err(error) => {
                    transport.write_message(&Response::failure(request.id.clone(), error.code(), error.to_string()).to_value())?;
                    continue;
                }
            };
            let stop = match message {
                ClientMessage::Shutdown => true,
                ClientMessage::ShutdownTemporary => self.config.mode == Mode::Temporary,
                _ => false,
            };
            if stop {
                let result = Value::object(vec![("stopping", Value::Bool(true))]);
                transport.write_message(&Response::success(request.id.clone(), result).to_value())?;
                return Ok(Outcome::Shutdown);
            }
            let id = request.id.clone();
            let response = match &message {
                ClientMessage::WatchDirectory { path } => watches.watch(id, &self.config.root, path),
                ClientMessage::UnwatchDirectory { watch_id } => watches.unwatch(id, *watch_id),
                other => self.handle(id, other),
            };
            transport.write_message(&response.to_value())?;
        }
    }

    /// Answer `unauthorized` and end the connection: a missing or wrong token
    /// gets exactly one reply and no further service.
    fn refuse<R: BufRead, W: Write>(&self, transport: &mut JsonLines<R, W>, id: Value) -> io::Result<Outcome> {
        let response = Response::failure(id, code::UNAUTHORIZED, "a hello with the local access token is required");
        transport.write_message(&response.to_value())?;
        Ok(Outcome::Disconnected)
    }

    fn serve_outbound(&self, transport: &mut Outbound) -> io::Result<Outcome> {
        self.serve_outbound_with(transport, execute_outbound_command)
    }

    fn serve_outbound_with(
        &self,
        transport: &mut Outbound,
        command_handler: fn(&Path, bool, Value, ClientMessage, commands::Cancellation) -> Response,
    ) -> io::Result<Outcome> {
        self.serve_outbound_with_observer(transport, command_handler, || {})
    }

    fn serve_outbound_with_observer<T: OutboundConnection>(
        &self,
        transport: &mut T,
        command_handler: fn(&Path, bool, Value, ClientMessage, commands::Cancellation) -> Response,
        before_queued_dequeue: fn(),
    ) -> io::Result<Outcome> {
        let mut pending_command: Option<PendingOutboundCommand> = None;
        let mut queued: VecDeque<Value> = VecDeque::new();
        let mut queued_bytes = 0usize;
        let mut completed_response: Option<Response> = None;
        // Sound capture for this connection (`audio.start`); dropped on stop or disconnect.
        let mut sound: Option<audio::Capture> = None;
        loop {
            // Send captured sound before anything else, so it never waits behind a slow read.
            if let Some(capture) = sound.as_ref() {
                let mut ended = None;
                while let Some(chunk) = capture.try_next() {
                    match chunk {
                        audio::Chunk::Data(pcm) => transport.write_message(&protocol::audio_event(&pcm))?,
                        audio::Chunk::End(reason) => {
                            ended = Some(reason);
                            break;
                        }
                    }
                }
                if let Some(reason) = ended {
                    sound = None;
                    transport.write_message(&protocol::audio_end_event(&reason))?;
                }
            }
            let command_result = if completed_response.is_none() {
                pending_command.as_ref().map(|command| command.receiver.try_recv())
            } else {
                None
            };
            if let Some(result) = command_result {
                match result {
                    Ok(response) => {
                        completed_response = Some(response);
                        continue;
                    }
                    Err(mpsc::TryRecvError::Disconnected) => return Err(io::Error::other("outbound command worker stopped without a response")),
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            }

            let message = if pending_command.is_none() {
                let inbound = if !queued.is_empty() {
                    before_queued_dequeue();
                    match transport.next_message_timeout(Duration::from_millis(1))? {
                        Incoming::Message(incoming) => {
                            if is_event(&incoming) {
                                continue;
                            }
                            if let Some(failure) = session_rejection(&incoming) {
                                return Ok(Outcome::Rejected(failure));
                            }
                            if incoming.get("op").and_then(Value::as_str)
                                == Some(protocol::op::EXEC_CANCEL)
                            {
                                Some(incoming)
                            } else {
                                let message_bytes = incoming.encode().len();
                                if queued.len() >= MAX_QUEUED_OUTBOUND_REQUESTS
                                    || queued_bytes.saturating_add(message_bytes)
                                        > MAX_QUEUED_OUTBOUND_BYTES
                                {
                                    let response = match Request::from_value(incoming) {
                                        Ok(request) => Response::failure(
                                            request.id,
                                            code::LIMIT_EXCEEDED,
                                            "outbound command request queue is full",
                                        ),
                                        Err(error) => Response::failure(
                                            Value::Null,
                                            code::BAD_REQUEST,
                                            error.to_string(),
                                        ),
                                    };
                                    transport.write_message(&response.to_value())?;
                                } else {
                                    queued_bytes += message_bytes;
                                    queued.push_back(incoming);
                                }
                                continue;
                            }
                        }
                        Incoming::Malformed(reason) => {
                            let response = Response::failure(Value::Null, "bad_request", reason);
                            transport.write_message(&response.to_value())?;
                            continue;
                        }
                        Incoming::Keepalive => continue,
                        Incoming::Timeout => None,
                        Incoming::Eof => return Ok(Outcome::Disconnected),
                    }
                } else {
                    None
                };
                if inbound.is_some() {
                    inbound
                } else {
                    queued.pop_front().map(|message| {
                        queued_bytes = queued_bytes.saturating_sub(message.encode().len());
                        message
                    })
                }
            } else {
                None
            };
            let message = if let Some(message) = message {
                message
            } else {
                let incoming = if sound.is_some() {
                    // Wake often enough to forward each 20 ms chunk promptly.
                    transport.next_message_timeout(AUDIO_POLL)?
                } else if pending_command.is_some() {
                    transport.next_message_timeout(Duration::from_millis(50))?
                } else {
                    transport.next_message()?
                };
                match incoming {
                    Incoming::Message(message) => message,
                    Incoming::Malformed(reason) => {
                        let response = Response::failure(Value::Null, "bad_request", reason);
                        transport.write_message(&response.to_value())?;
                        continue;
                    }
                    Incoming::Keepalive => continue,
                    Incoming::Timeout if completed_response.is_some() => {
                        let response = completed_response.take().expect("completed response is present");
                        if let Some(mut command) = pending_command.take() {
                            command.join_worker();
                        }
                        transport.write_message(&response.to_value())?;
                        continue;
                    }
                    Incoming::Timeout => continue,
                    Incoming::Eof => return Ok(Outcome::Disconnected),
                }
            };
            if is_event(&message) {
                continue;
            }
            if let Some(failure) = session_rejection(&message) {
                return Ok(Outcome::Rejected(failure));
            }
            if message.get("op").and_then(Value::as_str) == Some(protocol::op::EXEC_CANCEL) {
                let response = match Request::from_value(message) {
                    Ok(request) => match ClientMessage::parse(&request) {
                        Ok(ClientMessage::CancelRequest { request_id }) => {
                            let cancelled = pending_command
                                .as_ref()
                                .map(|command| {
                                    completed_response.is_none() && command.cancel(&request_id)
                                })
                                .unwrap_or(false)
                                || queued
                                    .iter()
                                    .position(|queued_message| {
                                        queued_message.get("id").and_then(Value::as_str)
                                            == Some(request_id.as_str())
                                    })
                                    .and_then(|index| queued.remove(index))
                                    .map(|queued_message| {
                                        queued_bytes = queued_bytes
                                            .saturating_sub(queued_message.encode().len());
                                        true
                                    })
                                    .unwrap_or(false);
                            Response::success(
                                request.id,
                                Value::object(vec![("cancelled", Value::Bool(cancelled))]),
                            )
                        }
                        Ok(_) => Response::failure(
                            request.id,
                            code::INVALID_PARAMS,
                            "invalid command cancellation",
                        ),
                        Err(error) => {
                            Response::failure(request.id, error.code(), error.to_string())
                        }
                    },
                    Err(error) => {
                        Response::failure(Value::Null, code::BAD_REQUEST, error.to_string())
                    }
                };
                transport.write_message(&response.to_value())?;
                continue;
            }
            if pending_command.is_some() {
                let message_bytes = message.encode().len();
                if queued.len() >= MAX_QUEUED_OUTBOUND_REQUESTS
                    || queued_bytes.saturating_add(message_bytes) > MAX_QUEUED_OUTBOUND_BYTES
                {
                    let response = match Request::from_value(message) {
                        Ok(request) => Response::failure(
                            request.id,
                            code::LIMIT_EXCEEDED,
                            "outbound command request queue is full",
                        ),
                        Err(error) => Response::failure(Value::Null, code::BAD_REQUEST, error.to_string()),
                    };
                    transport.write_message(&response.to_value())?;
                } else {
                    queued_bytes += message_bytes;
                    queued.push_back(message);
                }
                continue;
            }
            let request = match Request::from_value(message) {
                Ok(request) => request,
                Err(error) => {
                    let response = Response::failure(Value::Null, "bad_request", error.to_string());
                    transport.write_message(&response.to_value())?;
                    continue;
                }
            };
            let message = match ClientMessage::parse(&request) {
                Ok(message) => message,
                Err(error) => {
                    transport.write_message(&Response::failure(request.id.clone(), error.code(), error.to_string()).to_value())?;
                    continue;
                }
            };
            let stop = match &message {
                ClientMessage::Shutdown => true,
                ClientMessage::ShutdownTemporary => self.config.mode == Mode::Temporary,
                _ => false,
            };
            if stop {
                let result = Value::object(vec![("stopping", Value::Bool(true))]);
                transport.write_message(&Response::success(request.id.clone(), result).to_value())?;
                return Ok(Outcome::Shutdown);
            }
            if matches!(&message, ClientMessage::RunCommand { .. }) {
                let root = self.config.root.clone();
                let enabled = self.capabilities.commands.exec;
                let id = request.id.clone();
                let handler = command_handler;
                let cancellation = commands::Cancellation::new();
                let worker_cancellation = cancellation.clone();
                let request_id = request.id;
                let (sender, receiver) = mpsc::sync_channel(1);
                let worker = thread::spawn(move || {
                    let response = handler(&root, enabled, id, message, worker_cancellation);
                    let _ = sender.send(response);
                });
                pending_command = Some(PendingOutboundCommand { request_id, cancellation, receiver, worker: Some(worker) });
                continue;
            }
            match &message {
                ClientMessage::AudioStart => {
                    sound = None; // a restart replaces any running recorder
                    let response = match (self.start_audio)() {
                        Ok(capture) => {
                            sound = Some(capture);
                            Response::success(request.id.clone(), Value::object(vec![("mimetype", Value::string(audio::MIMETYPE))]))
                        }
                        Err(error) => Response::failure(request.id.clone(), code::UNSUPPORTED, error.to_string()),
                    };
                    transport.write_message(&response.to_value())?;
                    continue;
                }
                ClientMessage::AudioStop => {
                    let stopped = sound.take().is_some();
                    transport.write_message(&Response::success(request.id.clone(), Value::object(vec![("stopped", Value::Bool(stopped))])).to_value())?;
                    continue;
                }
                _ => {}
            }
            let response = self.handle(request.id.clone(), &message);
            transport.write_message(&response.to_value())?;
        }
    }

    fn handle(&self, id: Value, message: &ClientMessage) -> Response {
        match message {
            ClientMessage::Hello { protocol: Some(peer) } if *peer != protocol::PROTOCOL_VERSION => Response::failure(
                id,
                code::PROTOCOL_MISMATCH,
                format!("peer speaks protocol {peer}, agent speaks {}", protocol::PROTOCOL_VERSION),
            ),
            ClientMessage::Hello { .. } => Response::success(id, protocol::authenticated(self.config.mode)),
            ClientMessage::Ping => Response::success(
                id,
                Value::object(vec![
                    ("pong", Value::Bool(true)),
                    ("mode", Value::string(self.config.mode.as_str())),
                ]),
            ),
            ClientMessage::Heartbeat => Response::success(id, Value::object(vec![("alive", Value::Bool(true))])),
            ClientMessage::Info => Response::success(id, self.system.to_value()),
            ClientMessage::Capabilities => Response::success(id, self.capabilities.to_value()),
            ClientMessage::ListDirectory { path, cursor, limit } => self.handle_list(id, path, cursor.as_deref(), *limit),
            ClientMessage::ReadFile { path } => match files::read_text(&self.config.root, path) {
                Ok(content) => Response::success(id, Value::object(vec![("content", Value::string(content))])),
                Err(error) => Response::failure(id, code::IO_ERROR, error.to_string()),
            },
            ClientMessage::WriteFile { path, content } => match files::write_text(&self.config.root, path, content) {
                Ok(()) => Response::success(id, Value::object(vec![("written", Value::Bool(true))])),
                Err(error) => Response::failure(id, code::IO_ERROR, error.to_string()),
            },
            ClientMessage::RunCommand { executable, args, stdin, timeout_ms } => {
                if !self.capabilities.commands.exec {
                    return Response::failure(id, code::UNSUPPORTED, "process-group command execution is not supported on this platform");
                }
                match commands::run(&self.config.root, executable, args, stdin.as_deref(), Duration::from_millis(*timeout_ms)) {
                    Ok(result) => Response::success(id, result),
                    Err(error) => Response::failure(id, code::IO_ERROR, error.to_string()),
                }
            },
            ClientMessage::CancelRequest { .. } => Response::success(id, Value::object(vec![("cancelled", Value::Bool(false))])),
            // Watches need a writer shared with the event thread. The stdio and TCP
            // transports provide one; the outbound WebSocket (SAA-296) does not yet,
            // so on that path the agent advertises files.watch = false and refuses.
            ClientMessage::WatchDirectory { .. } | ClientMessage::UnwatchDirectory { .. } => {
                Response::failure(id, code::UNSUPPORTED, "directory watching is not available over the outbound connection yet")
            }
            ClientMessage::ShutdownTemporary => {
                Response::failure(id, code::WRONG_MODE, "shutdownTemporary is only accepted by a temporary helper")
            }
            ClientMessage::ReservedDesktop { op } => {
                Response::failure(id, code::RESERVED, format!("\"{op}\" is reserved for future desktop signaling"))
            }
            // Sound streams over the registered outbound connection only (handled there).
            ClientMessage::AudioStart | ClientMessage::AudioStop => {
                Response::failure(id, code::UNSUPPORTED, "sound streams only over the outbound connection to RemoteHub")
            }
            ClientMessage::Shutdown => unreachable!("handled by serve"),
        }
    }

    fn handle_list(&self, id: Value, requested: &str, cursor: Option<&str>, limit: usize) -> Response {
        let page = match files::list_dir_page_under_root(&self.config.root, requested, cursor, limit) {
            Ok(page) => page,
            Err(error) => return Response::failure(id, code::IO_ERROR, error.to_string()),
        };
        let mut page = page;
        let mut has_more = page.has_more;
        loop {
            let next_cursor = if has_more { page.entries.last().map(|entry| Value::string(entry.name.clone())).unwrap_or(Value::Null) } else { Value::Null };
            let entries = Value::Array(page.entries.iter().map(files::Entry::to_value).collect());
            let response = Response::success(id.clone(), Value::object(vec![
                ("entries", entries),
                ("hasMore", Value::Bool(has_more)),
                ("nextCursor", next_cursor),
            ]));
            if response.to_value().encode().len() <= MAX_LIST_RESPONSE_BYTES { return response; }
            if page.entries.pop().is_none() || page.entries.is_empty() {
                return Response::failure(id, code::LIMIT_EXCEEDED, "one directory entry exceeds the safe listing response size");
            }
            // If a byte budget shortened this page, the next page resumes after
            // the last returned name, so removed entries are returned next time.
            has_more = true;
        }
    }
}

fn execute_outbound_command(root: &Path, enabled: bool, id: Value, message: ClientMessage, cancellation: commands::Cancellation) -> Response {
    let ClientMessage::RunCommand { executable, args, stdin, timeout_ms } = message else {
        return Response::failure(id, code::UNSUPPORTED, "unsupported outbound command request");
    };
    if !enabled {
        return Response::failure(id, code::UNSUPPORTED, "process-group command execution is not supported on this platform");
    }
    match commands::run_cancellable(root, &executable, &args, stdin.as_deref(), Duration::from_millis(timeout_ms), &cancellation) {
        Ok(result) => Response::success(id, result),
        Err(error) => Response::failure(id, code::IO_ERROR, error.to_string()),
    }
}

/// Most watches one connection may hold at once.
pub const MAX_WATCHES_PER_CONNECTION: usize = 32;

/// Bound requests buffered while a Windows command is executing.
/// How often the outbound loop wakes to forward captured sound while capturing.
const AUDIO_POLL: Duration = Duration::from_millis(10);
const MAX_QUEUED_OUTBOUND_REQUESTS: usize = 64;
const MAX_QUEUED_OUTBOUND_BYTES: usize = 4 * 1024 * 1024;

/// Identical `modify` events for the same path closer together than this are
/// coalesced into one (editors and `write()` loops emit bursts).
pub const MODIFY_COALESCE: Duration = Duration::from_millis(50);

/// The live watches of one connection plus the thread that turns their changes
/// into `filesystemEvent` frames on the shared output stream.
struct Watches {
    next_id: u64,
    live: HashMap<u64, DirectoryWatch>,
    /// Ids whose events may still be delivered; cleared on unwatch so events
    /// already queued for a stopped watch are dropped, not sent late.
    active: Arc<Mutex<HashSet<u64>>>,
    sink: Option<Sender<Change>>,
    forwarder: Option<JoinHandle<()>>,
}

impl Watches {
    fn start<W: Write + Send + 'static>(writer: SharedWriter<W>) -> Watches {
        let (sink, changes) = mpsc::channel::<Change>();
        let active = Arc::new(Mutex::new(HashSet::new()));
        let forwarder_active = Arc::clone(&active);
        let forwarder = thread::spawn(move || forward(changes, writer, forwarder_active));
        Watches { next_id: 1, live: HashMap::new(), active, sink: Some(sink), forwarder: Some(forwarder) }
    }

    fn watch(&mut self, id: Value, root: &Path, requested: &str) -> Response {
        if self.live.len() >= MAX_WATCHES_PER_CONNECTION {
            return Response::failure(id, code::LIMIT_EXCEEDED, format!("at most {MAX_WATCHES_PER_CONNECTION} watches per connection"));
        }
        let Some(sink) = self.sink.clone() else {
            return Response::failure(id, code::IO_ERROR, "connection is closing");
        };
        let watch_id = self.next_id;
        // Mark active first so the very first change is not dropped.
        lock(&self.active).insert(watch_id);
        match DirectoryWatch::start(watch_id, root, requested, sink) {
            Ok(watch) => {
                self.next_id += 1;
                let path = watch.path().to_string_lossy().into_owned();
                self.live.insert(watch_id, watch);
                Response::success(
                    id,
                    Value::object(vec![("watchId", Value::Number(watch_id as f64)), ("path", Value::string(path))]),
                )
            }
            Err(error) => {
                lock(&self.active).remove(&watch_id);
                Response::failure(id, code::IO_ERROR, error.to_string())
            }
        }
    }

    fn unwatch(&mut self, id: Value, watch_id: u64) -> Response {
        match self.live.remove(&watch_id) {
            Some(watch) => {
                lock(&self.active).remove(&watch_id);
                watch.stop();
                Response::success(id, Value::object(vec![("watchId", Value::Number(watch_id as f64)), ("stopped", Value::Bool(true))]))
            }
            None => Response::failure(id, code::UNKNOWN_WATCH, format!("no watch {watch_id} on this connection")),
        }
    }

    /// Stop every watch, then let the forwarder drain and exit.
    fn close(&mut self) {
        lock(&self.active).clear();
        for (_, watch) in self.live.drain() {
            watch.stop();
        }
        self.sink = None;
        if let Some(forwarder) = self.forwarder.take() {
            let _ = forwarder.join();
        }
    }
}

impl Drop for Watches {
    fn drop(&mut self) {
        self.close();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn to_wire(change: &Change) -> FilesystemEvent {
    let kind = match change.kind {
        ChangeKind::Create => FsChange::Create,
        ChangeKind::Delete => FsChange::Delete,
        ChangeKind::Modify => FsChange::Modify,
        ChangeKind::Rename => FsChange::Rename,
        ChangeKind::Unavailable => FsChange::Unavailable,
    };
    FilesystemEvent {
        watch_id: change.watch_id,
        change: kind,
        path: change.path.to_string_lossy().into_owned(),
        from: change.from.as_ref().map(|from| from.to_string_lossy().into_owned()),
    }
}

/// Forward changes as `filesystemEvent` frames until every sender is gone.
fn forward<W: Write>(changes: Receiver<Change>, mut writer: SharedWriter<W>, active: Arc<Mutex<HashSet<u64>>>) {
    let mut last_modify: Option<(u64, PathBuf, Instant)> = None;
    for change in changes {
        if !lock(&active).contains(&change.watch_id) {
            continue;
        }
        if change.kind == ChangeKind::Modify {
            let now = Instant::now();
            if let Some((watch_id, path, at)) = &last_modify {
                if *watch_id == change.watch_id && *path == change.path && now.duration_since(*at) < MODIFY_COALESCE {
                    continue;
                }
            }
            last_modify = Some((change.watch_id, change.path.clone(), now));
        } else {
            last_modify = None;
        }
        if change.kind == ChangeKind::Unavailable {
            // The OS watch is gone; nothing more will come from this id.
            lock(&active).remove(&change.watch_id);
        }
        if writer.write_all(&transport::frame(&to_wire(&change).to_value())).and_then(|_| writer.flush()).is_err() {
            // The peer is gone; the request loop will see EOF and clean up.
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;
    use std::io::Cursor;

    static COMMAND_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static COMMAND_FINISHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static QUEUE_COMMAND_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static CANCEL_COMMAND_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static CANCEL_COMMAND_FINISHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static DISCONNECT_COMMAND_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static DISCONNECT_COMMAND_FINISHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static QUEUE_BLOCKER_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static QUEUED_COMMAND_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    static BOUNDARY_BLOCKER_STARTED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static BOUNDARY_ALLOW_BLOCKER_FINISH: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static BOUNDARY_DEQUEUE_PAUSED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static BOUNDARY_DEQUEUE_HOOK_USED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static BOUNDARY_DEQUEUE_RELEASE: Mutex<Option<Receiver<()>>> = Mutex::new(None);
    static BOUNDARY_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct ScriptedOutboundConnection {
        incoming: Receiver<Incoming>,
        outgoing: Sender<Value>,
        timeout_calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl OutboundConnection for ScriptedOutboundConnection {
        fn next_message(&mut self) -> io::Result<Incoming> {
            Ok(self.incoming.recv().unwrap_or(Incoming::Eof))
        }

        fn next_message_timeout(&mut self, timeout: Duration) -> io::Result<Incoming> {
            self.timeout_calls.fetch_add(1, Ordering::SeqCst);
            match self.incoming.recv_timeout(timeout) {
                Ok(message) => Ok(message),
                Err(mpsc::RecvTimeoutError::Timeout) => Ok(Incoming::Timeout),
                Err(mpsc::RecvTimeoutError::Disconnected) => Ok(Incoming::Eof),
            }
        }

        fn write_message(&mut self, value: &Value) -> io::Result<()> {
            self.outgoing.send(value.clone()).map_err(|_| io::Error::other("test response receiver stopped"))
        }
    }

    struct BoundaryDequeueRelease(Sender<()>);

    impl BoundaryDequeueRelease {
        fn new(sender: Sender<()>) -> Self {
            Self(sender)
        }
    }

    impl Drop for BoundaryDequeueRelease {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }

    struct ReleaseBoundaryCommandGates;

    impl Drop for ReleaseBoundaryCommandGates {
        fn drop(&mut self) {
            BOUNDARY_ALLOW_BLOCKER_FINISH.store(true, Ordering::SeqCst);
        }
    }

    fn boundary_blocking_command(_root: &Path, _enabled: bool, id: Value, _message: ClientMessage, _cancellation: commands::Cancellation) -> Response {
        BOUNDARY_BLOCKER_STARTED.store(true, Ordering::SeqCst);
        while !BOUNDARY_ALLOW_BLOCKER_FINISH.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(1));
        }
        Response::success(id, Value::object(vec![("done", Value::Bool(true))]))
    }

    fn pause_before_boundary_dequeue() {
        if !BOUNDARY_DEQUEUE_HOOK_USED.swap(true, Ordering::SeqCst) {
            BOUNDARY_DEQUEUE_PAUSED.store(true, Ordering::SeqCst);
            let release_receiver = lock(&BOUNDARY_DEQUEUE_RELEASE)
                .take()
                .expect("the boundary test installs its release channel");
            release_receiver
                .recv_timeout(Duration::from_secs(3))
                .expect("the boundary test releases the service");
        }
    }

    fn wait_for_test_flag(flag: &std::sync::atomic::AtomicBool, name: &str) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !flag.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(flag.load(Ordering::SeqCst), "timed out waiting for {name}");
    }

    fn send_scripted_request(sender: &Sender<Incoming>, raw: &str) {
        sender.send(Incoming::Message(json::decode(raw).unwrap())).unwrap();
    }

    fn receive_scripted_response(receiver: &Receiver<Value>) -> Value {
        receiver.recv_timeout(Duration::from_secs(3)).expect("agent response arrived")
    }


    fn slow_test_command(_root: &Path, _enabled: bool, id: Value, _message: ClientMessage, cancellation: commands::Cancellation) -> Response {
        COMMAND_STARTED.store(true, Ordering::SeqCst);
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(400) && !cancellation.is_cancelled() {
            thread::sleep(Duration::from_millis(5));
        }
        COMMAND_FINISHED.store(true, Ordering::SeqCst);
        Response::success(id, Value::object(vec![("done", Value::Bool(true))]))
    }

    fn cancellation_test_command(_root: &Path, _enabled: bool, id: Value, _message: ClientMessage, cancellation: commands::Cancellation) -> Response {
        match id.as_str() {
            Some("cancel-command") => CANCEL_COMMAND_STARTED.store(true, Ordering::SeqCst),
            Some("disconnect-command") => DISCONNECT_COMMAND_STARTED.store(true, Ordering::SeqCst),
            Some("queue-blocker") => QUEUE_BLOCKER_STARTED.store(true, Ordering::SeqCst),
            Some("queued-command") => QUEUED_COMMAND_STARTED.store(true, Ordering::SeqCst),
            _ => {}
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(400) && !cancellation.is_cancelled() {
            thread::sleep(Duration::from_millis(5));
        }
        match id.as_str() {
            Some("cancel-command") => CANCEL_COMMAND_FINISHED.store(true, Ordering::SeqCst),
            Some("disconnect-command") => DISCONNECT_COMMAND_FINISHED.store(true, Ordering::SeqCst),
            _ => {}
        }
        Response::success(id, Value::object(vec![("done", Value::Bool(true))]))
    }

    fn slow_queue_test_command(_root: &Path, _enabled: bool, id: Value, _message: ClientMessage, cancellation: commands::Cancellation) -> Response {
        QUEUE_COMMAND_STARTED.store(true, Ordering::SeqCst);
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(800) && !cancellation.is_cancelled() {
            thread::sleep(Duration::from_millis(5));
        }
        Response::success(id, Value::object(vec![("done", Value::Bool(true))]))
    }

    // A stand-in recorder: two 20 ms chunks of silence, then it keeps running until stopped.
    #[cfg(unix)]
    fn fake_running_audio() -> io::Result<audio::Capture> {
        audio::Capture::spawn(&audio::Recorder::new("sh", &["-c", "head -c 7680 /dev/zero; exec sleep 30"]), &[])
    }

    // A recorder that fails at once, like parec with no default sink.
    #[cfg(unix)]
    fn fake_failing_audio() -> io::Result<audio::Capture> {
        audio::Capture::spawn(&audio::Recorder::new("sh", &["-c", "echo 'Connection refused' >&2; exit 1"]), &[])
    }

    fn no_audio() -> io::Result<audio::Capture> {
        Err(io::Error::new(io::ErrorKind::NotFound, "no PipeWire or PulseAudio sound session is running for this user"))
    }

    fn serve_scripted(start_audio: fn() -> io::Result<audio::Capture>) -> (Sender<Incoming>, Receiver<Value>, JoinHandle<Outcome>) {
        let (incoming_sender, incoming_receiver) = mpsc::channel();
        let (outgoing_sender, outgoing_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let settings = Config::inbound(Mode::Persistent);
            let mut transport = ScriptedOutboundConnection {
                incoming: incoming_receiver,
                outgoing: outgoing_sender,
                timeout_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            };
            let mut session = Session::new(&settings, Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION));
            session.start_audio = start_audio;
            session.serve_outbound_with_observer(&mut transport, execute_outbound_command, || {}).unwrap()
        });
        (incoming_sender, outgoing_receiver, server)
    }

    fn next_matching(receiver: &Receiver<Value>, wanted: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(value) = receiver.recv_timeout(Duration::from_millis(50)) {
                if wanted(&value) { return value; }
            }
        }
        panic!("expected message did not arrive");
    }

    #[cfg(unix)]
    #[test]
    fn outbound_audio_streams_events_keeps_answering_and_stops_on_request() {
        let (to_agent, from_agent, server) = serve_scripted(fake_running_audio);
        send_scripted_request(&to_agent, r#"{"id":"a1","op":"audio.start"}"#);
        let started = next_matching(&from_agent, |v| v.get("id").and_then(Value::as_str) == Some("a1"));
        assert_eq!(started.get("ok"), Some(&Value::Bool(true)));
        assert_eq!(started.get("result").and_then(|r| r.get("mimetype")).and_then(Value::as_str), Some(audio::MIMETYPE));
        for _ in 0..2 {
            let event = next_matching(&from_agent, |v| v.get("event").and_then(Value::as_str) == Some("audio"));
            assert_eq!(event.get("data").and_then(Value::as_str).map(str::len), Some(5120), "20 ms of stereo s16 at 48 kHz, base64");
        }
        // Requests are still answered while sound is captured.
        send_scripted_request(&to_agent, r#"{"id":"p1","op":"ping"}"#);
        let pong = next_matching(&from_agent, |v| v.get("id").and_then(Value::as_str) == Some("p1"));
        assert_eq!(pong.get("ok"), Some(&Value::Bool(true)));
        send_scripted_request(&to_agent, r#"{"id":"a2","op":"audio.stop"}"#);
        let stopped = next_matching(&from_agent, |v| v.get("id").and_then(Value::as_str) == Some("a2"));
        assert_eq!(stopped.get("result").and_then(|r| r.get("stopped")), Some(&Value::Bool(true)));
        thread::sleep(Duration::from_millis(100));
        assert!(from_agent.try_iter().all(|v| v.get("event").and_then(Value::as_str) != Some("audio")), "no sound after audio.stop");
        to_agent.send(Incoming::Eof).unwrap();
        assert!(matches!(server.join().unwrap(), Outcome::Disconnected));
    }

    #[cfg(unix)]
    #[test]
    fn outbound_audio_reports_a_recorder_that_stops_on_its_own() {
        let (to_agent, from_agent, server) = serve_scripted(fake_failing_audio);
        send_scripted_request(&to_agent, r#"{"id":"a1","op":"audio.start"}"#);
        let end = next_matching(&from_agent, |v| v.get("event").and_then(Value::as_str) == Some("audioEnd"));
        assert_eq!(end.get("reason").and_then(Value::as_str), Some("sh stopped: Connection refused"));
        to_agent.send(Incoming::Eof).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn outbound_audio_start_explains_why_sound_is_unavailable() {
        let (to_agent, from_agent, server) = serve_scripted(no_audio);
        send_scripted_request(&to_agent, r#"{"id":"a1","op":"audio.start"}"#);
        let refused = next_matching(&from_agent, |v| v.get("id").and_then(Value::as_str) == Some("a1"));
        assert_eq!(refused.get("ok"), Some(&Value::Bool(false)));
        assert_eq!(refused.get("error").and_then(|e| e.get("code")).and_then(Value::as_str), Some("unsupported"));
        to_agent.send(Incoming::Eof).unwrap();
        server.join().unwrap();
    }

    fn send_test_ws_frame(stream: &mut std::net::TcpStream, opcode: u8, payload: &[u8]) {
        use std::io::Write;
        assert!(payload.len() < 126);
        let mut frame = vec![0x80 | opcode, payload.len() as u8];
        frame.extend_from_slice(payload);
        stream.write_all(&frame).unwrap();
        stream.flush().unwrap();
    }

    fn send_split_test_ws_frame(stream: &mut std::net::TcpStream, opcode: u8, payload: &[u8]) {
        use std::io::Write;
        assert!(payload.len() < 126);
        let mut frame = vec![0x80 | opcode, payload.len() as u8];
        frame.extend_from_slice(payload);
        stream.write_all(&frame[..6]).unwrap();
        stream.flush().unwrap();
        thread::sleep(Duration::from_millis(120));
        stream.write_all(&frame[6..]).unwrap();
        stream.flush().unwrap();
    }

    fn read_test_ws_frame(stream: &mut std::net::TcpStream) -> (u8, Vec<u8>) {
        use std::io::Read;
        let mut header = [0u8; 2];
        stream.read_exact(&mut header).unwrap();
        assert_eq!(header[1] & 0x80, 0x80, "agent client frames must be masked");
        let mut length = (header[1] & 0x7f) as usize;
        if length == 126 {
            let mut extended = [0u8; 2];
            stream.read_exact(&mut extended).unwrap();
            length = u16::from_be_bytes(extended) as usize;
        } else if length == 127 {
            let mut extended = [0u8; 8];
            stream.read_exact(&mut extended).unwrap();
            length = usize::try_from(u64::from_be_bytes(extended)).unwrap();
        }
        let mask = if header[1] & 0x80 != 0 {
            let mut mask = [0u8; 4];
            stream.read_exact(&mut mask).unwrap();
            Some(mask)
        } else {
            None
        };
        let mut payload = vec![0; length];
        stream.read_exact(&mut payload).unwrap();
        if let Some(mask) = mask {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }
        }
        (header[0] & 0x0f, payload)
    }

    #[test]
    fn outbound_command_does_not_block_websocket_ping_pong() {
        COMMAND_STARTED.store(false, Ordering::SeqCst);
        COMMAND_FINISHED.store(false, Ordering::SeqCst);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let settings = config(Mode::Persistent);
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut transport = Outbound::Plain(websocket::WsJson::new(stream));
            let capabilities = Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION);
            let session = Session::new(&settings, capabilities);
            session.serve_outbound_with(&mut transport, slow_test_command).unwrap()
        });

        let mut peer = std::net::TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"command-1","op":"exec.run","params":{"executable":"slow-test","args":[]}}"#);
        let started_by = Instant::now() + Duration::from_secs(2);
        while !COMMAND_STARTED.load(Ordering::SeqCst) && Instant::now() < started_by {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(COMMAND_STARTED.load(Ordering::SeqCst), "test command started");
        send_split_test_ws_frame(&mut peer, 0x9, b"heartbeat");

        let (opcode, pong) = read_test_ws_frame(&mut peer);
        assert_eq!(opcode, 0xA, "heartbeat receives a WebSocket Pong");
        assert_eq!(pong, b"heartbeat");
        assert!(!COMMAND_FINISHED.load(Ordering::SeqCst), "Pong arrives while the command is still running");

        let (opcode, response) = read_test_ws_frame(&mut peer);
        assert_eq!(opcode, 0x1);
        let response = json::decode(std::str::from_utf8(&response).unwrap()).unwrap();
        assert_eq!(response.get("id").and_then(Value::as_str), Some("command-1"));
        assert_eq!(response.get("result").and_then(|result| result.get("done")).and_then(Value::as_bool), Some(true));
        assert!(COMMAND_FINISHED.load(Ordering::SeqCst));

        send_test_ws_frame(&mut peer, 0x8, &[]);
        assert!(matches!(server.join().unwrap(), Outcome::Disconnected));
    }

    #[test]
    fn outbound_command_queue_is_bounded_and_shutdown_waits_for_the_command() {
        QUEUE_COMMAND_STARTED.store(false, Ordering::SeqCst);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let settings = config(Mode::Persistent);
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut transport = Outbound::Plain(websocket::WsJson::new(stream));
            let capabilities = Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION);
            let session = Session::new(&settings, capabilities);
            session.serve_outbound_with(&mut transport, slow_queue_test_command).unwrap()
        });

        let mut peer = std::net::TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"queue-command","op":"exec.run","params":{"executable":"slow-test","args":[]}}"#);
        let started_by = Instant::now() + Duration::from_secs(2);
        while !QUEUE_COMMAND_STARTED.load(Ordering::SeqCst) && Instant::now() < started_by {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(QUEUE_COMMAND_STARTED.load(Ordering::SeqCst), "test command started");

        for id in 0..MAX_QUEUED_OUTBOUND_REQUESTS - 1 {
            let request = format!("{{\"id\":{id},\"op\":\"ping\"}}");
            send_test_ws_frame(&mut peer, 0x1, request.as_bytes());
        }
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"shutdown","op":"shutdown"}"#);
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"overflow","op":"ping"}"#);

        let (_, overflow) = read_test_ws_frame(&mut peer);
        let overflow = json::decode(std::str::from_utf8(&overflow).unwrap()).unwrap();
        assert_eq!(overflow.get("id").and_then(Value::as_str), Some("overflow"));
        assert_eq!(error_code(&overflow), Some(code::LIMIT_EXCEEDED));

        let (_, command) = read_test_ws_frame(&mut peer);
        let command = json::decode(std::str::from_utf8(&command).unwrap()).unwrap();
        assert_eq!(command.get("id").and_then(Value::as_str), Some("queue-command"));
        for id in 0..MAX_QUEUED_OUTBOUND_REQUESTS - 1 {
            let (_, response) = read_test_ws_frame(&mut peer);
            let response = json::decode(std::str::from_utf8(&response).unwrap()).unwrap();
            assert_eq!(response.get("id").and_then(Value::as_i64), Some(id as i64));
        }
        let (_, shutdown) = read_test_ws_frame(&mut peer);
        let shutdown = json::decode(std::str::from_utf8(&shutdown).unwrap()).unwrap();
        assert_eq!(shutdown.get("id").and_then(Value::as_str), Some("shutdown"));
        assert_eq!(shutdown.get("result").and_then(|result| result.get("stopping")).and_then(Value::as_bool), Some(true));
        assert!(matches!(server.join().unwrap(), Outcome::Shutdown));
    }

    #[test]
    fn outbound_command_cancellation_stops_the_matching_worker() {
        CANCEL_COMMAND_STARTED.store(false, Ordering::SeqCst);
        CANCEL_COMMAND_FINISHED.store(false, Ordering::SeqCst);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let settings = config(Mode::Persistent);
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut transport = Outbound::Plain(websocket::WsJson::new(stream));
            let capabilities = Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION);
            let session = Session::new(&settings, capabilities);
            session.serve_outbound_with(&mut transport, cancellation_test_command).unwrap()
        });

        let mut peer = std::net::TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"cancel-command","op":"exec.run","params":{"executable":"slow-test","args":[]}}"#);
        let started_by = Instant::now() + Duration::from_secs(2);
        while !CANCEL_COMMAND_STARTED.load(Ordering::SeqCst) && Instant::now() < started_by {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(CANCEL_COMMAND_STARTED.load(Ordering::SeqCst), "test command started");
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"cancel-1","op":"exec.cancel","params":{"requestId":"cancel-command"}}"#);

        let (_, cancelled) = read_test_ws_frame(&mut peer);
        let cancelled = json::decode(std::str::from_utf8(&cancelled).unwrap()).unwrap();
        assert_eq!(cancelled.get("id").and_then(Value::as_str), Some("cancel-1"));
        assert_eq!(cancelled.get("result").and_then(|result| result.get("cancelled")).and_then(Value::as_bool), Some(true));

        let (_, command) = read_test_ws_frame(&mut peer);
        let command = json::decode(std::str::from_utf8(&command).unwrap()).unwrap();
        assert_eq!(command.get("id").and_then(Value::as_str), Some("cancel-command"));
        assert!(CANCEL_COMMAND_FINISHED.load(Ordering::SeqCst), "the cancelled worker is joined before its response is sent");

        send_test_ws_frame(&mut peer, 0x8, &[]);
        assert!(matches!(server.join().unwrap(), Outcome::Disconnected));
    }

    #[test]
    fn outbound_websocket_eof_cancels_and_joins_the_active_command_worker() {
        DISCONNECT_COMMAND_STARTED.store(false, Ordering::SeqCst);
        DISCONNECT_COMMAND_FINISHED.store(false, Ordering::SeqCst);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let settings = config(Mode::Persistent);
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut transport = Outbound::Plain(websocket::WsJson::new(stream));
            let capabilities = Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION);
            let session = Session::new(&settings, capabilities);
            session.serve_outbound_with(&mut transport, cancellation_test_command).unwrap()
        });

        let mut peer = std::net::TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"disconnect-command","op":"exec.run","params":{"executable":"slow-test","args":[]}}"#);
        let started_by = Instant::now() + Duration::from_secs(2);
        while !DISCONNECT_COMMAND_STARTED.load(Ordering::SeqCst) && Instant::now() < started_by {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(DISCONNECT_COMMAND_STARTED.load(Ordering::SeqCst), "test command started");
        drop(peer);

        assert!(matches!(server.join().unwrap(), Outcome::Disconnected));
        assert!(DISCONNECT_COMMAND_FINISHED.load(Ordering::SeqCst), "the connection does not return with an unjoined command worker");
    }

    #[test]
    fn outbound_command_cancellation_removes_a_queued_command_before_it_can_start() {
        QUEUE_BLOCKER_STARTED.store(false, Ordering::SeqCst);
        QUEUED_COMMAND_STARTED.store(false, Ordering::SeqCst);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let settings = config(Mode::Persistent);
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut transport = Outbound::Plain(websocket::WsJson::new(stream));
            let capabilities = Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION);
            let session = Session::new(&settings, capabilities);
            session.serve_outbound_with(&mut transport, cancellation_test_command).unwrap()
        });

        let mut peer = std::net::TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"queue-blocker","op":"exec.run","params":{"executable":"slow-test","args":[]}}"#);
        let started_by = Instant::now() + Duration::from_secs(2);
        while !QUEUE_BLOCKER_STARTED.load(Ordering::SeqCst) && Instant::now() < started_by {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(QUEUE_BLOCKER_STARTED.load(Ordering::SeqCst), "the blocking command started");
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"queued-command","op":"exec.run","params":{"executable":"must-not-run","args":[]}}"#);
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"cancel-queued","op":"exec.cancel","params":{"requestId":"queued-command"}}"#);
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"after-cancel","op":"ping"}"#);

        let (_, cancelled) = read_test_ws_frame(&mut peer);
        let cancelled = json::decode(std::str::from_utf8(&cancelled).unwrap()).unwrap();
        assert_eq!(cancelled.get("id").and_then(Value::as_str), Some("cancel-queued"));
        assert_eq!(cancelled.get("result").and_then(|result| result.get("cancelled")).and_then(Value::as_bool), Some(true));

        let (_, blocker) = read_test_ws_frame(&mut peer);
        let blocker = json::decode(std::str::from_utf8(&blocker).unwrap()).unwrap();
        assert_eq!(blocker.get("id").and_then(Value::as_str), Some("queue-blocker"));
        let (_, ping) = read_test_ws_frame(&mut peer);
        let ping = json::decode(std::str::from_utf8(&ping).unwrap()).unwrap();
        assert_eq!(ping.get("id").and_then(Value::as_str), Some("after-cancel"), "the cancelled queued command is removed before dispatch");
        assert!(!QUEUED_COMMAND_STARTED.load(Ordering::SeqCst));

        send_test_ws_frame(&mut peer, 0x8, &[]);
        assert!(matches!(server.join().unwrap(), Outcome::Disconnected));
    }

    #[test]
    fn outbound_request_cancellation_removes_only_the_matching_queued_file_write() {
        QUEUE_BLOCKER_STARTED.store(false, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("remotehub-lifecycle-cancel-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let settings = Config { listen: address.to_string(), root: root.clone(), ..Config::inbound(Mode::Persistent) };
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut transport = Outbound::Plain(websocket::WsJson::new(stream));
            let capabilities = Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION);
            let session = Session::new(&settings, capabilities);
            session.serve_outbound_with(&mut transport, cancellation_test_command).unwrap()
        });

        let mut peer = std::net::TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"queue-blocker","op":"exec.run","params":{"executable":"slow-test","args":[]}}"#);
        let started_by = Instant::now() + Duration::from_secs(2);
        while !QUEUE_BLOCKER_STARTED.load(Ordering::SeqCst) && Instant::now() < started_by {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(QUEUE_BLOCKER_STARTED.load(Ordering::SeqCst), "the blocking command started");

        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"revoked-write","op":"fs.write","params":{"path":"revoked.txt","content":"must not be written"}}"#);
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"unrelated-write","op":"fs.write","params":{"path":"unrelated.txt","content":"normal completion"}}"#);
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"cancel-revoked-write","op":"exec.cancel","params":{"requestId":"revoked-write"}}"#);
        send_test_ws_frame(&mut peer, 0x1, br#"{"id":"after-cancel","op":"ping"}"#);

        let (_, cancelled) = read_test_ws_frame(&mut peer);
        let cancelled = json::decode(std::str::from_utf8(&cancelled).unwrap()).unwrap();
        assert_eq!(cancelled.get("id").and_then(Value::as_str), Some("cancel-revoked-write"));
        assert_eq!(cancelled.get("result").and_then(|result| result.get("cancelled")).and_then(Value::as_bool), Some(true));

        let (_, blocker) = read_test_ws_frame(&mut peer);
        let blocker = json::decode(std::str::from_utf8(&blocker).unwrap()).unwrap();
        assert_eq!(blocker.get("id").and_then(Value::as_str), Some("queue-blocker"));
        let (_, written) = read_test_ws_frame(&mut peer);
        let written = json::decode(std::str::from_utf8(&written).unwrap()).unwrap();
        assert_eq!(written.get("id").and_then(Value::as_str), Some("unrelated-write"));
        assert_eq!(written.get("result").and_then(|result| result.get("written")).and_then(Value::as_bool), Some(true));
        let (_, ping) = read_test_ws_frame(&mut peer);
        let ping = json::decode(std::str::from_utf8(&ping).unwrap()).unwrap();
        assert_eq!(ping.get("id").and_then(Value::as_str), Some("after-cancel"));

        assert!(!root.join("revoked.txt").exists(), "the revoked queued write never starts");
        assert_eq!(std::fs::read_to_string(root.join("unrelated.txt")).unwrap(), "normal completion");
        send_test_ws_frame(&mut peer, 0x8, &[]);
        assert!(matches!(server.join().unwrap(), Outcome::Disconnected));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn boundary_release_guard_unblocks_service_when_dropped() {
        let _test_lock = lock(&BOUNDARY_TEST_LOCK);
        BOUNDARY_DEQUEUE_PAUSED.store(false, Ordering::SeqCst);
        BOUNDARY_DEQUEUE_HOOK_USED.store(false, Ordering::SeqCst);
        let (release_sender, release_receiver) = mpsc::channel();
        *lock(&BOUNDARY_DEQUEUE_RELEASE) = Some(release_receiver);
        let release = BoundaryDequeueRelease::new(release_sender);
        let service = thread::spawn(pause_before_boundary_dequeue);
        wait_for_test_flag(
            &BOUNDARY_DEQUEUE_PAUSED,
            "service paused before queued dequeue",
        );
        let early_failure = std::panic::catch_unwind(move || {
            let _release = release;
            panic!("simulated early test failure");
        });
        assert!(early_failure.is_err(), "the failure path unwound");
        service.join().expect("the service exits after release");
    }

    #[test]
    fn outbound_cancellation_at_command_completion_skips_only_the_matching_queued_write() {
        let _test_lock = lock(&BOUNDARY_TEST_LOCK);
        BOUNDARY_BLOCKER_STARTED.store(false, Ordering::SeqCst);
        BOUNDARY_ALLOW_BLOCKER_FINISH.store(false, Ordering::SeqCst);
        BOUNDARY_DEQUEUE_PAUSED.store(false, Ordering::SeqCst);
        BOUNDARY_DEQUEUE_HOOK_USED.store(false, Ordering::SeqCst);
        let _release_gates = ReleaseBoundaryCommandGates;
        let (dequeue_release_sender, dequeue_release_receiver) = mpsc::channel();
        *lock(&BOUNDARY_DEQUEUE_RELEASE) = Some(dequeue_release_receiver);
        let _release_dequeue = BoundaryDequeueRelease::new(dequeue_release_sender);
        let root = std::env::temp_dir().join(format!("remotehub-lifecycle-boundary-cancel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let settings = Config { root: root.clone(), ..Config::inbound(Mode::Persistent) };
        let (incoming_sender, incoming_receiver) = mpsc::channel();
        let (outgoing_sender, outgoing_receiver) = mpsc::channel();
        let timeout_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server_timeout_calls = Arc::clone(&timeout_calls);
        let server = thread::spawn(move || {
            let mut transport = ScriptedOutboundConnection {
                incoming: incoming_receiver,
                outgoing: outgoing_sender,
                timeout_calls: server_timeout_calls,
            };
            let capabilities = Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION);
            let session = Session::new(&settings, capabilities);
            session
                .serve_outbound_with_observer(
                    &mut transport,
                    boundary_blocking_command,
                    pause_before_boundary_dequeue,
                )
                .unwrap()
        });

        send_scripted_request(
            &incoming_sender,
            r#"{"id":"boundary-blocker","op":"exec.run","params":{"executable":"wait","args":[]}}"#,
        );
        wait_for_test_flag(&BOUNDARY_BLOCKER_STARTED, "blocking command start");
        send_scripted_request(
            &incoming_sender,
            r#"{"id":"revoked-write","op":"fs.write","params":{"path":"revoked.txt","content":"must not be written"}}"#,
        );
        send_scripted_request(
            &incoming_sender,
            r#"{"id":"unrelated-write","op":"fs.write","params":{"path":"unrelated.txt","content":"keep this write"}}"#,
        );

        let deadline = Instant::now() + Duration::from_secs(3);
        while timeout_calls.load(Ordering::SeqCst) < 3 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(
            timeout_calls.load(Ordering::SeqCst) >= 3,
            "both writes are queued before the blocker is released"
        );

        BOUNDARY_ALLOW_BLOCKER_FINISH.store(true, Ordering::SeqCst);
        wait_for_test_flag(
            &BOUNDARY_DEQUEUE_PAUSED,
            "service loop paused before queued dequeue after command completion",
        );
        let blocker = receive_scripted_response(&outgoing_receiver);
        assert_eq!(
            blocker.get("id").and_then(Value::as_str),
            Some("boundary-blocker")
        );
        send_scripted_request(
            &incoming_sender,
            r#"{"id":"cancel-revoked-write","op":"exec.cancel","params":{"requestId":"revoked-write"}}"#,
        );
        send_scripted_request(&incoming_sender, r#"{"id":"after-cancel","op":"ping"}"#);
        drop(_release_dequeue);
        BOUNDARY_DEQUEUE_PAUSED.store(false, Ordering::SeqCst);

        let cancelled = receive_scripted_response(&outgoing_receiver);
        assert_eq!(cancelled.get("id").and_then(Value::as_str), Some("cancel-revoked-write"));
        assert_eq!(
            cancelled.get("result").and_then(|result| result.get("cancelled")).and_then(Value::as_bool),
            Some(true)
        );

        let written = receive_scripted_response(&outgoing_receiver);
        assert_eq!(written.get("id").and_then(Value::as_str), Some("unrelated-write"));
        assert_eq!(
            written.get("result").and_then(|result| result.get("written")).and_then(Value::as_bool),
            Some(true)
        );
        let ping = receive_scripted_response(&outgoing_receiver);
        assert_eq!(ping.get("id").and_then(Value::as_str), Some("after-cancel"));
        assert!(!root.join("revoked.txt").exists(), "the cancelled queued write never starts");
        assert_eq!(std::fs::read_to_string(root.join("unrelated.txt")).unwrap(), "keep this write");

        incoming_sender.send(Incoming::Eof).unwrap();
        assert!(matches!(server.join().unwrap(), Outcome::Disconnected));
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn config(mode: Mode) -> Config {
        Config::inbound(mode)
    }

    #[test]
    fn large_directory_listing_pages_fit_frames_and_continue_until_all_entries_are_returned() {
        let root = std::env::temp_dir().join(format!("remotehub-agent-large-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        for index in 0..2_000 {
            let name = format!("entry-{index:05}-{}", "x".repeat(230));
            std::fs::write(root.join(name), b"x").unwrap();
        }

        let settings = Config { root: root.clone(), ..config(Mode::Persistent) };
        let session = Session::new(&settings, Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION));
        let mut cursor = None;
        let mut names = Vec::new();
        let mut pages = 0;
        loop {
            let cursor_param = cursor.as_ref().map(|value: &String| format!(",\"cursor\":\"{value}\"")).unwrap_or_default();
            let raw = format!("{{\"id\":1,\"op\":\"fs.list\",\"params\":{{\"path\":\".\",\"limit\":100{cursor_param}}}}}");
            let request = Request::from_value(json::decode(&raw).unwrap()).unwrap();
            let message = ClientMessage::parse(&request).unwrap();
            let response = session.handle(Value::Number(1.0), &message);
            let value = response.to_value();
            let frame_bytes = value.encode().len();
            assert!(
                frame_bytes <= MAX_LIST_RESPONSE_BYTES,
                "directory response exceeded its bounded listing budget: {frame_bytes} bytes",
            );
            assert!(
                frame_bytes <= crate::websocket::MAX_OUTBOUND_FRAME_BYTES,
                "directory response must fit in the outbound frame, got {frame_bytes} bytes",
            );
            let result = value.get("result").unwrap();
            names.extend(
                result.get("entries").and_then(Value::as_array).unwrap().iter()
                    .map(|entry| entry.get("name").and_then(Value::as_str).unwrap().to_string()),
            );
            pages += 1;
            cursor = result.get("nextCursor").and_then(Value::as_str).map(str::to_string);
            if cursor.is_none() { break; }
            assert_eq!(result.get("hasMore").and_then(Value::as_bool), Some(true));
            assert!(pages < 100, "pagination must make bounded progress");
        }
        assert_eq!(pages, 20);
        assert_eq!(names.len(), 2_000);
        assert!(names.windows(2).all(|pair| pair[0] < pair[1]));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn live_session_rejection_is_recognised_only_without_a_request_id() {
        let revoked = json::decode(r#"{"ok":false,"error":{"code":"revoked","message":"revoked"}}"#).unwrap();
        assert!(matches!(session_rejection(&revoked), Some(AuthFailure::Revoked)));
        let unauthorized = json::decode(r#"{"ok":false,"error":{"code":"unauthorized","message":"x"}}"#).unwrap();
        assert!(matches!(session_rejection(&unauthorized), Some(AuthFailure::Unauthorized)));
        let reply = json::decode(r#"{"id":1,"ok":false,"error":{"code":"revoked","message":"x"}}"#).unwrap();
        assert!(session_rejection(&reply).is_none());
        let request = json::decode(r#"{"id":2,"op":"ping"}"#).unwrap();
        assert!(session_rejection(&request).is_none());
    }

    /// Drive a `Session` over an in-memory transcript and return everything written.
    fn transcript(mode: Mode, lines: &str) -> String {
        let settings = config(mode);
        let session = Session::new(&settings, Capabilities::for_agent(mode, config::AGENT_VERSION));
        let input = Cursor::new(lines.as_bytes().to_vec());
        let output = SharedWriter::new(Cursor::new(Vec::new()));
        let mut transport = JsonLines::new(input, output);
        session.greet(&mut transport).unwrap();
        let _ = session.serve(&mut transport).unwrap();
        let written = transport.writer().lock().get_ref().clone();
        String::from_utf8(written).unwrap()
    }

    #[test]
    fn temporary_session_greets_then_answers_requests() {
        let output = transcript(Mode::Temporary, "{\"id\":1,\"op\":\"info\"}\n{\"op\":\"capabilities\"}\n");
        let lines: Vec<&str> = output.lines().collect();

        let hello = json::decode(lines[0]).unwrap();
        assert_eq!(hello.get("event").and_then(Value::as_str), Some("hello"));
        assert_eq!(hello.get("mode").and_then(Value::as_str), Some("temporary"));

        let info = json::decode(lines[1]).unwrap();
        assert_eq!(info.get("id").and_then(Value::as_i64), Some(1));
        assert_eq!(info.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(info.get("result").and_then(|result| result.get("agentVersion")).and_then(Value::as_str), Some(config::AGENT_VERSION));

        // The second request omits "id", so it is echoed back as null.
        let capabilities = json::decode(lines[2]).unwrap();
        assert_eq!(capabilities.get("id"), Some(&Value::Null));
        assert_eq!(capabilities.get("result").and_then(|result| result.get("agent")).and_then(|agent| agent.get("mode")).and_then(Value::as_str), Some("temporary"));
    }

    #[test]
    fn unknown_operations_and_bad_frames_report_errors_and_keep_going() {
        let output = transcript(Mode::Temporary, "{\"id\":1,\"op\":\"nope\"}\nnot json\n{\"id\":2,\"op\":\"ping\"}\n");
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines.len(), 4, "hello plus three responses");

        let unknown = json::decode(lines[1]).unwrap();
        assert_eq!(unknown.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(unknown.get("error").and_then(|error| error.get("code")).and_then(Value::as_str), Some("unknown_op"));

        let malformed = json::decode(lines[2]).unwrap();
        assert_eq!(malformed.get("error").and_then(|error| error.get("code")).and_then(Value::as_str), Some("bad_request"));

        let ping = json::decode(lines[3]).unwrap();
        assert_eq!(ping.get("id").and_then(Value::as_i64), Some(2));
        assert_eq!(ping.get("result").and_then(|result| result.get("pong")).and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn deeply_nested_frame_is_rejected_and_the_session_keeps_serving() {
        // SAA-325: a hostile deeply nested line must yield bad_request, not a crash.
        let input = format!("{}\n{{\"id\":2,\"op\":\"ping\"}}\n", "[".repeat(500_000));
        let output = transcript(Mode::Persistent, &input);
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines.len(), 3);
        let bad = json::decode(lines[1]).unwrap();
        assert_eq!(bad.get("error").and_then(|error| error.get("code")).and_then(Value::as_str), Some("bad_request"));
        let ping = json::decode(lines[2]).unwrap();
        assert_eq!(ping.get("id").and_then(Value::as_i64), Some(2));
    }

    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// Connect, read the agent's hello, send `first` lines, and collect every
    /// reply until the agent closes the connection or `max` replies arrive.
    fn listener_exchange(address: std::net::SocketAddr, first: &[String], max: usize) -> Vec<Value> {
        use std::io::{BufRead, BufReader, Write};
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(json::decode(line.trim()).unwrap().get("event").and_then(Value::as_str), Some("hello"));
        for request in first {
            stream.write_all(format!("{request}\n").as_bytes()).unwrap();
        }
        let mut replies = Vec::new();
        while replies.len() < max {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => replies.push(json::decode(line.trim()).unwrap()),
            }
        }
        replies
    }

    #[test]
    fn listener_rejects_missing_and_wrong_tokens_and_accepts_the_right_one() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let settings = config(Mode::Persistent);
        let server = std::thread::spawn(move || {
            let capabilities = Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION);
            serve_listener(&listener, &settings, &capabilities, TEST_TOKEN)
        });
        let hello = |token: Option<&str>| match token {
            Some(token) => format!("{{\"id\":1,\"op\":\"hello\",\"params\":{{\"protocol\":1,\"token\":\"{token}\"}}}}"),
            None => "{\"id\":1,\"op\":\"hello\",\"params\":{\"protocol\":1}}".to_string(),
        };
        let ping = "{\"id\":2,\"op\":\"ping\"}".to_string();

        // Missing token: one unauthorized reply, then the agent hangs up (the ping is never served).
        let missing = listener_exchange(address, &[hello(None), ping.clone()], 3);
        assert_eq!(missing.len(), 1, "connection closed after the refusal: {missing:?}");
        assert_eq!(error_code(&missing[0]), Some("unauthorized"));

        // Skipping hello entirely is also refused.
        let skipped = listener_exchange(address, &[ping.clone()], 3);
        assert_eq!(skipped.len(), 1);
        assert_eq!(error_code(&skipped[0]), Some("unauthorized"));

        // Wrong token (same length, last character differs; and a prefix).
        let mut wrong = TEST_TOKEN.to_string();
        wrong.replace_range(63.., "0");
        for bad in [wrong.as_str(), &TEST_TOKEN[..32], ""] {
            let replies = listener_exchange(address, &[hello(Some(bad)), ping.clone()], 3);
            assert_eq!(replies.len(), 1, "wrong token {bad:?} gets one reply");
            assert_eq!(error_code(&replies[0]), Some("unauthorized"));
        }
        // A refused connection cannot shut the agent down either.
        let refused_shutdown = listener_exchange(address, &["{\"id\":9,\"op\":\"shutdown\"}".to_string()], 3);
        assert_eq!(error_code(&refused_shutdown[0]), Some("unauthorized"));

        // Right token: authenticated, then normal service, then shutdown.
        let shutdown = "{\"id\":3,\"op\":\"shutdown\"}".to_string();
        let ok = listener_exchange(address, &[hello(Some(TEST_TOKEN)), ping, shutdown], 3);
        assert_eq!(ok.len(), 3);
        assert_eq!(ok[0].get("result").and_then(|r| r.get("event")).and_then(Value::as_str), Some("authenticated"), "{:?}", ok[0]);
        assert_eq!(ok[1].get("result").and_then(|r| r.get("pong")).and_then(Value::as_bool), Some(true));
        assert_eq!(ok[2].get("result").and_then(|r| r.get("stopping")).and_then(Value::as_bool), Some(true));
        assert_eq!(server.join().unwrap(), ExitCode::SUCCESS);
    }

    #[test]
    fn persistent_mode_sends_hello_on_every_tcp_connection() {
        // SAA-327: the persistent accept loop never sent the hello handshake.
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpStream;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let settings = config(Mode::Persistent);
        let server = std::thread::spawn(move || {
            let capabilities = Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION);
            serve_listener(&listener, &settings, &capabilities, TEST_TOKEN)
        });

        let read_hello = |reader: &mut BufReader<TcpStream>| {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let hello = json::decode(line.trim()).unwrap();
            assert_eq!(hello.get("event").and_then(Value::as_str), Some("hello"));
            assert_eq!(hello.get("version").and_then(Value::as_str), Some(config::AGENT_VERSION));
            assert_eq!(hello.get("mode").and_then(Value::as_str), Some("persistent"));
        };

        // First connection: greet, then disconnect; the agent must keep accepting.
        let first = TcpStream::connect(address).unwrap();
        read_hello(&mut BufReader::new(first.try_clone().unwrap()));
        drop(first);

        // Second connection also gets the greeting, then shuts the agent down.
        let mut second = TcpStream::connect(address).unwrap();
        let mut reader = BufReader::new(second.try_clone().unwrap());
        read_hello(&mut reader);
        second.write_all(format!("{{\"id\":0,\"op\":\"hello\",\"params\":{{\"token\":\"{TEST_TOKEN}\"}}}}\n").as_bytes()).unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(json::decode(line.trim()).unwrap().get("ok").and_then(Value::as_bool), Some(true));
        second.write_all(b"{\"id\":1,\"op\":\"shutdown\"}\n").unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(json::decode(line.trim()).unwrap().get("id").and_then(Value::as_i64), Some(1));
        assert_eq!(server.join().unwrap(), ExitCode::SUCCESS);
    }

    #[test]
    fn watch_limits_and_unknown_unwatch_are_refused() {
        let mut lines = String::new();
        for id in 0..=MAX_WATCHES_PER_CONNECTION {
            lines.push_str(&format!("{{\"id\":{id},\"op\":\"watchDirectory\",\"params\":{{\"path\":\".\"}}}}\n"));
        }
        lines.push_str("{\"id\":100,\"op\":\"unwatchDirectory\",\"params\":{\"watchId\":999}}\n");
        lines.push_str("{\"id\":101,\"op\":\"unwatchDirectory\",\"params\":{\"watchId\":1}}\n");
        lines.push_str("{\"id\":102,\"op\":\"unwatchDirectory\",\"params\":{\"watchId\":1}}\n");
        let out = responses(Mode::Temporary, &lines);
        let n = MAX_WATCHES_PER_CONNECTION;
        assert!(out[..n].iter().all(|r| r.get("ok").and_then(Value::as_bool) == Some(true)));
        assert_eq!(error_code(&out[n]), Some("limit_exceeded"));
        assert_eq!(error_code(&out[n + 1]), Some("unknown_watch"));
        assert_eq!(out[n + 2].get("result").and_then(|r| r.get("stopped")).and_then(Value::as_bool), Some(true));
        assert_eq!(error_code(&out[n + 3]), Some("unknown_watch"), "a watch can only be stopped once");
    }

    #[test]
    fn watch_requests_stream_filesystem_events_and_stop_on_unwatch() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpStream;

        let root = std::env::temp_dir().join(format!("remotehub-lifecycle-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("docs")).unwrap();
        let root = root.canonicalize().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let settings = Config { listen: address.to_string(), root: root.clone(), ..Config::inbound(Mode::Persistent) };
        let server = std::thread::spawn(move || {
            let capabilities = Capabilities::for_agent(Mode::Persistent, config::AGENT_VERSION);
            serve_listener(&listener, &settings, &capabilities, TEST_TOKEN)
        });

        let mut stream = TcpStream::connect(address).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut next = || {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            json::decode(line.trim()).unwrap()
        };
        let mut send = |line: &str| stream.write_all(format!("{line}\n").as_bytes()).unwrap();

        assert_eq!(next().get("event").and_then(Value::as_str), Some("hello"));
        send(&format!("{{\"id\":0,\"op\":\"hello\",\"params\":{{\"token\":\"{TEST_TOKEN}\"}}}}"));
        assert_eq!(next().get("ok").and_then(Value::as_bool), Some(true));
        send("{\"id\":1,\"op\":\"watchDirectory\",\"params\":{\"path\":\"docs\"}}");
        let watched = next();
        assert_eq!(watched.get("result").and_then(|r| r.get("watchId")).and_then(Value::as_i64), Some(1));

        let file = root.join("docs").join("new.txt");
        std::fs::write(&file, b"x").unwrap();
        // Wait for an event naming the new file (macOS may report it as create or modify).
        let event = loop {
            let value = next();
            if value.get("event").and_then(Value::as_str) == Some("filesystemEvent")
                && value.get("path").and_then(Value::as_str) == Some(file.to_str().unwrap())
            {
                break value;
            }
        };
        assert_eq!(event.get("event").and_then(Value::as_str), Some("filesystemEvent"));
        assert_eq!(event.get("watchId").and_then(Value::as_i64), Some(1));
        assert_eq!(event.get("path").and_then(Value::as_str), Some(file.to_str().unwrap()));

        // Escaping the root is refused.
        send("{\"id\":2,\"op\":\"watchDirectory\",\"params\":{\"path\":\"..\"}}");
        let refused = loop {
            let value = next();
            if value.get("id").and_then(Value::as_i64) == Some(2) {
                break value;
            }
        };
        assert_eq!(error_code(&refused), Some("io_error"));

        // After unwatch, a change produces no event: the next frame is the ping reply.
        send("{\"id\":3,\"op\":\"unwatchDirectory\",\"params\":{\"watchId\":1}}");
        let stopped = loop {
            let value = next();
            if value.get("id").and_then(Value::as_i64) == Some(3) {
                break value;
            }
        };
        assert_eq!(stopped.get("ok").and_then(Value::as_bool), Some(true));
        std::fs::write(root.join("docs").join("after.txt"), b"y").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        send("{\"id\":4,\"op\":\"ping\"}");
        assert_eq!(next().get("id").and_then(Value::as_i64), Some(4), "no filesystemEvent after unwatch");

        send("{\"id\":5,\"op\":\"shutdown\"}");
        assert_eq!(next().get("id").and_then(Value::as_i64), Some(5));
        assert_eq!(server.join().unwrap(), ExitCode::SUCCESS);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn large_request_ids_are_echoed_exactly() {
        // SAA-328: a 64-bit id must not be rounded in the response.
        let output = transcript(Mode::Temporary, "{\"id\":18446744073709551615,\"op\":\"ping\"}\n");
        let response = output.lines().nth(1).unwrap();
        assert!(response.starts_with("{\"id\":18446744073709551615,"), "{response}");
    }

    #[test]
    fn shutdown_stops_the_loop() {
        let output = transcript(Mode::Persistent, "{\"id\":9,\"op\":\"shutdown\"}\n{\"op\":\"ping\"}\n");
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines.len(), 2, "hello plus the shutdown acknowledgement, then the loop ends");
        let stop = json::decode(lines[1]).unwrap();
        assert_eq!(stop.get("result").and_then(|result| result.get("stopping")).and_then(Value::as_bool), Some(true));
    }

    fn responses(mode: Mode, lines: &str) -> Vec<Value> {
        transcript(mode, lines).lines().skip(1).map(|line| json::decode(line).unwrap()).collect()
    }

    fn error_code(value: &Value) -> Option<&str> {
        value.get("error").and_then(|error| error.get("code")).and_then(Value::as_str)
    }

    #[test]
    fn hello_negotiates_the_protocol_version() {
        let out = responses(Mode::Persistent, "{\"id\":1,\"op\":\"hello\",\"params\":{\"protocol\":1}}\n{\"id\":2,\"op\":\"hello\",\"params\":{\"protocol\":99}}\n");
        assert_eq!(out[0].get("result").and_then(|r| r.get("event")).and_then(Value::as_str), Some("authenticated"));
        assert_eq!(error_code(&out[1]), Some("protocol_mismatch"));
    }

    #[test]
    fn heartbeat_reserved_and_unwired_ops_answer_without_stopping() {
        let out = responses(
            Mode::Persistent,
            "{\"id\":1,\"op\":\"heartbeat\"}\n{\"id\":2,\"op\":\"desktopOffer\"}\n{\"id\":3,\"op\":\"watchDirectory\",\"params\":{\"path\":\".\"}}\n{\"id\":4,\"op\":\"shutdownTemporary\"}\n{\"id\":5,\"op\":\"ping\"}\n",
        );
        assert_eq!(out.len(), 5);
        assert_eq!(out[0].get("result").and_then(|r| r.get("alive")).and_then(Value::as_bool), Some(true));
        assert_eq!(error_code(&out[1]), Some("reserved"));
        assert_eq!(out[2].get("result").and_then(|r| r.get("watchId")).and_then(Value::as_i64), Some(1), "watching the root is allowed");
        assert_eq!(error_code(&out[3]), Some("wrong_mode"), "a persistent service ignores shutdownTemporary");
        assert_eq!(out[4].get("id").and_then(Value::as_i64), Some(5));
    }

    #[test]
    fn shutdown_temporary_stops_a_temporary_helper() {
        let out = responses(Mode::Temporary, "{\"id\":1,\"op\":\"shutdownTemporary\"}\n{\"op\":\"ping\"}\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].get("result").and_then(|r| r.get("stopping")).and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn invalid_params_keep_the_request_id() {
        let out = responses(Mode::Temporary, "{\"id\":8,\"op\":\"watchDirectory\",\"params\":{}}\n");
        assert_eq!(out[0].get("id").and_then(Value::as_i64), Some(8));
        assert_eq!(error_code(&out[0]), Some("invalid_params"));
    }
}
