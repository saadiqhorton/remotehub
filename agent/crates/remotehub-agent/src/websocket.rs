//! Outbound WebSocket / TLS transport for persistent-agent registration (SAA-296).
//!
//! Framing is RFC 6455, implemented with `std` plus `ring` (masking keys, accept
//! hash). TLS is `rustls`. The SAA-295 control protocol is unchanged: each
//! WebSocket text frame is one JSON value.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use ring::digest::{digest, SHA1_FOR_LEGACY_USE_ONLY};
use ring::rand::{SecureRandom, SystemRandom};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, Error as TlsError, RootCertStore, SignatureScheme, StreamOwned};

use crate::json::{self, Value};
use crate::transport::Incoming;

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// Server-to-agent JSON may expand a 1 MiB control-character write to 6 MiB plus its envelope.
const MAX_INBOUND_FRAME_BYTES: usize = 7 * 1024 * 1024;
pub(crate) const MAX_OUTBOUND_FRAME_BYTES: usize = 1024 * 1024;
const DEFAULT_WS_PATH: &str = "/ws/agent";
const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(75);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerUrl {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    pub path: String,
}

impl ServerUrl {
    pub fn parse(raw: &str) -> io::Result<ServerUrl> {
        let raw = raw.trim();
        let (tls, rest) = if let Some(rest) = raw.strip_prefix("wss://") {
            (true, rest)
        } else if let Some(rest) = raw.strip_prefix("ws://") {
            (false, rest)
        } else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "server URL must start with ws:// or wss://"));
        };
        if rest.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "server URL is missing a host"));
        }
        let (authority, path) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, DEFAULT_WS_PATH),
        };
        let (host, port) = split_host_port(authority, if tls { 443 } else { 80 })?;
        let path = if path.is_empty() || path == "/" { DEFAULT_WS_PATH.to_string() } else { path.to_string() };
        Ok(ServerUrl { tls, host, port, path })
    }

    pub fn connect_addr(&self) -> String {
        if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    pub fn host_header(&self) -> String {
        let default = if self.tls { 443 } else { 80 };
        if self.port == default {
            self.host.clone()
        } else if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    pub fn display(&self) -> String {
        let scheme = if self.tls { "wss" } else { "ws" };
        format!("{}://{}{}", scheme, self.host_header(), self.path)
    }
}

fn split_host_port(authority: &str, default_port: u16) -> io::Result<(String, u16)> {
    if let Some(inner) = authority.strip_prefix('[').and_then(|value| value.split_once(']')) {
        let host = inner.0.to_string();
        let port = if inner.1.is_empty() {
            default_port
        } else if let Some(port) = inner.1.strip_prefix(':') {
            parse_port(port)?
        } else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid IPv6 authority"));
        };
        return Ok((host, port));
    }
    if let Some((host, port)) = authority.rsplit_once(':') {
        if !host.contains(':') {
            return Ok((host.to_string(), parse_port(port)?));
        }
    }
    Ok((authority.to_string(), default_port))
}

fn parse_port(value: &str) -> io::Result<u16> {
    value.parse::<u16>().map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid port"))
}

/// One JSON-message WebSocket over a byte stream (plain TCP or TLS).
pub struct WsJson<S: Read + Write> {
    stream: S,
    buffer: Vec<u8>,
}

impl<S: Read + Write> WsJson<S> {
    pub fn new(stream: S) -> WsJson<S> {
        WsJson { stream, buffer: Vec::with_capacity(1024) }
    }

    pub fn next_message(&mut self) -> io::Result<Incoming> {
        loop {
            if let Some(frame) = parse_buffered_frame(&mut self.buffer)? {
                match frame {
                WsFrame::Text(text) => {
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    return match json::decode(text) {
                        Ok(value) => Ok(Incoming::Message(value)),
                        Err(error) => Ok(Incoming::Malformed(error.to_string())),
                    };
                }
                WsFrame::Ping(payload) => {
                    write_frame(&mut self.stream, 0xA, &payload)?;
                    return Ok(Incoming::Keepalive);
                }
                WsFrame::Pong => continue,
                WsFrame::Close(code) => {
                    if code == 4003 {
                        return Ok(Incoming::Message(error_event("revoked")));
                    }
                    if code == 4001 {
                        return Ok(Incoming::Message(error_event("unauthorized")));
                    }
                    return Ok(Incoming::Eof);
                }
                }
            }
            let mut incoming = [0u8; 8192];
            match self.stream.read(&mut incoming) {
                Ok(0) => return Ok(Incoming::Eof),
                Ok(length) => self.buffer.extend_from_slice(&incoming[..length]),
                Err(error) if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) => {
                    return Ok(Incoming::Timeout);
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub fn write_message(&mut self, value: &Value) -> io::Result<()> {
        write_frame(&mut self.stream, 0x1, value.encode().as_bytes())
    }
}

#[derive(Debug)]
enum WsFrame {
    Text(String),
    Ping(Vec<u8>),
    Pong,
    Close(u16),
}

fn error_event(code: &str) -> Value {
    Value::object(vec![
        ("ok", Value::Bool(false)),
        (
            "error",
            Value::object(vec![("code", Value::string(code)), ("message", Value::string(code))]),
        ),
    ])
}

fn parse_buffered_frame(buffer: &mut Vec<u8>) -> io::Result<Option<WsFrame>> {
    if buffer.len() < 2 { return Ok(None); }
    let opcode = buffer[0] & 0x0F;
    let masked = buffer[1] & 0x80 != 0;
    if masked {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "server-to-client websocket frames must not be masked"));
    }
    let mut cursor = 2;
    let marker = (buffer[1] & 0x7F) as u64;
    let length = if marker == 126 {
        if buffer.len() < cursor + 2 { return Ok(None); }
        let length = u16::from_be_bytes([buffer[cursor], buffer[cursor + 1]]) as u64;
        cursor += 2;
        length
    } else if marker == 127 {
        if buffer.len() < cursor + 8 { return Ok(None); }
        let length = u64::from_be_bytes(buffer[cursor..cursor + 8].try_into().unwrap());
        cursor += 8;
        length
    } else {
        marker
    };
    if length > MAX_INBOUND_FRAME_BYTES as u64 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "websocket frame too large"));
    }
    let total = cursor.checked_add(length as usize)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "websocket frame length overflow"))?;
    if buffer.len() < total { return Ok(None); }
    let payload = buffer[cursor..total].to_vec();
    buffer.drain(..total);
    let frame = match opcode {
        0x1 => String::from_utf8(payload)
            .map(WsFrame::Text)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
        0x8 => {
            let code = if payload.len() >= 2 { u16::from_be_bytes([payload[0], payload[1]]) } else { 1005 };
            WsFrame::Close(code)
        }
        0x9 => WsFrame::Ping(payload),
        0xA => WsFrame::Pong,
        other => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("unsupported websocket opcode {other}"))),
    };
    Ok(Some(frame))
}

fn write_frame<S: Write>(stream: &mut S, opcode: u8, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_OUTBOUND_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "websocket frame too large"));
    }
    let mask = random_bytes(4)?;
    let mut header = Vec::with_capacity(14 + payload.len());
    header.push(0x80 | opcode);
    if payload.len() <= 125 {
        header.push(0x80 | payload.len() as u8);
    } else if payload.len() <= 65535 {
        header.push(0x80 | 126);
        header.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        header.push(0x80 | 127);
        header.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    header.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        header.push(byte ^ mask[index % 4]);
    }
    stream.write_all(&header)?;
    stream.flush()
}

pub fn websocket_accept(key: &str) -> String {
    let mut material = String::with_capacity(key.len() + WS_GUID.len());
    material.push_str(key);
    material.push_str(WS_GUID);
    b64_encode(digest(&SHA1_FOR_LEGACY_USE_ONLY, material.as_bytes()).as_ref())
}

fn random_bytes(len: usize) -> io::Result<Vec<u8>> {
    let mut bytes = vec![0u8; len];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| io::Error::other("could not read random bytes"))?;
    Ok(bytes)
}

fn b64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 63) as usize] as char);
        out.push(TABLE[((triple >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn b64_decode(data: &str) -> io::Result<Vec<u8>> {
    let cleaned: Vec<u8> = data.bytes().filter(|byte| !byte.is_ascii_whitespace() && *byte != b'=').collect();
    let mut out = Vec::new();
    for chunk in cleaned.chunks(4) {
        let mut values = [0u32; 4];
        for (index, byte) in chunk.iter().enumerate() {
            values[index] = match byte {
                b'A'..=b'Z' => (byte - b'A') as u32,
                b'a'..=b'z' => (byte - b'a' + 26) as u32,
                b'0'..=b'9' => (byte - b'0' + 52) as u32,
                b'+' => 62,
                b'/' => 63,
                _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid base64")),
            };
        }
        let triple = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
        out.push((triple >> 16) as u8);
        if chunk.len() > 2 {
            out.push((triple >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(triple as u8);
        }
    }
    Ok(out)
}

fn load_pem_certs(path: &Path) -> io::Result<Vec<CertificateDer<'static>>> {
    let text = std::fs::read_to_string(path)?;
    let mut certs = Vec::new();
    let mut current = String::new();
    let mut inside = false;
    for line in text.lines() {
        if line.contains("BEGIN CERTIFICATE") {
            inside = true;
            current.clear();
            continue;
        }
        if line.contains("END CERTIFICATE") {
            inside = false;
            certs.push(CertificateDer::from(b64_decode(&current)?));
            continue;
        }
        if inside {
            current.push_str(line.trim());
        }
    }
    if certs.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "no certificates in CA file"));
    }
    Ok(certs)
}

#[derive(Debug)]
struct InsecureVerifier;

impl ServerCertVerifier for InsecureVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn tls_config(ca: Option<&Path>, insecure: bool) -> io::Result<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(path) = ca {
        for cert in load_pem_certs(path)? {
            roots.add(cert).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        }
    }
    let provider = rustls::crypto::ring::default_provider();
    let builder = ClientConfig::builder_with_provider(provider.into())
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?;
    let mut config = builder.with_root_certificates(roots).with_no_client_auth();
    if insecure {
        config.dangerous().set_certificate_verifier(Arc::new(InsecureVerifier));
    }
    Ok(config)
}

fn handshake<S: Read + Write>(stream: &mut S, url: &ServerUrl) -> io::Result<()> {
    let key = b64_encode(&random_bytes(16)?);
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        url.path,
        url.host_header(),
        key
    );
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let mut raw = Vec::new();
    let mut byte = [0u8; 1];
    while !raw.windows(4).any(|window| window == b"\r\n\r\n") {
        if stream.read(&mut byte)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "server closed during websocket handshake"));
        }
        raw.push(byte[0]);
        if raw.len() > 16 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "websocket handshake response too large"));
        }
    }
    let text = String::from_utf8_lossy(&raw);
    let mut lines = text.split("\r\n");
    let status = lines.next().unwrap_or("");
    if !status.starts_with("HTTP/1.1 101") && !status.starts_with("HTTP/1.0 101") {
        return Err(io::Error::new(io::ErrorKind::ConnectionRefused, format!("websocket handshake failed: {status}")));
    }
    let expected = websocket_accept(&key);
    let accept = lines
        .find_map(|line| line.split_once(':').and_then(|(name, value)| {
            if name.eq_ignore_ascii_case("sec-websocket-accept") {
                Some(value.trim().to_string())
            } else {
                None
            }
        }))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing Sec-WebSocket-Accept"))?;
    if accept != expected {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid Sec-WebSocket-Accept"));
    }
    Ok(())
}

fn prepare_socket(stream: &TcpStream) -> io::Result<()> {
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(DEFAULT_READ_TIMEOUT))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    Ok(())
}

pub enum Outbound {
    Plain(WsJson<TcpStream>),
    Tls(Box<WsJson<StreamOwned<ClientConnection, TcpStream>>>),
}

impl Outbound {
    pub fn next_message(&mut self) -> io::Result<Incoming> {
        match self {
            Outbound::Plain(inner) => inner.next_message(),
            Outbound::Tls(inner) => inner.next_message(),
        }
    }

    pub fn write_message(&mut self, value: &Value) -> io::Result<()> {
        match self {
            Outbound::Plain(inner) => inner.write_message(value),
            Outbound::Tls(inner) => inner.write_message(value),
        }
    }

    /// Poll network activity while an off-thread command runs. Incomplete frame
    /// bytes remain buffered when a read timeout expires.
    pub fn next_message_timeout(&mut self, timeout: Duration) -> io::Result<Incoming> {
        self.set_read_timeout(Some(timeout))?;
        let result = self.next_message();
        let reset = self.set_read_timeout(Some(DEFAULT_READ_TIMEOUT));
        match (result, reset) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(message), Ok(())) => Ok(message),
        }
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        match self {
            Outbound::Plain(inner) => inner.stream.set_read_timeout(timeout),
            Outbound::Tls(inner) => inner.stream.sock.set_read_timeout(timeout),
        }
    }
}

pub fn connect(url: &ServerUrl, tls_ca: Option<&Path>, tls_insecure: bool) -> io::Result<Outbound> {
    let tcp = TcpStream::connect(url.connect_addr())?;
    prepare_socket(&tcp)?;
    if url.tls {
        let config = Arc::new(tls_config(tls_ca, tls_insecure)?);
        let name = ServerName::try_from(url.host.clone())
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        let conn = ClientConnection::new(config, name).map_err(io::Error::other)?;
        let mut tls = StreamOwned::new(conn, tcp);
        handshake(&mut tls, url)?;
        Ok(Outbound::Tls(Box::new(WsJson::new(tls))))
    } else {
        let mut stream = tcp;
        handshake(&mut stream, url)?;
        Ok(Outbound::Plain(WsJson::new(stream)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_ws_and_wss_urls() {
        let plain = ServerUrl::parse("ws://127.0.0.1:8090").unwrap();
        assert_eq!(plain, ServerUrl { tls: false, host: "127.0.0.1".into(), port: 8090, path: "/ws/agent".into() });
        assert_eq!(plain.display(), "ws://127.0.0.1:8090/ws/agent");

        let secure = ServerUrl::parse("wss://hub.example/custom").unwrap();
        assert!(secure.tls);
        assert_eq!(secure.port, 443);
        assert_eq!(secure.path, "/custom");
        assert_eq!(secure.display(), "wss://hub.example/custom");

        let v6 = ServerUrl::parse("ws://[::1]:9000/ws/agent").unwrap();
        assert_eq!(v6.host, "::1");
        assert_eq!(v6.connect_addr(), "[::1]:9000");
    }

    #[test]
    fn rfc6455_accept_key() {
        assert_eq!(websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn writes_and_reads_a_masked_text_frame_as_json() {
        let mut sink = Cursor::new(Vec::new());
        write_frame(&mut sink, 0x1, br#"{"event":"hello"}"#).unwrap();
        let encoded = sink.into_inner();
        assert_eq!(encoded[0], 0x81);
        assert_eq!(encoded[1] & 0x80, 0x80);

        // Server frames are unmasked; strip the client mask for the read-side test.
        let mut unmasked = vec![encoded[0], encoded[1] & 0x7F];
        let payload = &encoded[6..];
        let mask = &encoded[2..6];
        for (index, byte) in payload.iter().enumerate() {
            unmasked.push(byte ^ mask[index % 4]);
        }
        let split = unmasked.len() / 2;
        let mut buffered = unmasked[..split].to_vec();
        assert!(parse_buffered_frame(&mut buffered).unwrap().is_none(), "partial frame stays buffered");
        buffered.extend_from_slice(&unmasked[split..]);
        match parse_buffered_frame(&mut buffered).unwrap().unwrap() {
            WsFrame::Text(text) => assert_eq!(text, "{\"event\":\"hello\"}"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(buffered.is_empty());
    }

    #[test]
    fn accepts_and_parses_maximum_escaped_file_write_frame() {
        let content = "\\u0000".repeat(crate::files::MAX_WRITE_FILE);
        let json = format!(
            r#"{{"id":"remotehub-1","op":"fs.write","params":{{"path":"escaped.txt","content":"{content}"}}}}"#
        );
        assert!(
            json.len() > 1024 * 1024,
            "JSON escaping and the envelope exceed the former frame limit"
        );
        assert!(
            json.len() <= MAX_INBOUND_FRAME_BYTES,
            "the complete frame remains within the bounded transport limit"
        );

        let mut frame = Vec::with_capacity(10 + json.len());
        frame.extend_from_slice(&[0x81, 0x7f]);
        frame.extend_from_slice(&(json.len() as u64).to_be_bytes());
        frame.extend_from_slice(json.as_bytes());
        let mut buffered = frame;
        let text = match parse_buffered_frame(&mut buffered).unwrap().unwrap() {
            WsFrame::Text(text) => text,
            other => panic!("unexpected frame: {other:?}"),
        };
        assert!(buffered.is_empty());

        let value = crate::json::decode(&text).unwrap();
        let request = crate::protocol::Request::from_value(value).unwrap();
        assert_eq!(
            crate::protocol::ClientMessage::parse(&request).unwrap(),
            crate::protocol::ClientMessage::WriteFile {
                path: "escaped.txt".into(),
                content: "\0".repeat(crate::files::MAX_WRITE_FILE),
            }
        );
    }

    #[test]
    fn rejects_server_frames_over_the_inbound_limit() {
        let mut buffered = vec![0x81, 0x7f];
        buffered.extend_from_slice(&((MAX_INBOUND_FRAME_BYTES as u64) + 1).to_be_bytes());
        let error = parse_buffered_frame(&mut buffered).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_masked_server_frames() {
        let mut buffered = vec![0x89, 0x81, 1, 2, 3, 4, b'x'];
        let error = parse_buffered_frame(&mut buffered).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
