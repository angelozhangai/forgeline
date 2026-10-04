//! The binary itself, run as users and coding agents run it, in a throwaway HOME. Nothing here loads a service,
//! touches the real Keychain, or reaches the network.

mod common;

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use common::TempDir;
use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_forgeline-agent");

struct Env {
    dir: TempDir,
}

impl Env {
    fn new() -> Env {
        let dir = TempDir::new("cli");
        fs::create_dir_all(dir.path().join("h")).unwrap();
        Env { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.path().join("h")
    }
    fn state(&self) -> PathBuf {
        self.dir.path().join("s/forgeline-agent")
    }
    fn config_file(&self) -> PathBuf {
        self.dir.path().join("c/forgeline-agent/config.toml")
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(BIN);
        c.args(args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home())
            .env("XDG_CONFIG_HOME", self.dir.path().join("c"))
            .env("XDG_STATE_HOME", self.dir.path().join("s"))
            .stdin(Stdio::null());
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().unwrap()
    }

    /// Run a hook with `stdin`, returning its output and how long it took.
    fn hook(&self, args: &[&str], stdin: &[u8]) -> (Output, Duration) {
        let started = Instant::now();
        let mut child = self
            .cmd(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin).unwrap();
        let out = child.wait_with_output().unwrap();
        (out, started.elapsed())
    }

    fn write_config(&self, text: &str) {
        fs::create_dir_all(self.config_file().parent().unwrap()).unwrap();
        fs::write(self.config_file(), text).unwrap();
        fs::set_permissions(self.config_file(), fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn spool(&self) -> Vec<Value> {
        let mut names: Vec<PathBuf> = fs::read_dir(self.state().join("spool"))
            .map(|d| d.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        names.sort();
        names
            .iter()
            .map(|p| serde_json::from_slice(&fs::read(p).unwrap()).unwrap())
            .collect()
    }

    fn daemon(&self) -> Daemon {
        let child = self
            .cmd(&["run"])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let sock = self.state().join("agent.sock");
        let deadline = Instant::now() + Duration::from_secs(10);
        while std::os::unix::net::UnixStream::connect(&sock).is_err() {
            assert!(
                Instant::now() < deadline,
                "the daemon did not open its socket"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        Daemon(child)
    }
}

struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn version_help_and_unknown_commands() {
    let env = Env::new();
    let out = env.run(&["version"]);
    assert_eq!(
        text(&out.stdout),
        format!("forgeline-agent {}\n", env!("CARGO_PKG_VERSION"))
    );
    assert!(text(&env.run(&["help"]).stdout).contains("service install"));
    let out = env.run(&["frobnicate"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out.stderr).contains("unknown command"));
    assert_eq!(env.run(&["service"]).status.code(), Some(2));
}

#[test]
fn enroll_is_a_stub_that_says_so_and_changes_nothing() {
    let env = Env::new();
    let out = env.run(&["enroll"]);
    assert_eq!(
        out.status.code(),
        Some(1),
        "a stub must not look like a successful enrolment"
    );
    assert!(text(&out.stderr).contains("P2"));
    assert!(!env.state().exists());
}

#[test]
fn status_and_doctor_on_a_fresh_machine_say_what_is_missing_and_create_nothing() {
    let env = Env::new();
    let out = env.run(&["status"]);
    assert!(out.status.success());
    let s = text(&out.stdout);
    for want in [
        "absent: everything is off",
        "actions []; agents []; repos []",
        "enrolled:   no",
        "paused:     no",
        "daemon:     not running",
    ] {
        assert!(s.contains(want), "status lacks {want:?}:\n{s}");
    }
    let out = env.run(&["doctor"]);
    assert_eq!(out.status.code(), Some(1));
    let d = text(&out.stdout);
    for want in [
        "warn  config:",
        "FAIL  enrolled: no",
        "FAIL  daemon: not running",
        "warn  service: not installed",
    ] {
        assert!(d.contains(want), "doctor lacks {want:?}:\n{d}");
    }
    assert!(!env.state().exists(), "status and doctor are read-only");
}

#[test]
fn pause_and_resume_are_local_switches_that_report_to_the_cloud() {
    let env = Env::new();
    let out = env.run(&["pause"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(text(&out.stdout).starts_with("Paused."));
    let paused = env.state().join("paused");
    assert_eq!(mode(&paused), 0o600);
    assert_eq!(mode(&env.state()), 0o700);
    assert!(text(&env.run(&["pause"]).stdout).contains("Already paused"));
    assert!(text(&env.run(&["status"]).stdout).contains("paused:     yes (by local"));
    assert!(text(&env.run(&["doctor"]).stdout).contains("warn  paused: yes"));

    let out = env.run(&["resume"]);
    assert!(out.status.success());
    assert!(!paused.exists());
    assert!(text(&env.run(&["resume"]).stdout).contains("Not paused"));

    let events: Vec<(String, String)> = env
        .spool()
        .iter()
        .map(|i| {
            (
                i["kind"].as_str().unwrap().to_string(),
                i["data"]["by"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        events,
        [
            ("device.paused".to_string(), "local".to_string()),
            ("device.resumed".to_string(), "local".to_string())
        ]
    );
    let audit = fs::read_to_string(env.state().join("log/audit.jsonl")).unwrap();
    assert_eq!(audit.lines().count(), 2);
}

#[test]
fn a_hook_without_a_daemon_is_silent_fast_and_spools_its_report() {
    let env = Env::new();
    let payload = br#"{"session_id":"6f1c2a9e-4b7d-4e2a-9c31-0d5e8f7a1b24","cwd":"/w","hook_event_name":"Stop"}"#;
    let (out, took) = env.hook(&["hook", "claude"], payload);
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty(), "stdout: {}", text(&out.stdout));
    assert!(out.stderr.is_empty(), "stderr: {}", text(&out.stderr));
    // Milliseconds in practice; the bound is loose so a busy CI runner does not flake.
    assert!(took < Duration::from_secs(1), "the hook took {took:?}");
    let spool = env.spool();
    assert_eq!(spool.len(), 1);
    assert_eq!(
        (
            spool[0]["item"].as_str(),
            spool[0]["agent"].as_str(),
            spool[0]["session"].as_str()
        ),
        (
            Some("hook"),
            Some("claude"),
            Some("6f1c2a9e-4b7d-4e2a-9c31-0d5e8f7a1b24")
        )
    );
}

#[test]
fn a_hook_exits_zero_and_prints_nothing_whatever_it_is_given() {
    let env = Env::new();
    for (args, stdin) in [
        (&["hook", "claude"][..], &b"not json at all"[..]),
        (&["hook", "vim"][..], &b"{}"[..]),
        (&["hook"][..], &b""[..]),
        (
            &[
                "hook",
                "codex",
                r#"{"type":"agent-turn-complete","thread-id":"t-1","cwd":"/w"}"#,
            ][..],
            &b""[..],
        ),
    ] {
        let (out, _) = env.hook(args, stdin);
        assert_eq!(out.status.code(), Some(0), "{args:?}");
        assert!(
            out.stdout.is_empty() && out.stderr.is_empty(),
            "{args:?}: {} {}",
            text(&out.stdout),
            text(&out.stderr)
        );
    }
    assert!(
        env.spool()
            .iter()
            .any(|i| i["agent"] == "codex" && i["session"] == "t-1"),
        "Codex's notify passes the payload as an argument"
    );
    assert!(
        fs::read_to_string(env.state().join("log/hook.log"))
            .unwrap()
            .contains("expected `hook claude|codex|cursor`")
    );

    // Even with no HOME at all there is nowhere to write, and still nothing is printed.
    let out = Command::new(BIN)
        .args(["hook", "claude"])
        .env_clear()
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
}

#[test]
fn the_daemon_serves_hooks_drains_the_spool_and_runs_once() {
    let env = Env::new();
    env.write_config("[agents]\nclaude = true\n");
    // A report spooled while the daemon was down...
    env.hook(
        &["hook", "claude"],
        br#"{"session_id":"early","hook_event_name":"Stop"}"#,
    );
    assert_eq!(env.spool().len(), 1);
    let _daemon = env.daemon();
    // ...is processed when it starts.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !env.state().join("sessions/claude.early.json").exists() {
        assert!(
            Instant::now() < deadline,
            "the spooled report was not drained"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(env.spool().is_empty());

    // A live report goes over the socket and is recorded at once; nothing is spooled.
    let (out, _) = env.hook(
        &["hook", "claude"],
        br#"{"session_id":"live","cwd":"/w","hook_event_name":"Stop"}"#,
    );
    assert!(out.status.success() && out.stdout.is_empty());
    let rec: Value =
        serde_json::from_slice(&fs::read(env.state().join("sessions/claude.live.json")).unwrap())
            .unwrap();
    assert_eq!(
        (rec["cwd"].as_str(), rec["hook"].as_str()),
        (Some("/w"), Some("Stop"))
    );
    assert!(env.spool().is_empty());

    // Reports from an agent the policy does not enable are accepted and ignored.
    env.hook(&["hook", "codex"], br#"{"thread-id":"off"}"#);
    assert!(!env.state().join("sessions/codex.off.json").exists());

    let s = text(&env.run(&["status"]).stdout);
    assert!(
        s.contains("daemon:     running") && s.contains("connection: not enrolled"),
        "{s}"
    );
    assert!(text(&env.run(&["doctor"]).stdout).contains("ok    daemon: running"));

    let second = env.run(&["run"]);
    assert_eq!(second.status.code(), Some(1));
    assert!(text(&second.stderr).contains("already listening"));
    assert_eq!(mode(&env.state().join("agent.sock")), 0o600);
}

#[test]
fn a_config_others_can_write_is_refused() {
    let env = Env::new();
    env.write_config("[actions]\n\"session.reply\" = true\n");
    fs::set_permissions(env.config_file(), fs::Permissions::from_mode(0o666)).unwrap();
    assert!(text(&env.run(&["status"]).stdout).contains("writable by group or others"));
    assert!(text(&env.run(&["doctor"]).stdout).contains("FAIL  config:"));
    let out = env.run(&["run"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out.stderr).contains("writable by group or others"));
}

#[test]
fn a_config_typo_is_an_error_not_a_silent_default() {
    let env = Env::new();
    env.write_config("[action]\n\"session.reply\" = true\n");
    let out = env.run(&["run"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        text(&out.stderr).contains("action"),
        "{}",
        text(&out.stderr)
    );
}

#[test]
fn service_units_are_printed_installed_and_removed_without_loading() {
    let env = Env::new();
    let out = env.run(&["service", "print"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let unit = text(&out.stdout);
    let exe = fs::canonicalize(BIN).unwrap();
    assert!(
        unit.contains(&*exe.to_string_lossy()),
        "the unit runs this binary:\n{unit}"
    );
    assert!(
        unit.contains(&*env.dir.path().join("s").to_string_lossy()),
        "the unit carries XDG_STATE_HOME:\n{unit}"
    );
    if cfg!(target_os = "macos") {
        let plist = env.dir.path().join("unit.plist");
        fs::write(&plist, &unit).unwrap();
        let lint = Command::new("plutil")
            .arg("-lint")
            .arg(&plist)
            .output()
            .unwrap();
        assert!(lint.status.success(), "{}", text(&lint.stdout));
    } else {
        assert!(unit.contains("[Service]") && unit.contains("WantedBy=default.target"));
    }

    let out = env.run(&["service", "install", "--no-load"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let path = if cfg!(target_os = "macos") {
        env.home()
            .join("Library/LaunchAgents/forgeline-agent.plist")
    } else {
        env.dir
            .path()
            .join("c/systemd/user/forgeline-agent.service")
    };
    assert_eq!(fs::read_to_string(&path).unwrap(), unit);
    assert!(text(&env.run(&["doctor"]).stdout).contains("ok    service:"));
    let out = env.run(&["service", "uninstall", "--no-unload"]);
    assert!(out.status.success());
    assert!(!path.exists());
}
