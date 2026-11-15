//! System information reported by the agent (SAA-294).
//!
//! Deliberately built from `std` only, so it works identically on the Windows,
//! macOS, and Linux targets without platform-specific crates or syscalls.

use std::env;
use std::thread;

use crate::config::{Mode, AGENT_VERSION};
use crate::json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemInfo {
    /// `std::env::consts::OS`, e.g. "windows", "macos", "linux".
    pub os: &'static str,
    /// `std::env::consts::FAMILY`, e.g. "windows", "unix".
    pub family: &'static str,
    pub arch: &'static str,
    pub hostname: Option<String>,
    pub cpus: usize,
    pub mode: Mode,
    pub version: &'static str,
}

impl SystemInfo {
    pub fn collect(mode: Mode) -> SystemInfo {
        SystemInfo {
            os: env::consts::OS,
            family: env::consts::FAMILY,
            arch: env::consts::ARCH,
            hostname: hostname(),
            cpus: thread::available_parallelism().map(|count| count.get()).unwrap_or(1),
            mode,
            version: AGENT_VERSION,
        }
    }

    pub fn to_value(&self) -> Value {
        Value::object(vec![
            ("os", Value::string(self.os)),
            ("family", Value::string(self.family)),
            ("arch", Value::string(self.arch)),
            ("hostname", self.hostname.clone().map_or(Value::Null, Value::string)),
            ("cpus", Value::Number(self.cpus as f64)),
            ("agentVersion", Value::string(self.version)),
            ("mode", Value::string(self.mode.as_str())),
        ])
    }
}

/// `std` has no hostname call, so read the environment variable each platform
/// already sets. Returns `None` when neither is present.
fn hostname() -> Option<String> {
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .copied()
        .find_map(|key| env::var(key).ok())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_host_and_the_agent_version() {
        let info = SystemInfo::collect(Mode::Persistent);
        assert!(!info.os.is_empty());
        assert!(!info.arch.is_empty());
        assert!(info.cpus >= 1);
        assert_eq!(info.version, AGENT_VERSION);

        let value = info.to_value();
        assert_eq!(value.get("mode").and_then(Value::as_str), Some("persistent"));
        assert_eq!(value.get("agentVersion").and_then(Value::as_str), Some(AGENT_VERSION));
        assert_eq!(value.get("cpus").and_then(Value::as_i64), Some(info.cpus as i64));
    }
}
