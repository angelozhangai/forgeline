//! The command line (docs/cloud-agent.md section 8.4). Hand-parsed: a dozen fixed commands do not need a parser
//! dependency, and the hook path in particular must start as fast as a process can.

use crate::paths::Dirs;
use crate::spool::{Event, Item, Spool};
use crate::state::{self, Audit, By, PauseState, StateDir};
use crate::{daemon, doctor, hook, service, time};

const USAGE: &str = "\
usage: forgeline-agent <command>

  status                       what this device is, in facts
  doctor                       check everything, in words; exit 1 if anything failed
  pause                        refuse every job from the cloud until `resume`
  resume                       lift a pause (only possible here, on the device itself)
  enroll                       enrol this device with forgeline Cloud (arrives in P2, #51)
  run                          the daemon (normally started by the service)
  hook <claude|codex|cursor>   hook entry point for a coding agent: reads the hook JSON
                               on stdin, always exits 0, never prints
  service install [--no-load]  install the launchd agent / systemd user unit and start it
  service uninstall [--no-unload]
  service print                show the unit this machine would get
  version
";

/// Run a command; the return value is the process exit code (0 ok, 1 failed, 2 usage).
pub fn main(args: Vec<String>) -> i32 {
    let cmd = args.first().map_or("", String::as_str);
    // The hook comes first and owns its own error handling: whatever happens, exit 0 and print nothing.
    if cmd == "hook" {
        return hook::main(&args[1..]);
    }
    let rest = &args[args.len().min(1)..];
    match cmd {
        "" | "help" | "--help" | "-h" => {
            print!("{USAGE}");
            0
        }
        "version" | "--version" | "-V" => {
            println!("forgeline-agent {}", crate::VERSION);
            0
        }
        "status" => with_dirs(|dirs| {
            print!("{}", doctor::status(dirs));
            0
        }),
        "doctor" => with_dirs(|dirs| {
            let (text, code) = doctor::doctor(dirs);
            print!("{text}");
            code
        }),
        "pause" => with_dirs(pause),
        "resume" => with_dirs(resume),
        "enroll" => {
            eprintln!(
                "forgeline-agent: enrolment arrives with device authentication (P2, #51).\n\
                 It will generate this device's key, register it with the cloud named in config.toml, and print a\n\
                 one-time code for the owner to confirm in chat. Nothing was changed."
            );
            1
        }
        "run" => with_dirs(|dirs| match daemon::run(dirs) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("forgeline-agent: {e}");
                1
            }
        }),
        "service" => with_dirs(|dirs| service_cmd(dirs, rest)),
        _ => {
            eprint!("forgeline-agent: unknown command {cmd:?}\n\n{USAGE}");
            2
        }
    }
}

fn with_dirs(f: impl FnOnce(&Dirs) -> i32) -> i32 {
    match Dirs::from_env() {
        Ok(d) => f(&d),
        Err(e) => {
            eprintln!("forgeline-agent: {e}");
            1
        }
    }
}

fn open_state(dirs: &Dirs) -> Result<StateDir, i32> {
    StateDir::open(&dirs.state).map_err(|e| {
        eprintln!(
            "forgeline-agent: state directory {}: {e}",
            dirs.state.display()
        );
        1
    })
}

/// Record a local change: queue the event for the cloud and write the audit line. Failures are reported, not
/// fatal -- the change itself already happened.
fn record_local(state: &StateDir, kind: &str, action: &str) {
    let now = time::now_ms();
    let event = Event::new(kind, now, serde_json::json!({ "by": By::Local.as_str() }));
    if let Err(e) = Spool::new(&state.spool_dir()).push(&Item::Event(event), now) {
        eprintln!("forgeline-agent: could not queue the {kind} event for the cloud: {e}");
    }
    if let Err(e) = state::audit(
        state,
        &Audit {
            at: now,
            actor: "local",
            action,
            outcome: "ok",
            reason: None,
            reference: None,
        },
    ) {
        eprintln!("forgeline-agent: could not write the audit log: {e}");
    }
}

fn pause(dirs: &Dirs) -> i32 {
    let state = match open_state(dirs) {
        Ok(s) => s,
        Err(code) => return code,
    };
    match state::pause(&state, By::Local, None, time::now_ms()) {
        Ok(true) => {
            record_local(&state, "device.paused", "pause");
            println!(
                "Paused. This device refuses every job from the cloud until you run `forgeline-agent resume` here."
            );
            0
        }
        Ok(false) => {
            println!("Already paused; nothing changed.");
            0
        }
        Err(e) => {
            eprintln!("forgeline-agent: could not pause: {e}");
            1
        }
    }
}

/// The only code that removes the pause file, and it is private to the CLI: the cloud has no `device.resume`, and
/// nothing reachable from a frame can call this (section 4.5: the cloud can never lift a local pause).
fn resume(dirs: &Dirs) -> i32 {
    let state = match open_state(dirs) {
        Ok(s) => s,
        Err(code) => return code,
    };
    if state::pause_state(&state) == PauseState::Running {
        println!("Not paused; nothing changed.");
        return 0;
    }
    let path = state.paused_file();
    let removed = if path.is_dir() {
        std::fs::remove_dir(&path)
    } else {
        std::fs::remove_file(&path)
    };
    match removed {
        Ok(()) => {
            record_local(&state, "device.resumed", "resume");
            println!("Resumed. Jobs the local policy allows will run again.");
            0
        }
        Err(e) => {
            eprintln!("forgeline-agent: could not remove {}: {e}", path.display());
            1
        }
    }
}

fn service_cmd(dirs: &Dirs, args: &[String]) -> i32 {
    let flag = |f: &str| args.iter().any(|a| a == f);
    let result = match args.first().map(String::as_str) {
        Some("install") => service::install(dirs, !flag("--no-load")),
        Some("uninstall") => service::uninstall(dirs, !flag("--no-unload")),
        Some("print") => service::print(dirs).map(|text| {
            print!("{text}");
            String::new()
        }),
        _ => {
            eprintln!(
                "usage: forgeline-agent service install [--no-load] | uninstall [--no-unload] | print"
            );
            return 2;
        }
    };
    match result {
        Ok(done) => {
            if !done.is_empty() {
                println!("{done}");
            }
            0
        }
        Err(e) => {
            eprintln!("forgeline-agent: {e}");
            1
        }
    }
}
