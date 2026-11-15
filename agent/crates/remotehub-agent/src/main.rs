//! Thin binary entry point: interpret the command line, then hand off to
//! [`remotehub_agent::lifecycle`]. All behavior lives in the library so it can be
//! unit tested without spawning a process.

use std::process::ExitCode;

use remotehub_agent::config::{self, Command};
use remotehub_agent::install;
use remotehub_agent::lifecycle;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match config::resolve(args, |key| std::env::var(key).ok()) {
        Ok(Command::Run(config)) => lifecycle::run(config),
        Ok(Command::Help) => {
            println!("{}", config::USAGE);
            ExitCode::SUCCESS
        }
        Ok(Command::Install(options)) => install::run_install(&options),
        Ok(Command::Uninstall) => install::run_uninstall(),
        Ok(Command::ServiceStatus) => install::run_status(),
        Ok(Command::Version) => {
            println!("{} {}", config::AGENT_NAME, config::AGENT_VERSION);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{}: {error}", config::AGENT_NAME);
            eprintln!();
            eprintln!("{}", config::USAGE);
            ExitCode::from(2)
        }
    }
}
