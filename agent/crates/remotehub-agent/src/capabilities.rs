//! Versioned host capability model, mirrored from `server/capabilities.js` (SAA-285).
//!
//! The agent reports the same object shape the server persists for a host, so
//! discovery (SAA-300) can record it without translation:
//!
//! ```json
//! {
//!   "version": 1,
//!   "terminal": { "ssh": true },
//!   "files": { "sftp": true, "watch": false },
//!   "commands": { "exec": false },
//!   "desktop": { "nativeStream": false, "rdp": false, "vnc": false },
//!   "agent": { "available": false, "mode": null, "version": null }
//! }
//! ```
//!
//! The agent only *vouches* for the surfaces it provides. It sets `terminal.ssh`
//! and `files.sftp` to false because those are SSH-transport features it does not
//! serve; the server keeps its own SSH baseline. Discovery must therefore merge
//! this report into the host record rather than replace it. `agent.available` and
//! `files.watch` are the agent's authoritative claims.

use crate::config::Mode;
use crate::json::Value;

/// Must match `CAPABILITIES_VERSION` in `server/capabilities.js`.
pub const CAPABILITIES_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Terminal {
    pub ssh: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Files {
    pub sftp: bool,
    /// True only once the native watcher (SAA-297) is wired up.
    pub watch: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Desktop {
    pub native_stream: bool,
    pub rdp: bool,
    pub vnc: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commands {
    /// True only when the platform runner provides bounded process-tree cleanup.
    pub exec: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    pub available: bool,
    pub mode: Option<Mode>,
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub version: u32,
    pub terminal: Terminal,
    pub files: Files,
    pub commands: Commands,
    pub desktop: Desktop,
    pub agent: Agent,
}

impl Capabilities {
    /// The capabilities a freshly started agent declares. Live directory watching
    /// (SAA-297) is on; everything that needs a later milestone (desktop backends) stays off so the report never
    /// overstates what the host can do.
    pub fn for_agent(mode: Mode, version: &str) -> Capabilities {
        Capabilities {
            version: CAPABILITIES_VERSION,
            terminal: Terminal { ssh: false },
            files: Files { sftp: false, watch: true },
            commands: Commands { exec: crate::commands::SUPPORTED },
            desktop: Desktop { native_stream: false, rdp: false, vnc: false },
            agent: Agent { available: true, mode: Some(mode), version: Some(version.to_string()) },
        }
    }

    pub fn to_value(&self) -> Value {
        Value::object(vec![
            ("version", Value::Number(self.version as f64)),
            ("terminal", Value::object(vec![("ssh", Value::Bool(self.terminal.ssh))])),
            (
                "files",
                Value::object(vec![
                    ("sftp", Value::Bool(self.files.sftp)),
                    ("watch", Value::Bool(self.files.watch)),
                ]),
            ),
            (
                "commands",
                Value::object(vec![("exec", Value::Bool(self.commands.exec))]),
            ),
            (
                "desktop",
                Value::object(vec![
                    ("nativeStream", Value::Bool(self.desktop.native_stream)),
                    ("rdp", Value::Bool(self.desktop.rdp)),
                    ("vnc", Value::Bool(self.desktop.vnc)),
                ]),
            ),
            (
                "agent",
                Value::object(vec![
                    ("available", Value::Bool(self.agent.available)),
                    ("mode", self.agent.mode.map_or(Value::Null, |mode| Value::string(mode.as_str()))),
                    ("version", self.agent.version.clone().map_or(Value::Null, Value::string)),
                ]),
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_report_matches_the_server_shape() {
        let value = Capabilities::for_agent(Mode::Temporary, "0.1.0").to_value();
        let encoded = value.encode();
        assert_eq!(
            encoded,
            format!(
                r#"{{"agent":{{"available":true,"mode":"temporary","version":"0.1.0"}},"commands":{{"exec":{}}},"desktop":{{"nativeStream":false,"rdp":false,"vnc":false}},"files":{{"sftp":false,"watch":true}},"terminal":{{"ssh":false}},"version":1}}"#,
                crate::commands::SUPPORTED,
            )
        );
    }

    #[test]
    fn agent_reports_its_mode_and_version_but_not_unbuilt_surfaces() {
        let capabilities = Capabilities::for_agent(Mode::Persistent, "9.9.9");
        assert!(capabilities.agent.available);
        assert_eq!(capabilities.agent.mode, Some(Mode::Persistent));
        assert!(capabilities.files.watch, "the agent ships the SAA-297 native watcher");
        assert!(!capabilities.desktop.native_stream, "native streaming lands in SAA-307");
    }
}
