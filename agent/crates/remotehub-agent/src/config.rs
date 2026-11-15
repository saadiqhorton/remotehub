//! Configuration and command-line parsing for the agent (SAA-294 / SAA-296).
//!
//! Every setting can come from an environment variable or a flag; flags win.
//! Parsing is split from process I/O (`resolve` takes the args and an env lookup)
//! so it can be unit tested without touching the real environment.

use std::fmt;
use std::path::PathBuf;

/// Crate name and version, surfaced by `--version` and the protocol `hello` event.
pub const AGENT_NAME: &str = env!("CARGO_PKG_NAME");
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Default bind address for persistent mode. Loopback only: the inbound listener
/// is for local peers. Production persistent agents connect outbound instead.
/// How long a temporary helper waits for its authenticated `hello` (SAA-299).
pub const DEFAULT_HELPER_TTL_SECS: u64 = 60;

pub const DEFAULT_LISTEN: &str = "127.0.0.1:8377";

pub const USAGE: &str = "\
remotehub-agent — cross-platform RemoteHub agent

USAGE:
    remotehub-agent [OPTIONS]

OPTIONS:
    --mode <persistent|temporary>   Execution mode (default: persistent)
    --listen <ADDR>                 Persistent-mode bind address; must be 127.0.0.1 (default: 127.0.0.1:8377)
    --helper-token-file <PATH>      Temporary helper: single-use token file (read, then deleted)
    --helper-cleanup                Temporary helper: delete own binary and temp dir on exit
    --helper-ttl <SECS>             Temporary helper: exit if not authenticated in time (default 60)
    --local-token-file <PATH>       Where the listener writes its per-start token
                                    (default: ~/.remotehub/agent-local-token)
    --root <DIR>                    Directory the agent may read (default: .)
    --server <URL>                  Outbound control URL (ws:// or wss://)
    --host-id <ID>                  Saved host id to register as
    --token <TOKEN>                 Host-scoped agent credential
    --token-file <PATH>             Read the credential from a file
    --tls-ca <PATH>                 Extra CA certificate for wss://
    --insecure                      Skip TLS certificate verification (dev only)
    -h, --help                      Print this help and exit
    -V, --version                   Print the agent version and exit

SERVICE (run as the first argument; installs a per-user background service):
    install --server <URL> --host-id <ID> --token-file <PATH> [--dry-run]
                                    Copy this binary and token to the per-user
                                    install location and start it at logon
    uninstall                       Stop and remove what install created
    service-status                  Show the installed files and service state

ENVIRONMENT:
    REMOTEHUB_AGENT_MODE, REMOTEHUB_AGENT_LISTEN, REMOTEHUB_AGENT_ROOT
    REMOTEHUB_AGENT_SERVER, REMOTEHUB_AGENT_HOST_ID, REMOTEHUB_AGENT_TOKEN
    REMOTEHUB_AGENT_TOKEN_FILE, REMOTEHUB_AGENT_TLS_CA, REMOTEHUB_AGENT_TLS_INSECURE
    REMOTEHUB_AGENT_LOCAL_TOKEN_FILE
";

/// How the agent was launched. Both modes share one binary and one protocol;
/// they differ only in the transport they speak and how long they live.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Long-lived service: binds a TCP listener or connects outbound to RemoteHub.
    Persistent,
    /// Ephemeral helper: speaks the same protocol over stdin/stdout, then exits.
    Temporary,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Mode> {
        match value {
            "persistent" => Some(Mode::Persistent),
            "temporary" => Some(Mode::Temporary),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Persistent => "persistent",
            Mode::Temporary => "temporary",
        }
    }
}

impl fmt::Display for Mode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct Config {
    pub mode: Mode,
    pub listen: String,
    pub root: PathBuf,
    pub server: Option<String>,
    pub host_id: Option<String>,
    pub token: Option<String>,
    pub tls_ca: Option<PathBuf>,
    pub tls_insecure: bool,
    /// Where the inbound listener writes its per-start access token (SAA-298).
    /// `None` means the default, `~/.remotehub/agent-local-token`.
    pub local_token_file: Option<PathBuf>,
    /// Temporary helper (SAA-299): file holding the single-use session token.
    /// The helper reads it, deletes it, and requires it in the first `hello`.
    pub helper_token_file: Option<PathBuf>,
    /// Temporary helper: delete the helper binary and its temporary directory on exit.
    pub helper_cleanup: bool,
    /// Temporary helper: exit (and clean up) if not authenticated within this many seconds.
    pub helper_ttl_secs: u64,
}

impl Config {
    pub fn inbound(mode: Mode) -> Config {
        Config {
            mode,
            listen: DEFAULT_LISTEN.to_string(),
            root: PathBuf::from("."),
            server: None,
            host_id: None,
            token: None,
            tls_ca: None,
            tls_insecure: false,
            local_token_file: None,
            helper_token_file: None,
            helper_cleanup: false,
            helper_ttl_secs: DEFAULT_HELPER_TTL_SECS,
        }
    }

    pub fn outbound(&self) -> bool {
        self.mode == Mode::Persistent && self.server.is_some()
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Config")
            .field("mode", &self.mode)
            .field("listen", &self.listen)
            .field("root", &self.root)
            .field("server", &self.server)
            .field("host_id", &self.host_id)
            .field("token", &self.token.as_ref().map(|_| "[redacted]"))
            .field("tls_ca", &self.tls_ca)
            .field("tls_insecure", &self.tls_insecure)
            .field("local_token_file", &self.local_token_file)
            .field("helper_token_file", &self.helper_token_file)
            .field("helper_cleanup", &self.helper_cleanup)
            .field("helper_ttl_secs", &self.helper_ttl_secs)
            .finish()
    }
}

/// `remotehub-agent install` options (SAA-317). The credential is read from
/// `token_file`; it is never accepted on the command line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallOptions {
    pub server: String,
    pub host_id: String,
    pub token_file: PathBuf,
    /// Print the plan and change nothing.
    pub dry_run: bool,
}

/// The result of interpreting the command line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// Start the agent with this configuration.
    Run(Config),
    /// Install the per-user background service.
    Install(InstallOptions),
    /// Remove the per-user background service and its files.
    Uninstall,
    /// Report whether the per-user background service is installed and running.
    ServiceStatus,
    /// Print usage and exit successfully.
    Help,
    /// Print the version and exit successfully.
    Version,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError {
    message: String,
}

impl ConfigError {
    fn new(message: impl Into<String>) -> ConfigError {
        ConfigError { message: message.into() }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConfigError {}

/// Interpret `args` (without the program name) and `env` into a [`Command`].
pub fn resolve<I>(args: I, env: impl Fn(&str) -> Option<String>) -> Result<Command, ConfigError>
where
    I: IntoIterator<Item = String>,
{
    let args: Vec<String> = args.into_iter().collect();
    if let Some(command) = parse_subcommand(&args)? {
        return Ok(command);
    }
    let args = args.into_iter();

    // The env mode is only validated if no flag overrides it, so a bad
    // REMOTEHUB_AGENT_MODE never blocks --help, --version, or --mode (SAA-326).
    let mut mode: Option<Mode> = None;
    let mut listen = env("REMOTEHUB_AGENT_LISTEN").unwrap_or_else(|| DEFAULT_LISTEN.to_string());
    let mut root = env("REMOTEHUB_AGENT_ROOT").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let mut server = env("REMOTEHUB_AGENT_SERVER");
    let mut host_id = env("REMOTEHUB_AGENT_HOST_ID");
    let mut token = env("REMOTEHUB_AGENT_TOKEN");
    let mut token_file = env("REMOTEHUB_AGENT_TOKEN_FILE").map(PathBuf::from);
    let mut tls_ca = env("REMOTEHUB_AGENT_TLS_CA").map(PathBuf::from);
    let mut tls_insecure = truthy(env("REMOTEHUB_AGENT_TLS_INSECURE").as_deref());
    let mut local_token_file = env("REMOTEHUB_AGENT_LOCAL_TOKEN_FILE").map(PathBuf::from);
    let mut helper_token_file: Option<PathBuf> = None;
    let mut helper_cleanup = false;
    let mut helper_ttl_secs = DEFAULT_HELPER_TTL_SECS;

    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(Command::Help),
            "-V" | "--version" => return Ok(Command::Version),
            "--mode" => {
                let value = args.next().ok_or_else(|| ConfigError::new("--mode needs a value"))?;
                mode = Some(parse_mode(&value, "--mode")?);
            }
            "--listen" => {
                listen = args.next().ok_or_else(|| ConfigError::new("--listen needs a value"))?;
            }
            "--root" => {
                root = PathBuf::from(args.next().ok_or_else(|| ConfigError::new("--root needs a value"))?);
            }
            "--server" => {
                server = Some(args.next().ok_or_else(|| ConfigError::new("--server needs a value"))?);
            }
            "--host-id" => {
                host_id = Some(args.next().ok_or_else(|| ConfigError::new("--host-id needs a value"))?);
            }
            "--token" => {
                token = Some(args.next().ok_or_else(|| ConfigError::new("--token needs a value"))?);
            }
            "--local-token-file" => {
                local_token_file = Some(PathBuf::from(args.next().ok_or_else(|| ConfigError::new("--local-token-file needs a value"))?));
            }
            other if other.starts_with("--local-token-file=") => {
                local_token_file = Some(PathBuf::from(&other["--local-token-file=".len()..]));
            }
            "--token-file" => {
                token_file = Some(PathBuf::from(args.next().ok_or_else(|| ConfigError::new("--token-file needs a value"))?));
            }
            "--tls-ca" => {
                tls_ca = Some(PathBuf::from(args.next().ok_or_else(|| ConfigError::new("--tls-ca needs a value"))?));
            }
            "--insecure" => tls_insecure = true,
            "--helper-cleanup" => helper_cleanup = true,
            "--helper-token-file" => {
                helper_token_file = Some(PathBuf::from(args.next().ok_or_else(|| ConfigError::new("--helper-token-file needs a value"))?));
            }
            "--helper-ttl" => {
                let value = args.next().ok_or_else(|| ConfigError::new("--helper-ttl needs a value"))?;
                helper_ttl_secs = value
                    .parse::<u64>()
                    .ok()
                    .filter(|secs| (1..=3600).contains(secs))
                    .ok_or_else(|| ConfigError::new("--helper-ttl must be 1..=3600 seconds"))?;
            }
            other if other.starts_with("--mode=") => {
                mode = Some(parse_mode(&other["--mode=".len()..], "--mode")?);
            }
            other if other.starts_with("--listen=") => {
                listen = other["--listen=".len()..].to_string();
            }
            other if other.starts_with("--root=") => {
                root = PathBuf::from(&other["--root=".len()..]);
            }
            other if other.starts_with("--server=") => {
                server = Some(other["--server=".len()..].to_string());
            }
            other if other.starts_with("--host-id=") => {
                host_id = Some(other["--host-id=".len()..].to_string());
            }
            other if other.starts_with("--token=") => {
                token = Some(other["--token=".len()..].to_string());
            }
            other if other.starts_with("--token-file=") => {
                token_file = Some(PathBuf::from(&other["--token-file=".len()..]));
            }
            other if other.starts_with("--tls-ca=") => {
                tls_ca = Some(PathBuf::from(&other["--tls-ca=".len()..]));
            }
            other => return Err(ConfigError::new(format!("unrecognized argument \"{other}\""))),
        }
    }

    let mode = match mode {
        Some(mode) => mode,
        None => match env("REMOTEHUB_AGENT_MODE") {
            Some(value) => parse_mode(&value, "REMOTEHUB_AGENT_MODE")?,
            None => Mode::Persistent,
        },
    };

    if (helper_token_file.is_some() || helper_cleanup) && mode != Mode::Temporary {
        return Err(ConfigError::new("--helper-token-file and --helper-cleanup are only valid with --mode temporary"));
    }

    if let Some(path) = token_file {
        let contents = std::fs::read_to_string(&path)
            .map_err(|error| ConfigError::new(format!("cannot read {}: {error}", path.display())))?;
        token = Some(contents.trim().to_string());
    }

    if let Some(url) = server.as_ref() {
        if url.trim().is_empty() {
            return Err(ConfigError::new("--server must not be empty"));
        }
        if host_id.as_deref().unwrap_or("").trim().is_empty() {
            return Err(ConfigError::new("outbound mode needs --host-id (or REMOTEHUB_AGENT_HOST_ID)"));
        }
        if token.as_deref().unwrap_or("").trim().is_empty() {
            return Err(ConfigError::new("outbound mode needs --token, --token-file, or REMOTEHUB_AGENT_TOKEN"));
        }
    }

    Ok(Command::Run(Config {
        mode,
        listen,
        root,
        server: server.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
        host_id: host_id.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
        token: token.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
        tls_ca,
        tls_insecure,
        local_token_file,
        helper_token_file,
        helper_cleanup,
        helper_ttl_secs,
    }))
}

/// Service subcommands must be the first argument. Returns `None` for run mode.
fn parse_subcommand(args: &[String]) -> Result<Option<Command>, ConfigError> {
    let Some((name, rest)) = args.split_first() else {
        return Ok(None);
    };
    match name.as_str() {
        "install" => parse_install(rest).map(Some),
        "uninstall" => no_arguments("uninstall", rest, Command::Uninstall).map(Some),
        "service-status" => no_arguments("service-status", rest, Command::ServiceStatus).map(Some),
        _ => Ok(None),
    }
}

fn no_arguments(name: &str, rest: &[String], command: Command) -> Result<Command, ConfigError> {
    match rest.first().map(String::as_str) {
        None => Ok(command),
        Some("-h" | "--help") => Ok(Command::Help),
        Some(other) => Err(ConfigError::new(format!("{name} takes no arguments (got \"{other}\")"))),
    }
}

fn parse_install(rest: &[String]) -> Result<Command, ConfigError> {
    let mut server: Option<String> = None;
    let mut host_id: Option<String> = None;
    let mut token_file: Option<PathBuf> = None;
    let mut dry_run = false;
    let mut args = rest.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(Command::Help),
            "--dry-run" => dry_run = true,
            "--server" => server = Some(install_value(&mut args, "--server")?),
            "--host-id" => host_id = Some(install_value(&mut args, "--host-id")?),
            "--token-file" => token_file = Some(PathBuf::from(install_value(&mut args, "--token-file")?)),
            "--token" => return Err(token_flag_refused()),
            other if other.starts_with("--token=") => return Err(token_flag_refused()),
            other if other.starts_with("--server=") => server = Some(other["--server=".len()..].to_string()),
            other if other.starts_with("--host-id=") => host_id = Some(other["--host-id=".len()..].to_string()),
            other if other.starts_with("--token-file=") => {
                token_file = Some(PathBuf::from(&other["--token-file=".len()..]));
            }
            other => return Err(ConfigError::new(format!("install: unrecognized argument \"{other}\""))),
        }
    }
    let server = server.ok_or_else(|| ConfigError::new("install needs --server <URL>"))?;
    let host_id = host_id.ok_or_else(|| ConfigError::new("install needs --host-id <ID>"))?;
    let token_file = token_file.ok_or_else(|| ConfigError::new("install needs --token-file <PATH>"))?;
    Ok(Command::Install(InstallOptions { server, host_id, token_file, dry_run }))
}

fn install_value<'a>(args: &mut impl Iterator<Item = &'a String>, flag: &str) -> Result<String, ConfigError> {
    args.next()
        .cloned()
        .ok_or_else(|| ConfigError::new(format!("{flag} needs a value")))
}

fn token_flag_refused() -> ConfigError {
    ConfigError::new("install does not take --token: pass the credential with --token-file so it never appears on the command line")
}

fn parse_mode(value: &str, source: &str) -> Result<Mode, ConfigError> {
    Mode::parse(value).ok_or_else(|| ConfigError::new(format!("{source} must be \"persistent\" or \"temporary\" (got \"{value}\")")))
}

fn truthy(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true" | "TRUE" | "yes" | "on"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn defaults_to_persistent_on_the_loopback_address() {
        let command = resolve(args(&[]), no_env).unwrap();
        assert_eq!(command, Command::Run(Config::inbound(Mode::Persistent)));
    }

    #[test]
    fn accepts_both_flag_styles() {
        let command = resolve(args(&["--mode=temporary", "--listen", "127.0.0.1:9000", "--root=/tmp/x"]), no_env).unwrap();
        let mut expected = Config::inbound(Mode::Temporary);
        expected.listen = "127.0.0.1:9000".to_string();
        expected.root = PathBuf::from("/tmp/x");
        assert_eq!(command, Command::Run(expected));
    }

    #[test]
    fn flags_override_environment() {
        let command = resolve(args(&["--mode", "temporary"]), |key| {
            if key == "REMOTEHUB_AGENT_MODE" {
                Some("persistent".to_string())
            } else if key == "REMOTEHUB_AGENT_LISTEN" {
                Some("127.0.0.1:1".to_string())
            } else {
                None
            }
        })
        .unwrap();
        match command {
            Command::Run(config) => {
                assert_eq!(config.mode, Mode::Temporary);
                assert_eq!(config.listen, "127.0.0.1:1");
            }
            other => panic!("expected a run command, got {other:?}"),
        }
    }

    #[test]
    fn outbound_requires_host_and_token() {
        assert!(resolve(args(&["--server", "wss://hub.example"]), no_env).is_err());
        let command = resolve(
            args(&["--server=wss://hub.example", "--host-id", "abc", "--token", "rhag_1_secret"]),
            no_env,
        )
        .unwrap();
        match command {
            Command::Run(config) => {
                assert_eq!(config.server.as_deref(), Some("wss://hub.example"));
                assert_eq!(config.host_id.as_deref(), Some("abc"));
                assert_eq!(config.token.as_deref(), Some("rhag_1_secret"));
                assert!(config.outbound());
                let debug = format!("{config:?}");
                assert!(!debug.contains("rhag_1_secret"), "{debug}");
                assert!(debug.contains("[redacted]"), "{debug}");
            }
            other => panic!("expected a run command, got {other:?}"),
        }
    }

    #[test]
    fn rejects_bad_modes_and_unknown_arguments() {
        assert!(resolve(args(&["--mode", "ephemeral"]), no_env).is_err());
        assert!(resolve(args(&["--mode"]), no_env).is_err());
        assert!(resolve(args(&["--wat"]), no_env).is_err());
    }

    #[test]
    fn invalid_env_mode_does_not_block_help_version_or_mode_flags() {
        // SAA-326: a bad env mode used to fail before any flag was read.
        let bad_env = |key: &str| if key == "REMOTEHUB_AGENT_MODE" { Some("bogus".to_string()) } else { None };
        assert_eq!(resolve(args(&["--help"]), bad_env).unwrap(), Command::Help);
        assert_eq!(resolve(args(&["--version"]), bad_env).unwrap(), Command::Version);
        match resolve(args(&["--mode", "temporary"]), bad_env).unwrap() {
            Command::Run(config) => assert_eq!(config.mode, Mode::Temporary),
            other => panic!("expected a run command, got {other:?}"),
        }
        match resolve(args(&["--mode=persistent"]), bad_env).unwrap() {
            Command::Run(config) => assert_eq!(config.mode, Mode::Persistent),
            other => panic!("expected a run command, got {other:?}"),
        }
        // Still rejected when the env value is actually the one in use.
        let error = resolve(args(&[]), bad_env).unwrap_err();
        assert!(error.to_string().contains("REMOTEHUB_AGENT_MODE"), "{error}");
    }

    #[test]
    fn parses_install_with_and_without_dry_run() {
        let command = resolve(
            args(&["install", "--server", "wss://hub.example", "--host-id=abc", "--token-file", "/t/tok", "--dry-run"]),
            no_env,
        )
        .unwrap();
        assert_eq!(
            command,
            Command::Install(InstallOptions {
                server: "wss://hub.example".into(),
                host_id: "abc".into(),
                token_file: PathBuf::from("/t/tok"),
                dry_run: true,
            })
        );
        match resolve(args(&["install", "--server=ws://h", "--host-id", "x", "--token-file=/t"]), no_env).unwrap() {
            Command::Install(options) => assert!(!options.dry_run),
            other => panic!("expected install, got {other:?}"),
        }
    }

    #[test]
    fn install_requires_all_three_flags_and_refuses_a_token_flag() {
        assert!(resolve(args(&["install", "--host-id", "x", "--token-file", "/t"]), no_env).is_err());
        assert!(resolve(args(&["install", "--server", "wss://h", "--token-file", "/t"]), no_env).is_err());
        assert!(resolve(args(&["install", "--server", "wss://h", "--host-id", "x"]), no_env).is_err());
        let error = resolve(args(&["install", "--token", "secret"]), no_env).unwrap_err();
        assert!(error.to_string().contains("--token-file"), "{error}");
        assert!(!error.to_string().contains("secret"));
        assert!(resolve(args(&["install", "--server", "wss://h", "--host-id", "x", "--token-file", "/t", "--wat"]), no_env).is_err());
    }

    #[test]
    fn parses_uninstall_status_and_their_help() {
        assert_eq!(resolve(args(&["uninstall"]), no_env).unwrap(), Command::Uninstall);
        assert_eq!(resolve(args(&["service-status"]), no_env).unwrap(), Command::ServiceStatus);
        assert_eq!(resolve(args(&["uninstall", "--help"]), no_env).unwrap(), Command::Help);
        assert_eq!(resolve(args(&["install", "-h"]), no_env).unwrap(), Command::Help);
        assert!(resolve(args(&["uninstall", "--force"]), no_env).is_err());
        assert!(resolve(args(&["service-status", "extra"]), no_env).is_err());
    }

    #[test]
    fn subcommand_must_be_the_first_argument() {
        assert!(resolve(args(&["--mode", "persistent", "install"]), no_env).is_err());
    }

    #[test]
    fn recognizes_help_and_version() {
        assert_eq!(resolve(args(&["--help"]), no_env).unwrap(), Command::Help);
        assert_eq!(resolve(args(&["-V"]), no_env).unwrap(), Command::Version);
    }
}
