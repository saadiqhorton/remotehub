//! RemoteHub agent (SAA-294).
//!
//! A single cross-platform binary that runs either as a long-lived **persistent**
//! service or as an ephemeral **temporary** helper. Both modes share one codebase
//! and one newline-delimited JSON control protocol; only the transport and the
//! lifetime differ.
//!
//! Module map:
//!
//! * [`config`] — flags, environment, and mode selection.
//! * [`protocol`] — the versioned request/response envelope and handshake.
//! * [`transport`] — newline-delimited JSON over stdin/stdout or TCP.
//! * [`audio`] — system sound capture streamed to the Desktop surface.
//! * [`capabilities`] — the versioned host capability model (SAA-285).
//! * [`files`] — directory listing and root confinement for the Files surface.
//! * [`system`] — OS, architecture, hostname, and CPU information.
//! * [`lifecycle`] — startup, request loop, and shutdown for both modes.
//! * [`websocket`] — outbound `ws://` / `wss://` client for persistent registration.
//! * [`json`] — the small, dependency-free JSON codec the protocol uses.
//! * [`install`] — per-user background service: `install`, `uninstall`, `service-status` (SAA-317).
//!
//! See `agent/README.md` for build instructions, the protocol summary, and the
//! documented idle behaviour.

pub mod audio;
pub mod capabilities;
pub mod config;
pub mod commands;
pub mod files;
pub mod helper;
pub mod install;
pub mod json;
pub mod lifecycle;
pub mod local_auth;
pub mod protocol;
pub mod system;
pub mod transport;
pub mod watcher;
pub mod websocket;
