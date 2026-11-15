//! Per-user background service: `install`, `uninstall` and `service-status` (SAA-317).
//!
//! The agent runs as the signed-in user, never as a system service. The audio
//! layer records that user's desktop sound through their own session (their
//! `XDG_RUNTIME_DIR`, their launchd GUI session, their interactive logon), which
//! a system service cannot reach.
//!
//! * Linux: systemd *user* unit `~/.config/systemd/user/remotehub-agent.service`.
//! * macOS: LaunchAgent `~/Library/LaunchAgents/com.remotehub.agent.plist`.
//! * Windows: logon-triggered Scheduled Task `RemoteHub Agent`. A Windows Service
//!   runs in session 0 and cannot hear the user's sound, so it is not used.
//!
//! Every command first builds a [`Plan`] from plain inputs (platform, user
//! directories, executable path, server URL, host id). A plan is data: file
//! contents, file modes and ordered command lines. `--dry-run` renders the plan
//! and stops. Otherwise [`execute`] carries it out through a [`Runner`].
//!
//! The token is never part of a plan. At execution time it is copied from
//! `--token-file` into `agent.token` (mode 0600 on Unix), and the service reads
//! it back through `--token-file`, so it never appears in a unit file, plist,
//! scheduled-task argument or command line.

use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as Process, ExitCode};

use crate::config::InstallOptions;
use crate::websocket::ServerUrl;

/// systemd user unit name.
pub const SERVICE_UNIT: &str = "remotehub-agent.service";
/// launchd label, also the LaunchAgent file stem.
pub const LAUNCHD_LABEL: &str = "com.remotehub.agent";
/// Windows Scheduled Task name.
pub const TASK_NAME: &str = "RemoteHub Agent";
/// File that holds the host credential, next to the installed binary.
pub const TOKEN_FILE_NAME: &str = "agent.token";

const UNIX_BINARY_NAME: &str = "remotehub-agent";
const WINDOWS_BINARY_NAME: &str = "remotehub-agent.exe";
const MAX_HOST_ID_LEN: usize = 128;
const MAX_TOKEN_LEN: usize = 4096;
/// Characters allowed in `--server` beyond ASCII letters and digits. Anything
/// that could be read as a quote, a systemd specifier (`%`), a variable (`$`),
/// whitespace or a control character is refused, so the URL is safe in every
/// generated format.
const SERVER_URL_EXTRA: &[u8] = b"-._~:/?&=+@[]!,;()";
/// `schtasks /TR` rejects longer commands (Microsoft's schtasks reference).
const SCHTASKS_TR_MAX_LEN: usize = 261;
/// The uid placeholder used by `--dry-run`, so a dry run never runs `id -u`.
const UID_PLACEHOLDER: &str = "<uid>";

/// The operating systems that have a per-user service mechanism.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    MacOs,
    Windows,
}

impl Platform {
    /// The platform this binary was built for, if it has a service mechanism.
    pub fn current() -> Option<Platform> {
        if cfg!(target_os = "linux") {
            Some(Platform::Linux)
        } else if cfg!(target_os = "macos") {
            Some(Platform::MacOs)
        } else if cfg!(windows) {
            Some(Platform::Windows)
        } else {
            None
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Platform::Linux => "linux",
            Platform::MacOs => "macos",
            Platform::Windows => "windows",
        }
    }
}

/// The per-user directories a plan is rooted in. Passed in rather than read from
/// the process environment, so tests can point a plan at a temporary home.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct UserDirs {
    /// `$HOME` (Linux and macOS).
    pub home: Option<PathBuf>,
    /// `%LOCALAPPDATA%` (Windows).
    pub local_app_data: Option<PathBuf>,
}

impl UserDirs {
    pub fn from_env() -> UserDirs {
        UserDirs { home: non_empty_var("HOME"), local_app_data: non_empty_var("LOCALAPPDATA") }
    }
}

fn non_empty_var(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).filter(|value| !value.is_empty()).map(PathBuf::from)
}

/// Everything a plan depends on besides the install request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Context {
    pub platform: Platform,
    pub dirs: UserDirs,
    /// The running executable, copied into the install location.
    pub exe: PathBuf,
    /// The numeric uid for the launchd `gui/<uid>` domain (macOS only).
    pub uid: String,
}

impl Context {
    /// Read the real platform, environment and executable. The uid is resolved with
    /// `id -u` on Linux and macOS when `need_uid` is set (a dry run uses a placeholder):
    /// macOS needs it for the launchd domain, Linux for `loginctl enable-linger`.
    pub fn detect(need_uid: bool) -> Result<Context, InstallError> {
        let platform = Platform::current()
            .ok_or_else(|| InstallError::failed("per-user background services are not available on this operating system"))?;
        let exe = std::env::current_exe()
            .map_err(|error| InstallError::failed(format!("cannot find the running executable: {error}")))?;
        let uid = if need_uid && matches!(platform, Platform::Linux | Platform::MacOs) {
            resolve_uid(&mut ProcessRunner)?
        } else {
            UID_PLACEHOLDER.to_string()
        };
        Ok(Context { platform, dirs: UserDirs::from_env(), exe, uid })
    }
}

/// Why a command failed. `invalid` means the input was wrong (exit 2); otherwise
/// the system refused something (exit 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallError {
    message: String,
    invalid: bool,
}

impl InstallError {
    fn invalid(message: impl Into<String>) -> InstallError {
        InstallError { message: message.into(), invalid: true }
    }

    fn failed(message: impl Into<String>) -> InstallError {
        InstallError { message: message.into(), invalid: false }
    }

    pub fn exit_code(&self) -> ExitCode {
        if self.invalid {
            ExitCode::from(2)
        } else {
            ExitCode::from(1)
        }
    }
}

impl fmt::Display for InstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for InstallError {}

/// Where the installed files live for one platform.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    /// `.../RemoteHub/agent` (Linux: `~/.local/share/remotehub/agent`).
    pub agent_dir: PathBuf,
    pub binary: PathBuf,
    pub token: PathBuf,
    /// The systemd unit or LaunchAgent plist. Windows keeps the definition in the task.
    pub service_file: Option<PathBuf>,
}

/// Compute the install locations for `platform`.
pub fn layout(platform: Platform, dirs: &UserDirs) -> Result<Layout, InstallError> {
    let (agent_dir, binary_name, service_file) = match platform {
        Platform::Linux => {
            let home = required_dir(&dirs.home, "HOME")?;
            (
                home.join(".local/share/remotehub/agent"),
                UNIX_BINARY_NAME,
                Some(home.join(".config/systemd/user").join(SERVICE_UNIT)),
            )
        }
        Platform::MacOs => {
            let home = required_dir(&dirs.home, "HOME")?;
            (
                home.join("Library/Application Support/RemoteHub/agent"),
                UNIX_BINARY_NAME,
                Some(home.join("Library/LaunchAgents").join(format!("{LAUNCHD_LABEL}.plist"))),
            )
        }
        Platform::Windows => {
            let local = required_dir(&dirs.local_app_data, "LOCALAPPDATA")?;
            (local.join("RemoteHub").join("agent"), WINDOWS_BINARY_NAME, None)
        }
    };
    Ok(Layout {
        binary: agent_dir.join(binary_name),
        token: agent_dir.join(TOKEN_FILE_NAME),
        agent_dir,
        service_file,
    })
}

fn required_dir(value: &Option<PathBuf>, name: &str) -> Result<PathBuf, InstallError> {
    value.clone().ok_or_else(|| InstallError::failed(format!("{name} is not set; cannot find the per-user install location")))
}

/// One action in a plan. Steps run in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Run an external command. A failure stops the plan only when `required`.
    /// `fallback` is tried once if the command fails.
    Run { argv: Vec<String>, required: bool, fallback: Option<Vec<String>> },
    /// Create a directory and any missing parents. `private` makes the directory
    /// itself `0700` on Unix.
    MakeDir { path: PathBuf, private: bool },
    /// Copy the running executable into place with mode `0755`.
    CopyBinary { from: PathBuf, to: PathBuf },
    /// Copy the trimmed token from `from` into `to` with mode `0600`. The
    /// contents are never shown.
    CopyToken { from: PathBuf, to: PathBuf },
    /// Write generated text (a unit file or plist) with the given Unix mode.
    WriteText { path: PathBuf, text: String, mode: u32 },
    /// Delete a file. A missing file is not an error.
    RemoveFile { path: PathBuf },
    /// Delete a directory only when it is empty. Anything else is left alone.
    RemoveDirIfEmpty { path: PathBuf },
}

/// A complete, ordered description of one command's effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub platform: Platform,
    pub layout: Layout,
    pub steps: Vec<Step>,
}

/// The inputs of `install`. The token is named by path only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallRequest {
    pub server: String,
    pub host_id: String,
    pub token_file: PathBuf,
}

/// What the service runs: `<installed exe> --mode persistent --server ... --token-file <installed token>`.
struct Launch {
    binary: String,
    server: String,
    host_id: String,
    token: String,
}

impl Launch {
    fn argv(&self) -> Vec<String> {
        vec![
            self.binary.clone(),
            "--mode".into(),
            "persistent".into(),
            "--server".into(),
            self.server.clone(),
            "--host-id".into(),
            self.host_id.clone(),
            "--token-file".into(),
            self.token.clone(),
        ]
    }

    /// The `/TR` value. The binary and token are quoted because they are paths.
    /// The server URL and host id cannot contain spaces (validated earlier).
    fn windows_task_command(&self) -> String {
        format!(
            "\"{}\" --mode persistent --server {} --host-id {} --token-file \"{}\"",
            self.binary, self.server, self.host_id, self.token
        )
    }
}

/// Build the install plan. Validates the server URL and host id, computes the
/// paths, and renders the service definition. It does not read the token.
pub fn plan_install(ctx: &Context, request: &InstallRequest) -> Result<Plan, InstallError> {
    let server = validate_server(&request.server)?;
    validate_host_id(&request.host_id)?;
    let layout = layout(ctx.platform, &ctx.dirs)?;
    let launch = Launch {
        binary: path_text(ctx.platform, &layout.binary)?,
        server,
        host_id: request.host_id.clone(),
        token: path_text(ctx.platform, &layout.token)?,
    };

    let mut steps = Vec::new();
    match ctx.platform {
        Platform::Linux => {
            let unit = service_file(&layout)?.clone();
            // Stop a previous instance first so its binary and token can be replaced.
            steps.push(run(&["systemctl", "--user", "stop", SERVICE_UNIT], false));
            steps.extend(install_file_steps(ctx, &layout, &request.token_file));
            steps.push(Step::MakeDir { path: parent_of(&unit)?, private: false });
            steps.push(Step::WriteText { path: unit, text: systemd_unit(&launch), mode: 0o644 });
            steps.push(run(&["systemctl", "--user", "daemon-reload"], true));
            // Linger keeps the user manager (and this unit) alive when the installing session
            // ends. Without it, a machine with no interactive login loses the agent seconds
            // after the install, because systemd stops the user manager with the last session.
            // A user may enable linger for their own account; when that is not permitted the
            // step is skipped and the install continues.
            steps.push(run(&["loginctl", "enable-linger", &ctx.uid], false));
            steps.push(run(&["systemctl", "--user", "enable", "--now", SERVICE_UNIT], true));
        }
        Platform::MacOs => {
            let plist = service_file(&layout)?.clone();
            steps.push(Step::Run {
                argv: vec!["launchctl".into(), "bootout".into(), launchd_target(&ctx.uid)],
                required: false,
                fallback: None,
            });
            steps.extend(install_file_steps(ctx, &layout, &request.token_file));
            steps.push(Step::MakeDir { path: parent_of(&plist)?, private: false });
            steps.push(Step::WriteText { path: plist.clone(), text: launchd_plist(&launch), mode: 0o644 });
            let plist_text = path_text(ctx.platform, &plist)?;
            steps.push(Step::Run {
                argv: vec!["launchctl".into(), "bootstrap".into(), launchd_domain(&ctx.uid), plist_text.clone()],
                required: true,
                fallback: Some(vec!["launchctl".into(), "load".into(), "-w".into(), plist_text]),
            });
        }
        Platform::Windows => {
            let command = launch.windows_task_command();
            if command.chars().count() > SCHTASKS_TR_MAX_LEN {
                return Err(InstallError::invalid(format!(
                    "the scheduled task command would be {} characters; schtasks allows {SCHTASKS_TR_MAX_LEN}. Use a shorter Windows user name or --server URL",
                    command.chars().count()
                )));
            }
            steps.push(run(&["schtasks", "/End", "/TN", TASK_NAME], false));
            steps.extend(install_file_steps(ctx, &layout, &request.token_file));
            let mut create = argv_of(&["schtasks", "/Create", "/TN", TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR"]);
            create.push(command);
            steps.push(Step::Run { argv: create, required: true, fallback: None });
            steps.push(run(&["schtasks", "/Run", "/TN", TASK_NAME], true));
        }
    }
    Ok(Plan { platform: ctx.platform, layout, steps })
}

fn install_file_steps(ctx: &Context, layout: &Layout, token_file: &Path) -> Vec<Step> {
    let mut steps = vec![Step::MakeDir { path: layout.agent_dir.clone(), private: true }];
    // Skip the copy when the running executable already is the installed file.
    if ctx.exe != layout.binary {
        steps.push(Step::CopyBinary { from: ctx.exe.clone(), to: layout.binary.clone() });
    }
    steps.push(Step::CopyToken { from: token_file.to_path_buf(), to: layout.token.clone() });
    steps
}

/// Build the uninstall plan. It touches only the files install creates: the
/// service definition, `agent.token`, the installed binary, and the RemoteHub
/// directories if they are empty afterwards.
pub fn plan_uninstall(ctx: &Context) -> Result<Plan, InstallError> {
    let layout = layout(ctx.platform, &ctx.dirs)?;
    let mut steps = Vec::new();
    match ctx.platform {
        Platform::Linux => {
            steps.push(run(&["systemctl", "--user", "disable", "--now", SERVICE_UNIT], false));
            steps.push(Step::RemoveFile { path: service_file(&layout)?.clone() });
            steps.push(run(&["systemctl", "--user", "daemon-reload"], false));
        }
        Platform::MacOs => {
            let plist = service_file(&layout)?.clone();
            let plist_text = path_text(ctx.platform, &plist)?;
            steps.push(Step::Run {
                argv: vec!["launchctl".into(), "bootout".into(), launchd_target(&ctx.uid)],
                required: false,
                fallback: Some(vec!["launchctl".into(), "unload".into(), "-w".into(), plist_text]),
            });
            steps.push(Step::RemoveFile { path: plist });
        }
        Platform::Windows => {
            steps.push(run(&["schtasks", "/End", "/TN", TASK_NAME], false));
            steps.push(run(&["schtasks", "/Delete", "/TN", TASK_NAME, "/F"], false));
        }
    }
    steps.push(Step::RemoveFile { path: layout.token.clone() });
    steps.push(Step::RemoveFile { path: layout.binary.clone() });
    steps.push(Step::RemoveDirIfEmpty { path: layout.agent_dir.clone() });
    if let Some(remotehub_dir) = layout.agent_dir.parent() {
        steps.push(Step::RemoveDirIfEmpty { path: remotehub_dir.to_path_buf() });
    }
    Ok(Plan { platform: ctx.platform, layout, steps })
}

/// The query `service-status` runs, and where its result lands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusPlan {
    pub platform: Platform,
    pub layout: Layout,
    pub query: Vec<String>,
}

/// Build the status query. Read-only.
pub fn plan_status(ctx: &Context) -> Result<StatusPlan, InstallError> {
    let layout = layout(ctx.platform, &ctx.dirs)?;
    let query = match ctx.platform {
        Platform::Linux => argv_of(&["systemctl", "--user", "is-active", SERVICE_UNIT]),
        Platform::MacOs => vec!["launchctl".into(), "print".into(), launchd_target(&ctx.uid)],
        Platform::Windows => argv_of(&["schtasks", "/Query", "/TN", TASK_NAME, "/FO", "LIST"]),
    };
    Ok(StatusPlan { platform: ctx.platform, layout, query })
}

/// systemd user unit for `launch`. Each `ExecStart` argument is quoted, and
/// `$` and `%` are doubled so systemd does not expand them.
pub fn systemd_unit_text(binary: &str, server: &str, host_id: &str, token: &str) -> String {
    systemd_unit(&Launch {
        binary: binary.into(),
        server: server.into(),
        host_id: host_id.into(),
        token: token.into(),
    })
}

fn systemd_unit(launch: &Launch) -> String {
    let exec_start: Vec<String> = launch.argv().iter().map(|arg| systemd_quote(arg)).collect();
    format!(
        "[Unit]\n\
         Description=RemoteHub agent\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         ExecStart={}\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         RestartPreventExitStatus=1 2\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exec_start.join(" ")
    )
}

fn systemd_quote(arg: &str) -> String {
    let mut quoted = String::from("\"");
    for character in arg.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '$' => quoted.push_str("$$"),
            '%' => quoted.push_str("%%"),
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted
}

/// LaunchAgent plist for `launch`. Every value is XML-escaped.
pub fn launchd_plist_text(binary: &str, server: &str, host_id: &str, token: &str) -> String {
    launchd_plist(&Launch {
        binary: binary.into(),
        server: server.into(),
        host_id: host_id.into(),
        token: token.into(),
    })
}

fn launchd_plist(launch: &Launch) -> String {
    let mut arguments = String::new();
    for arg in launch.argv() {
        arguments.push_str(&format!("    <string>{}</string>\n", xml_escape(&arg)));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \x20\x20<key>Label</key>\n\
         \x20\x20<string>{LAUNCHD_LABEL}</string>\n\
         \x20\x20<key>ProgramArguments</key>\n\
         \x20\x20<array>\n\
         {arguments}\
         \x20\x20</array>\n\
         \x20\x20<key>RunAtLoad</key>\n\
         \x20\x20<true/>\n\
         \x20\x20<key>KeepAlive</key>\n\
         \x20\x20<dict>\n\
         \x20\x20\x20\x20<key>SuccessfulExit</key>\n\
         \x20\x20\x20\x20<false/>\n\
         \x20\x20</dict>\n\
         \x20\x20<key>ThrottleInterval</key>\n\
         \x20\x20<integer>60</integer>\n\
         </dict>\n\
         </plist>\n"
    )
}

fn xml_escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            other => escaped.push(other),
        }
    }
    escaped
}

fn launchd_domain(uid: &str) -> String {
    format!("gui/{uid}")
}

fn launchd_target(uid: &str) -> String {
    format!("gui/{uid}/{LAUNCHD_LABEL}")
}

/// Accept only a `ws://` or `wss://` URL made of characters that are safe in every
/// generated format. Returns the trimmed URL.
pub fn validate_server(raw: &str) -> Result<String, InstallError> {
    let url = raw.trim();
    ServerUrl::parse(url).map_err(|error| InstallError::invalid(format!("--server: {error}")))?;
    let safe = url.bytes().all(|byte| byte.is_ascii_alphanumeric() || SERVER_URL_EXTRA.contains(&byte));
    if !safe {
        return Err(InstallError::invalid(
            "--server may only contain letters, digits and - . _ ~ : / ? & = + @ [ ] ! , ; ( )",
        ));
    }
    Ok(url.to_string())
}

/// Accept 1 to 128 characters from `[A-Za-z0-9_-]`.
pub fn validate_host_id(host_id: &str) -> Result<(), InstallError> {
    let valid = !host_id.is_empty()
        && host_id.len() <= MAX_HOST_ID_LEN
        && host_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(InstallError::invalid(format!(
            "--host-id must be 1 to {MAX_HOST_ID_LEN} characters from A-Z, a-z, 0-9, '-' and '_'"
        )))
    }
}

/// Check that the token file holds one non-empty token on one line. Reads the
/// file and never returns or prints the value.
pub fn validate_token_file(path: &Path) -> Result<(), InstallError> {
    read_token(path).map(|_| ())
}

fn read_token(path: &Path) -> Result<String, InstallError> {
    let raw = fs::read_to_string(path)
        .map_err(|error| InstallError::invalid(format!("cannot read --token-file {}: {error}", path.display())))?;
    let token = raw.trim();
    if token.is_empty() {
        return Err(InstallError::invalid(format!("the token file {} is empty", path.display())));
    }
    if token.len() > MAX_TOKEN_LEN || token.chars().any(|character| character.is_whitespace() || character.is_control()) {
        return Err(InstallError::invalid(format!(
            "the token file {} must hold one token on a single line",
            path.display()
        )));
    }
    Ok(token.to_string())
}

/// Text form of a path that goes into a generated file or command line.
fn path_text(platform: Platform, path: &Path) -> Result<String, InstallError> {
    let text = path
        .to_str()
        .ok_or_else(|| InstallError::invalid(format!("path is not valid UTF-8: {}", path.display())))?;
    if text.chars().any(|character| character.is_control()) {
        return Err(InstallError::invalid(format!("path contains a control character: {}", path.display())));
    }
    if platform == Platform::Windows && text.contains('"') {
        return Err(InstallError::invalid(format!("path contains a double quote: {}", path.display())));
    }
    Ok(text.to_string())
}

fn service_file(layout: &Layout) -> Result<&PathBuf, InstallError> {
    layout
        .service_file
        .as_ref()
        .ok_or_else(|| InstallError::failed("this platform has no service file"))
}

fn parent_of(path: &Path) -> Result<PathBuf, InstallError> {
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| InstallError::failed(format!("path has no parent directory: {}", path.display())))
}

fn argv_of(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

fn run(items: &[&str], required: bool) -> Step {
    Step::Run { argv: argv_of(items), required, fallback: None }
}

/// What one external command produced.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommandOutcome {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs external commands. Tests substitute a fake so no real service is touched.
pub trait Runner {
    fn run(&mut self, argv: &[String]) -> io::Result<CommandOutcome>;
}

/// The real runner: spawns the program directly, with no shell.
pub struct ProcessRunner;

impl Runner for ProcessRunner {
    fn run(&mut self, argv: &[String]) -> io::Result<CommandOutcome> {
        let (program, args) = argv
            .split_first()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty command"))?;
        let output = Process::new(program).args(args).output()?;
        Ok(CommandOutcome {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

fn resolve_uid(runner: &mut dyn Runner) -> Result<String, InstallError> {
    let outcome = runner
        .run(&argv_of(&["id", "-u"]))
        .map_err(|error| InstallError::failed(format!("cannot run `id -u`: {error}")))?;
    let uid = outcome.stdout.trim();
    if !outcome.success || uid.is_empty() || !uid.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(InstallError::failed("cannot determine the user id for launchctl"));
    }
    Ok(uid.to_string())
}

/// Carry out `steps`. Returns whether anything was written or removed. A required
/// command that fails stops the plan with an error. Files written before that
/// point are kept.
pub fn execute(steps: &[Step], runner: &mut dyn Runner) -> Result<bool, InstallError> {
    let mut changed = false;
    for step in steps {
        match step {
            Step::Run { argv, required, fallback } => {
                if let Err(error) = run_command(runner, argv, fallback.as_deref()) {
                    if *required {
                        return Err(error);
                    }
                }
            }
            Step::MakeDir { path, private } => make_dir(path, *private)?,
            Step::CopyBinary { from, to } => {
                copy_atomic(from, to, 0o755)?;
                changed = true;
            }
            Step::CopyToken { from, to } => {
                let token = read_token(from)?;
                write_atomic(to, token.as_bytes(), 0o600)?;
                changed = true;
            }
            Step::WriteText { path, text, mode } => {
                write_atomic(path, text.as_bytes(), *mode)?;
                changed = true;
            }
            Step::RemoveFile { path } => changed |= remove_file(path)?,
            Step::RemoveDirIfEmpty { path } => changed |= remove_dir_if_empty(path)?,
        }
    }
    Ok(changed)
}

fn run_command(runner: &mut dyn Runner, argv: &[String], fallback: Option<&[String]>) -> Result<(), InstallError> {
    match (attempt(runner, argv), fallback) {
        (Ok(()), _) => Ok(()),
        (Err(_), Some(alternative)) => attempt(runner, alternative),
        (Err(error), None) => Err(error),
    }
}

fn attempt(runner: &mut dyn Runner, argv: &[String]) -> Result<(), InstallError> {
    match runner.run(argv) {
        Ok(outcome) if outcome.success => Ok(()),
        Ok(outcome) => {
            let detail = first_line(&outcome.stderr)
                .or_else(|| first_line(&outcome.stdout))
                .map(|line| format!(": {line}"))
                .unwrap_or_default();
            Err(InstallError::failed(format!("`{}` failed{detail}", display_command(argv))))
        }
        Err(error) => Err(InstallError::failed(format!("could not run `{}`: {error}", display_command(argv)))),
    }
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

fn display_command(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| {
            if arg.is_empty() || arg.chars().any(|character| character.is_whitespace() || character == '"') {
                format!("\"{}\"", arg.replace('"', "\\\""))
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn make_dir(path: &Path, private: bool) -> Result<(), InstallError> {
    let result = if private { make_private_dir(path) } else { fs::create_dir_all(path) };
    result.map_err(|error| InstallError::failed(format!("cannot create {}: {error}", path.display())))
}

fn make_private_dir(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    create_private_dir(path)
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir(path)
}

fn temp_sibling(path: &Path) -> Result<PathBuf, InstallError> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| InstallError::failed(format!("invalid target path {}", path.display())))?;
    Ok(path.with_file_name(format!(".{name}.tmp-{}", std::process::id())))
}

/// Write `bytes` to a temporary sibling with `mode`, then rename it over `path`.
/// A reader never sees a partial file, and an open file is never truncated.
fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<(), InstallError> {
    let tmp = temp_sibling(path)?;
    let _ = fs::remove_file(&tmp);
    let result = write_temp_then_rename(&tmp, path, bytes, mode);
    result.map_err(|error| {
        let _ = fs::remove_file(&tmp);
        InstallError::failed(format!("cannot write {}: {error}", path.display()))
    })
}

fn write_temp_then_rename(tmp: &Path, path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    {
        let mut file = create_new_with_mode(tmp, mode)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    set_mode(tmp, mode)?;
    fs::rename(tmp, path)
}

fn copy_atomic(from: &Path, to: &Path, mode: u32) -> Result<(), InstallError> {
    let tmp = temp_sibling(to)?;
    let _ = fs::remove_file(&tmp);
    let result = fs::copy(from, &tmp)
        .and_then(|_| set_mode(&tmp, mode))
        .and_then(|_| fs::rename(&tmp, to));
    result.map_err(|error| {
        let _ = fs::remove_file(&tmp);
        InstallError::failed(format!("cannot copy {} to {}: {error}", from.display(), to.display()))
    })
}

#[cfg(unix)]
fn create_new_with_mode(path: &Path, mode: u32) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new().write(true).create_new(true).mode(mode).open(path)
}

#[cfg(not(unix))]
fn create_new_with_mode(path: &Path, _mode: u32) -> io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

fn remove_file(path: &Path) -> Result<bool, InstallError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(InstallError::failed(format!("cannot remove {}: {error}", path.display()))),
    }
}

fn remove_dir_if_empty(path: &Path) -> Result<bool, InstallError> {
    let mut entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(InstallError::failed(format!("cannot read {}: {error}", path.display()))),
    };
    if entries.next().is_some() {
        return Ok(false);
    }
    drop(entries);
    match fs::remove_dir(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(InstallError::failed(format!("cannot remove {}: {error}", path.display()))),
    }
}

/// The plan as text for `--dry-run`. The token's value is never shown: a token
/// copy is listed by path only.
pub fn render_plan(plan: &Plan) -> String {
    let mut out = String::from("dry run: nothing is written and no command is run. The install would:\n");
    for step in &plan.steps {
        match step {
            Step::Run { argv, required, fallback } => {
                let note = if *required { "" } else { " (a failure is ignored)" };
                out.push_str(&format!("  run{note}: {}\n", display_command(argv)));
                if let Some(alternative) = fallback {
                    out.push_str(&format!("    if that fails, run: {}\n", display_command(alternative)));
                }
            }
            Step::MakeDir { path, private } => {
                let mode = if *private { " (mode 0700)" } else { "" };
                out.push_str(&format!("  create directory {}{mode}\n", path.display()));
            }
            Step::CopyBinary { from, to } => {
                out.push_str(&format!("  copy {} to {} (mode 0755)\n", from.display(), to.display()));
            }
            Step::CopyToken { from, to } => {
                out.push_str(&format!(
                    "  copy token file {} to {} (mode 0600; contents not shown)\n",
                    from.display(),
                    to.display()
                ));
            }
            Step::WriteText { path, text, mode } => {
                out.push_str(&format!("  write {} (mode {mode:04o}):\n", path.display()));
                for line in text.lines() {
                    out.push_str(&format!("    | {line}\n"));
                }
            }
            Step::RemoveFile { path } => out.push_str(&format!("  remove file {} (if present)\n", path.display())),
            Step::RemoveDirIfEmpty { path } => {
                out.push_str(&format!("  remove directory {} (only if empty)\n", path.display()));
            }
        }
    }
    out
}

/// `install`: validate, plan, then either render (dry run) or execute.
/// Returns the text to print.
pub fn install(
    ctx: &Context,
    request: &InstallRequest,
    dry_run: bool,
    runner: &mut dyn Runner,
) -> Result<String, InstallError> {
    let plan = plan_install(ctx, request)?;
    validate_token_file(&request.token_file)?;
    if dry_run {
        return Ok(render_plan(&plan));
    }
    execute(&plan.steps, runner).map_err(|error| {
        InstallError::failed(format!(
            "{error}; files already written stay in place, so fix the problem and run install again"
        ))
    })?;
    Ok(installed_message(&plan))
}

fn installed_message(plan: &Plan) -> String {
    let binary = plan.layout.binary.display();
    let token = plan.layout.token.display();
    let service = plan
        .layout
        .service_file
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    match plan.platform {
        Platform::Linux => format!(
            "installed RemoteHub agent as the per-user systemd service {SERVICE_UNIT}: unit {service}, binary {binary}, token {token} (mode 0600)\n"
        ),
        Platform::MacOs => format!(
            "installed RemoteHub agent as the per-user LaunchAgent {LAUNCHD_LABEL}: plist {service}, binary {binary}, token {token} (mode 0600)\n"
        ),
        Platform::Windows => format!(
            "installed RemoteHub agent as the per-user logon task \"{TASK_NAME}\": binary {binary}, token {token}\n"
        ),
    }
}

/// `uninstall`: stop and remove exactly what install created. Idempotent.
pub fn uninstall(ctx: &Context, runner: &mut dyn Runner) -> Result<String, InstallError> {
    let plan = plan_uninstall(ctx)?;
    let mut present = Vec::new();
    for path in plan
        .layout
        .service_file
        .iter()
        .chain([&plan.layout.token, &plan.layout.binary])
    {
        if path.is_file() {
            present.push(path.display().to_string());
        }
    }
    let changed = execute(&plan.steps, runner)?;
    if present.is_empty() && !changed {
        return Ok("RemoteHub agent is not installed; nothing to remove.\n".to_string());
    }
    Ok(format!("uninstalled RemoteHub agent; removed {}\n", present.join(", ")))
}

/// `service-status`: report which files exist and what the service manager says.
/// Read-only.
pub fn status(ctx: &Context, runner: &mut dyn Runner) -> Result<String, InstallError> {
    let plan = plan_status(ctx)?;
    let state = interpret_status(plan.platform, runner.run(&plan.query));
    let presence = |path: &Path| if path.is_file() { "present" } else { "missing" };
    let mut out = format!("RemoteHub agent, per-user service ({})\n", plan.platform.name());
    match &plan.layout.service_file {
        Some(service) => out.push_str(&format!("  service file: {} ({})\n", service.display(), presence(service))),
        None => out.push_str(&format!("  scheduled task: {TASK_NAME}\n")),
    }
    out.push_str(&format!("  binary:       {} ({})\n", plan.layout.binary.display(), presence(&plan.layout.binary)));
    out.push_str(&format!("  token:        {} ({})\n", plan.layout.token.display(), presence(&plan.layout.token)));
    out.push_str(&format!("  status:       {state}\n"));
    Ok(out)
}

/// Turn a status query's result into one word or phrase.
pub fn interpret_status(platform: Platform, result: io::Result<CommandOutcome>) -> String {
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(error) => return format!("unknown (could not run the service manager: {error})"),
    };
    match platform {
        Platform::Linux => {
            let state = outcome.stdout.trim();
            if state.is_empty() {
                format!("unknown ({})", first_line(&outcome.stderr).unwrap_or("no output"))
            } else {
                state.to_string()
            }
        }
        Platform::MacOs => {
            if !outcome.success {
                return "not loaded".to_string();
            }
            outcome
                .stdout
                .lines()
                .find_map(|line| line.trim().strip_prefix("state = "))
                .map(|state| state.trim().to_string())
                .unwrap_or_else(|| "loaded".to_string())
        }
        Platform::Windows => {
            if !outcome.success {
                return "not registered".to_string();
            }
            outcome
                .stdout
                .lines()
                .find_map(|line| line.trim().strip_prefix("Status:"))
                .map(|state| state.trim().to_string())
                .unwrap_or_else(|| "registered".to_string())
        }
    }
}

/// Entry point for `remotehub-agent install`.
pub fn run_install(options: &InstallOptions) -> ExitCode {
    let request = InstallRequest {
        server: options.server.clone(),
        host_id: options.host_id.clone(),
        token_file: options.token_file.clone(),
    };
    let result = Context::detect(!options.dry_run)
        .and_then(|ctx| install(&ctx, &request, options.dry_run, &mut ProcessRunner));
    finish("install", result)
}

/// Entry point for `remotehub-agent uninstall`.
pub fn run_uninstall() -> ExitCode {
    finish("uninstall", Context::detect(true).and_then(|ctx| uninstall(&ctx, &mut ProcessRunner)))
}

/// Entry point for `remotehub-agent service-status`.
pub fn run_status() -> ExitCode {
    finish("service-status", Context::detect(true).and_then(|ctx| status(&ctx, &mut ProcessRunner)))
}

fn finish(verb: &str, result: Result<String, InstallError>) -> ExitCode {
    match result {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("remotehub-agent {verb}: {error}");
            error.exit_code()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const TOKEN: &str = "rhag_1_TOKEN_VALUE_MUST_NOT_LEAK_7f3a";
    const SERVER: &str = "wss://hub.example/ws/agent";
    const HOST: &str = "host-1";

    /// A temporary directory that is removed on drop. Built from the system temp
    /// directory and a unique name, with no crate dependency.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(name: &str) -> TempRoot {
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0);
            let path = std::env::temp_dir().join(format!("remotehub-install-{name}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            TempRoot(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Records every command and fails any whose line contains a marker.
    #[derive(Default)]
    struct FakeRunner {
        calls: Vec<Vec<String>>,
        fail_on: Vec<&'static str>,
    }

    impl Runner for FakeRunner {
        fn run(&mut self, argv: &[String]) -> io::Result<CommandOutcome> {
            self.calls.push(argv.to_vec());
            let line = argv.join(" ");
            let failing = self.fail_on.iter().any(|marker| line.contains(marker));
            Ok(CommandOutcome {
                success: !failing,
                stdout: String::new(),
                stderr: if failing { "Failed to connect to bus".into() } else { String::new() },
            })
        }
    }

    fn linux_context(root: &Path) -> Context {
        Context {
            platform: Platform::Linux,
            dirs: UserDirs { home: Some(root.join("home")), local_app_data: None },
            exe: root.join("bin/remotehub-agent"),
            uid: "1000".into(),
        }
    }

    fn mac_context(root: &Path) -> Context {
        Context {
            platform: Platform::MacOs,
            dirs: UserDirs { home: Some(root.join("home")), local_app_data: None },
            exe: root.join("bin/remotehub-agent"),
            uid: "501".into(),
        }
    }

    fn windows_context(_root: &Path) -> Context {
        Context {
            platform: Platform::Windows,
            dirs: UserDirs { home: None, local_app_data: Some(PathBuf::from("C:\\Users\\u\\AppData\\Local")) },
            exe: PathBuf::from("C:\\Users\\u\\bin\\remotehub-agent.exe"),
            uid: "0".into(),
        }
    }

    fn request(root: &Path) -> InstallRequest {
        let token_file = root.join("source-token.txt");
        fs::write(&token_file, format!("{TOKEN}\n")).unwrap();
        InstallRequest { server: SERVER.into(), host_id: HOST.into(), token_file }
    }

    fn write_exe(ctx: &Context) {
        fs::create_dir_all(ctx.exe.parent().unwrap()).unwrap();
        fs::write(&ctx.exe, b"ELF-test-binary").unwrap();
    }

    fn step_argv(plan: &Plan) -> Vec<Vec<String>> {
        plan.steps
            .iter()
            .filter_map(|step| match step {
                Step::Run { argv, .. } => Some(argv.clone()),
                _ => None,
            })
            .collect()
    }

    fn text_of(plan: &Plan) -> Vec<String> {
        plan.steps
            .iter()
            .filter_map(|step| match step {
                Step::WriteText { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn systemd_unit_text_is_exact() {
        let unit = systemd_unit_text(
            "/home/u/.local/share/remotehub/agent/remotehub-agent",
            SERVER,
            HOST,
            "/home/u/.local/share/remotehub/agent/agent.token",
        );
        let expected = "[Unit]\n\
            Description=RemoteHub agent\n\
            After=network-online.target\n\
            Wants=network-online.target\n\
            \n\
            [Service]\n\
            ExecStart=\"/home/u/.local/share/remotehub/agent/remotehub-agent\" \"--mode\" \"persistent\" \"--server\" \"wss://hub.example/ws/agent\" \"--host-id\" \"host-1\" \"--token-file\" \"/home/u/.local/share/remotehub/agent/agent.token\"\n\
            Restart=on-failure\n\
            RestartSec=5\n\
            RestartPreventExitStatus=1 2\n\
            \n\
            [Install]\n\
            WantedBy=default.target\n";
        assert_eq!(unit, expected);
    }

    #[test]
    fn systemd_quoting_escapes_specifiers_and_quotes() {
        assert_eq!(systemd_quote("/a b/$x%y\"z\\"), "\"/a b/$$x%%y\\\"z\\\\\"");
    }

    #[test]
    fn launchd_plist_text_is_exact_and_escaped() {
        let plist = launchd_plist_text(
            "/Users/u/Library/Application Support/RemoteHub/agent/remotehub-agent",
            "wss://hub.example/ws?a=1&b=2",
            HOST,
            "/Users/u/Library/Application Support/RemoteHub/agent/agent.token",
        );
        let expected = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
            <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
            <plist version=\"1.0\">\n\
            <dict>\n\
            \x20\x20<key>Label</key>\n\
            \x20\x20<string>com.remotehub.agent</string>\n\
            \x20\x20<key>ProgramArguments</key>\n\
            \x20\x20<array>\n\
            \x20\x20\x20\x20<string>/Users/u/Library/Application Support/RemoteHub/agent/remotehub-agent</string>\n\
            \x20\x20\x20\x20<string>--mode</string>\n\
            \x20\x20\x20\x20<string>persistent</string>\n\
            \x20\x20\x20\x20<string>--server</string>\n\
            \x20\x20\x20\x20<string>wss://hub.example/ws?a=1&amp;b=2</string>\n\
            \x20\x20\x20\x20<string>--host-id</string>\n\
            \x20\x20\x20\x20<string>host-1</string>\n\
            \x20\x20\x20\x20<string>--token-file</string>\n\
            \x20\x20\x20\x20<string>/Users/u/Library/Application Support/RemoteHub/agent/agent.token</string>\n\
            \x20\x20</array>\n\
            \x20\x20<key>RunAtLoad</key>\n\
            \x20\x20<true/>\n\
            \x20\x20<key>KeepAlive</key>\n\
            \x20\x20<dict>\n\
            \x20\x20\x20\x20<key>SuccessfulExit</key>\n\
            \x20\x20\x20\x20<false/>\n\
            \x20\x20</dict>\n\
            \x20\x20<key>ThrottleInterval</key>\n\
            \x20\x20<integer>60</integer>\n\
            </dict>\n\
            </plist>\n";
        assert_eq!(plist, expected);
    }

    #[test]
    fn linux_plan_has_exact_commands_and_unit_path() {
        let root = TempRoot::new("linux-plan");
        let ctx = linux_context(root.path());
        let plan = plan_install(&ctx, &request(root.path())).unwrap();
        assert_eq!(
            step_argv(&plan),
            vec![
                argv_of(&["systemctl", "--user", "stop", SERVICE_UNIT]),
                argv_of(&["systemctl", "--user", "daemon-reload"]),
                // Linger keeps the agent alive after the installing session ends.
                argv_of(&["loginctl", "enable-linger", "1000"]),
                argv_of(&["systemctl", "--user", "enable", "--now", SERVICE_UNIT]),
            ]
        );
        let unit = ctx.dirs.home.clone().unwrap().join(".config/systemd/user").join(SERVICE_UNIT);
        assert_eq!(plan.layout.service_file.as_deref(), Some(unit.as_path()));
        assert!(plan.steps.contains(&Step::WriteText {
            path: unit,
            text: text_of(&plan).remove(0),
            mode: 0o644,
        }));
    }

    #[test]
    fn linux_plan_enables_linger_so_the_agent_survives_the_installing_session() {
        let root = TempRoot::new("linux-linger");
        let ctx = linux_context(root.path());
        let plan = plan_install(&ctx, &request(root.path())).unwrap();
        let linger = plan
            .steps
            .iter()
            .find_map(|step| match step {
                Step::Run { argv, required, .. } if argv.first().map(String::as_str) == Some("loginctl") => {
                    Some((argv.clone(), *required))
                }
                _ => None,
            })
            .expect("the Linux plan enables linger");
        assert_eq!(linger.0, vec!["loginctl", "enable-linger", "1000"]);
        // A machine that does not allow it must still install; the step is not required.
        assert_eq!(linger.1, false);
        // Linger must come before the unit is started, so the manager is already kept alive.
        let argv_of_step = |step: &Step| match step {
            Step::Run { argv, .. } => argv.clone(),
            _ => Vec::new(),
        };
        let positions: Vec<usize> = plan
            .steps
            .iter()
            .enumerate()
            .filter(|(_, step)| {
                let argv = argv_of_step(step);
                argv.first().map(String::as_str) == Some("loginctl")
                    || argv.first().map(String::as_str) == Some("systemctl")
                        && argv.iter().any(|arg| arg == "enable")
            })
            .map(|(index, _)| index)
            .collect();
        assert_eq!(positions.len(), 2, "linger and enable are both present");
        assert!(positions[0] < positions[1], "linger runs before the unit starts");
    }

    #[test]
    fn macos_plan_uses_bootstrap_with_load_fallback() {
        let root = TempRoot::new("mac-plan");
        let ctx = mac_context(root.path());
        let plan = plan_install(&ctx, &request(root.path())).unwrap();
        let plist = plan.layout.service_file.clone().unwrap();
        let plist_text = plist.display().to_string();
        assert_eq!(
            step_argv(&plan),
            vec![
                argv_of(&["launchctl", "bootout", "gui/501/com.remotehub.agent"]),
                argv_of(&["launchctl", "bootstrap", "gui/501", &plist_text]),
            ]
        );
        let bootstrap = plan
            .steps
            .iter()
            .find_map(|step| match step {
                Step::Run { argv, fallback, .. } if argv.get(1).map(String::as_str) == Some("bootstrap") => {
                    fallback.clone()
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(bootstrap, argv_of(&["launchctl", "load", "-w", &plist_text]));
        assert!(plist.ends_with("Library/LaunchAgents/com.remotehub.agent.plist"));
    }

    #[test]
    fn windows_plan_creates_logon_task_and_starts_it() {
        let root = TempRoot::new("win-plan");
        let ctx = windows_context(root.path());
        let plan = plan_install(&ctx, &request(root.path())).unwrap();
        let binary = plan.layout.binary.display().to_string();
        let token = plan.layout.token.display().to_string();
        let tr = format!("\"{binary}\" --mode persistent --server {SERVER} --host-id {HOST} --token-file \"{token}\"");
        assert_eq!(
            step_argv(&plan),
            vec![
                argv_of(&["schtasks", "/End", "/TN", TASK_NAME]),
                vec![
                    "schtasks".into(),
                    "/Create".into(),
                    "/TN".into(),
                    TASK_NAME.into(),
                    "/SC".into(),
                    "ONLOGON".into(),
                    "/RL".into(),
                    "LIMITED".into(),
                    "/F".into(),
                    "/TR".into(),
                    tr,
                ],
                argv_of(&["schtasks", "/Run", "/TN", TASK_NAME]),
            ]
        );
        assert!(plan.layout.service_file.is_none());
        assert!(plan.layout.binary.ends_with("RemoteHub/agent/remotehub-agent.exe"));
    }

    #[test]
    fn windows_task_command_over_schtasks_limit_is_refused() {
        let root = TempRoot::new("win-long");
        let mut ctx = windows_context(root.path());
        ctx.dirs.local_app_data = Some(PathBuf::from(format!("C:\\{}", "x".repeat(260))));
        let error = plan_install(&ctx, &request(root.path())).unwrap_err();
        assert!(error.to_string().contains("261"), "{error}");
    }

    #[test]
    fn token_never_appears_in_generated_text_or_commands() {
        for platform in [Platform::Linux, Platform::MacOs, Platform::Windows] {
            let root = TempRoot::new("no-token");
            let ctx = match platform {
                Platform::Linux => linux_context(root.path()),
                Platform::MacOs => mac_context(root.path()),
                Platform::Windows => windows_context(root.path()),
            };
            let plan = plan_install(&ctx, &request(root.path())).unwrap();
            let rendered = render_plan(&plan);
            assert!(!rendered.contains(TOKEN), "{platform:?} dry run shows the token");
            for text in text_of(&plan) {
                assert!(!text.contains(TOKEN), "{platform:?} generated file contains the token");
            }
            for argv in step_argv(&plan) {
                assert!(!argv.join(" ").contains(TOKEN), "{platform:?} command contains the token");
            }
        }
    }

    #[test]
    fn invalid_server_urls_are_rejected() {
        for bad in [
            "",
            "https://hub.example",
            "ws://",
            "wss://hub.example/path with space",
            "wss://hub.example/$HOME",
            "wss://hub.example/%h",
            "wss://hub.example/\"quoted\"",
            "wss://hub.example/a\nb",
        ] {
            let error = validate_server(bad).unwrap_err();
            assert!(error.invalid, "{bad:?} should be an input error");
        }
        assert_eq!(validate_server("  wss://hub.example/ws/agent  ").unwrap(), SERVER);
        assert_eq!(validate_server("ws://127.0.0.1:8090").unwrap(), "ws://127.0.0.1:8090");
    }

    #[test]
    fn invalid_host_ids_are_rejected() {
        assert!(validate_host_id("").is_err());
        assert!(validate_host_id(&"a".repeat(129)).is_err());
        for bad in ["has space", "semi;colon", "quote\"", "dollar$", "new\nline", "slash/x"] {
            assert!(validate_host_id(bad).is_err(), "{bad:?}");
        }
        assert!(validate_host_id(&"a".repeat(128)).is_ok());
        assert!(validate_host_id("Host_01-a").is_ok());
    }

    #[test]
    fn install_rejects_bad_inputs_before_planning_anything() {
        let root = TempRoot::new("bad-input");
        let ctx = linux_context(root.path());
        let mut bad = request(root.path());
        bad.host_id = "x y".into();
        let mut runner = FakeRunner::default();
        assert!(install(&ctx, &bad, false, &mut runner).is_err());
        assert!(runner.calls.is_empty());
        assert!(!root.path().join("home").exists());
    }

    #[test]
    fn uninstall_plan_touches_only_install_paths() {
        let root = TempRoot::new("uninstall-plan");
        for ctx in [linux_context(root.path()), mac_context(root.path()), windows_context(root.path())] {
            let plan = plan_uninstall(&ctx).unwrap();
            let mut allowed = vec![plan.layout.token.clone(), plan.layout.binary.clone(), plan.layout.agent_dir.clone()];
            if let Some(service) = &plan.layout.service_file {
                allowed.push(service.clone());
            }
            if let Some(parent) = plan.layout.agent_dir.parent() {
                allowed.push(parent.to_path_buf());
            }
            for step in &plan.steps {
                match step {
                    Step::RemoveFile { path } | Step::RemoveDirIfEmpty { path } => {
                        assert!(allowed.contains(path), "{:?} would remove {}", ctx.platform, path.display());
                    }
                    Step::Run { .. } => {}
                    other => panic!("uninstall must not write anything: {other:?}"),
                }
            }
        }
    }

    #[test]
    fn uninstall_with_nothing_installed_succeeds() {
        let root = TempRoot::new("uninstall-empty");
        let ctx = linux_context(root.path());
        let mut runner = FakeRunner::default();
        let first = uninstall(&ctx, &mut runner).unwrap();
        assert!(first.contains("not installed"), "{first}");
        let second = uninstall(&ctx, &mut runner).unwrap();
        assert!(second.contains("not installed"), "{second}");
    }

    #[test]
    fn linux_dry_run_writes_nothing_outside_the_temporary_home() {
        let root = TempRoot::new("dry-run");
        let ctx = linux_context(root.path());
        let request = request(root.path());
        let before = fs::read_dir(root.path()).unwrap().count();
        let mut runner = FakeRunner::default();
        let text = install(&ctx, &request, true, &mut runner).unwrap();
        assert!(runner.calls.is_empty(), "a dry run must run no commands");
        assert!(!root.path().join("home").exists(), "a dry run must not create the home tree");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), before);
        assert!(!text.contains(TOKEN));
        assert!(text.contains("ExecStart=\"") && text.contains("--token-file"), "{text}");
        assert!(text.contains("enable --now remotehub-agent.service"), "{text}");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn linux_install_and_uninstall_round_trip_in_a_temporary_home() {
        let root = TempRoot::new("round-trip");
        let ctx = linux_context(root.path());
        write_exe(&ctx);
        let request = request(root.path());
        let home = root.path().join("home");

        let mut runner = FakeRunner::default();
        let message = install(&ctx, &request, false, &mut runner).unwrap();
        assert!(!message.contains(TOKEN), "{message}");
        assert!(message.contains("installed"), "{message}");

        let binary = home.join(".local/share/remotehub/agent/remotehub-agent");
        let token = home.join(".local/share/remotehub/agent/agent.token");
        let unit = home.join(".config/systemd/user").join(SERVICE_UNIT);
        assert_eq!(fs::read(&binary).unwrap(), b"ELF-test-binary");
        assert_eq!(fs::read_to_string(&token).unwrap(), TOKEN);
        let unit_text = fs::read_to_string(&unit).unwrap();
        assert!(!unit_text.contains(TOKEN));
        assert!(unit_text.contains(&format!("\"{}\"", token.display())));
        assert_eq!(
            runner.calls,
            vec![
                argv_of(&["systemctl", "--user", "stop", SERVICE_UNIT]),
                argv_of(&["systemctl", "--user", "daemon-reload"]),
                argv_of(&["loginctl", "enable-linger", "1000"]),
                argv_of(&["systemctl", "--user", "enable", "--now", SERVICE_UNIT]),
            ]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&token), 0o600);
            assert_eq!(mode(&binary), 0o755);
            assert_eq!(mode(&home.join(".local/share/remotehub/agent")), 0o700);
        }

        let mut stop_runner = FakeRunner::default();
        let removed = uninstall(&ctx, &mut stop_runner).unwrap();
        assert!(removed.starts_with("uninstalled"), "{removed}");
        assert!(!token.exists() && !binary.exists() && !unit.exists());
        assert!(!home.join(".local/share/remotehub/agent").exists());
        assert!(!home.join(".local/share/remotehub").exists());
        assert!(home.join(".config/systemd/user").is_dir(), "shared systemd directory is left in place");

        let again = uninstall(&ctx, &mut stop_runner).unwrap();
        assert!(again.contains("not installed"), "{again}");
    }

    #[test]
    fn required_command_failure_reports_and_keeps_written_files() {
        let root = TempRoot::new("bus-down");
        let ctx = linux_context(root.path());
        write_exe(&ctx);
        let mut runner = FakeRunner { calls: Vec::new(), fail_on: vec!["daemon-reload"] };
        let error = install(&ctx, &request(root.path()), false, &mut runner).unwrap_err();
        assert!(error.to_string().contains("daemon-reload"), "{error}");
        assert!(error.to_string().contains("Failed to connect to bus"), "{error}");
        assert!(error.to_string().contains("run install again"), "{error}");
        let home = root.path().join("home");
        assert!(home.join(".local/share/remotehub/agent/agent.token").is_file());
        assert!(home.join(".config/systemd/user").join(SERVICE_UNIT).is_file());
    }

    #[test]
    fn ignored_stop_failure_does_not_abort_install() {
        let root = TempRoot::new("stop-fails");
        let ctx = linux_context(root.path());
        write_exe(&ctx);
        let mut runner = FakeRunner { calls: Vec::new(), fail_on: vec!["stop"] };
        assert!(install(&ctx, &request(root.path()), false, &mut runner).is_ok());
    }

    #[test]
    #[cfg(not(windows))]
    fn service_file_paths_are_quoted_when_they_contain_spaces() {
        let root = TempRoot::new("space-path");
        let mut ctx = mac_context(root.path());
        ctx.dirs.home = Some(root.path().join("Home Dir"));
        let plan = plan_install(&ctx, &request(root.path())).unwrap();
        let plist = text_of(&plan).remove(0);
        assert!(plist.contains("<string>"), "{plist}");
        assert!(plist.contains(&format!("{}/Library/Application Support/RemoteHub/agent/agent.token", root.path().join("Home Dir").display())));
    }

    #[test]
    fn interpret_status_reads_each_platform() {
        let ok = |stdout: &str| Ok(CommandOutcome { success: true, stdout: stdout.into(), stderr: String::new() });
        let failed = || Ok(CommandOutcome { success: false, stdout: String::new(), stderr: String::new() });
        assert_eq!(interpret_status(Platform::Linux, ok("active\n")), "active");
        assert_eq!(interpret_status(Platform::Linux, ok("inactive\n")), "inactive");
        assert!(interpret_status(Platform::Linux, Ok(CommandOutcome {
            success: false,
            stdout: String::new(),
            stderr: "Failed to connect to bus: No medium found\n".into(),
        }))
        .starts_with("unknown (Failed to connect"));
        assert_eq!(interpret_status(Platform::MacOs, ok("gui/501/x = {\n\tstate = running\n}\n")), "running");
        assert_eq!(interpret_status(Platform::MacOs, failed()), "not loaded");
        assert_eq!(interpret_status(Platform::Windows, ok("Status:          Running\n")), "Running");
        assert_eq!(interpret_status(Platform::Windows, failed()), "not registered");
        assert!(interpret_status(Platform::Linux, Err(io::Error::new(io::ErrorKind::NotFound, "systemctl"))).starts_with("unknown"));
    }

    #[test]
    fn status_reports_missing_files_without_touching_them() {
        let root = TempRoot::new("status");
        let ctx = linux_context(root.path());
        let mut runner = FakeRunner::default();
        let text = status(&ctx, &mut runner).unwrap();
        assert!(text.contains("(missing)"), "{text}");
        assert_eq!(runner.calls, vec![argv_of(&["systemctl", "--user", "is-active", SERVICE_UNIT])]);
        assert!(!root.path().join("home").exists());
    }
}
