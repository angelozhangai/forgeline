//! `forgeline-agent status` (facts) and `forgeline-agent doctor` (checks, in words, with what to do about each).
//!
//! Both are read-only: they create nothing, so running them on a machine that was never set up is harmless and
//! says so. Neither reads the device key unless the device is enrolled (a Keychain read can prompt the user).

use std::fmt::Write as _;
use std::path::Path;
use std::time::Duration;

use crate::config::Config;
use crate::keystore;
use crate::local_api::{self, DaemonStatus, Request};
use crate::paths::Dirs;
use crate::service::Platform;
use crate::spool::Spool;
use crate::state::{self, PauseState, StateDir};
use crate::time;
use crate::trust::Trust;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub level: Level,
    pub text: String,
}

fn check(level: Level, text: impl Into<String>) -> Check {
    Check {
        level,
        text: text.into(),
    }
}

fn daemon_status(state: &StateDir) -> Result<DaemonStatus, String> {
    let resp = local_api::request(&state.socket(), &Request::Status, Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    resp.status.ok_or_else(|| {
        resp.error
            .unwrap_or_else(|| "no status in the answer".into())
    })
}

/// Longest socket path the platform accepts (`sun_path` is 104 bytes on macOS, 108 on Linux, NUL included).
const MAX_SOCKET_PATH: usize = if cfg!(target_os = "macos") { 103 } else { 107 };

pub fn checks(dirs: &Dirs) -> Vec<Check> {
    let mut out = Vec::new();
    let now = time::now_ms();
    let state = StateDir::at(&dirs.state);

    // Configuration and policy.
    let config = match Config::load(&dirs.config_file(), &dirs.home) {
        Ok((c, true)) => {
            out.push(check(
                Level::Ok,
                format!("config: {}", dirs.config_file().display()),
            ));
            Some(c)
        }
        Ok((c, false)) => {
            out.push(check(
                Level::Warn,
                format!(
                    "config: {} does not exist, so everything is off",
                    dirs.config_file().display()
                ),
            ));
            Some(c)
        }
        Err(e) => {
            out.push(check(Level::Fail, format!("config: {e}")));
            None
        }
    };
    if let Some(c) = &config {
        out.extend(policy_checks(c));
    }

    // State directory.
    if !dirs.state.exists() {
        out.push(check(
            Level::Warn,
            format!(
                "state: {} does not exist yet; `forgeline-agent run` creates it",
                dirs.state.display()
            ),
        ));
    } else {
        let problems = state.permission_problems();
        if problems.is_empty() {
            out.push(check(
                Level::Ok,
                format!("state: {} is private to this user", dirs.state.display()),
            ));
        }
        out.extend(
            problems
                .into_iter()
                .map(|p| check(Level::Fail, format!("state: {p}"))),
        );
    }
    let sock = state.socket();
    if sock.as_os_str().len() > MAX_SOCKET_PATH {
        out.push(check(Level::Fail, format!("socket: {} is longer than the {MAX_SOCKET_PATH} bytes a Unix socket path may have; set a shorter XDG_STATE_HOME", sock.display())));
    }

    // Enrolment and key.
    match Trust::load(&state) {
        Ok(Some(t)) => {
            out.push(check(
                Level::Ok,
                format!(
                    "enrolled: {} with {} ({} pinned cloud key{})",
                    t.device_id,
                    t.cloud,
                    t.keys.len(),
                    if t.keys.len() == 1 { "" } else { "s" }
                ),
            ));
            match keystore::for_platform(config.as_ref().and_then(|c| c.key_store), &state)
                .and_then(|s| s.load().map(|k| (k, s.describe())))
            {
                Ok((Some(_), place)) => out.push(check(Level::Ok, format!("device key: {place}"))),
                Ok((None, place)) => out.push(check(
                    Level::Fail,
                    format!("device key: none in {place}; enrol this device again"),
                )),
                Err(e) => out.push(check(Level::Fail, format!("device key: {e}"))),
            }
        }
        Ok(None) => out.push(check(
            Level::Fail,
            "enrolled: no -- `forgeline-agent enroll` arrives with device authentication (P2, #51)",
        )),
        Err(e) => out.push(check(Level::Fail, format!("enrolled: {e}"))),
    }

    // Daemon and connection.
    match daemon_status(&state) {
        Ok(d) => {
            out.push(check(
                Level::Ok,
                format!(
                    "daemon: running, pid {}, version {}, up since {}",
                    d.pid,
                    d.version,
                    time::fmt_utc(d.started_at)
                ),
            ));
            let detail = d.detail.map(|x| format!(": {x}")).unwrap_or_default();
            let level = if d.connection == "connected" {
                Level::Ok
            } else {
                Level::Fail
            };
            out.push(check(
                level,
                format!("connection: {}{detail}", d.connection.replace('_', " ")),
            ));
        }
        Err(_) => out.push(check(
            Level::Fail,
            "daemon: not running -- `forgeline-agent service install` starts it at login",
        )),
    }
    // Clock skew is measured from the cloud-dated `welcome`, which arrives with P2.

    match state::pause_state(&state) {
        PauseState::Running => out.push(check(Level::Ok, "paused: no")),
        PauseState::Paused(p) => out.push(check(
            Level::Warn,
            format!(
                "paused: yes{} -- every job is refused until `forgeline-agent resume`",
                pause_detail(p.as_ref(), now)
            ),
        )),
    }

    if dirs.state.exists() {
        match Spool::new(&state.spool_dir()).list() {
            Ok((items, bad)) => {
                if !bad.is_empty() {
                    out.push(check(
                        Level::Warn,
                        format!(
                            "spool: {} unreadable item(s) in {}",
                            bad.len(),
                            state.spool_dir().display()
                        ),
                    ));
                }
                if items.len() > 100 {
                    out.push(check(
                        Level::Warn,
                        format!(
                            "spool: {} items waiting -- is the daemon connected?",
                            items.len()
                        ),
                    ));
                }
            }
            Err(e) => out.push(check(Level::Fail, format!("spool: {e}"))),
        }
    }

    let unit = Platform::current().unit_path(dirs);
    if unit.exists() {
        out.push(check(Level::Ok, format!("service: {}", unit.display())));
    } else {
        out.push(check(
            Level::Warn,
            "service: not installed -- `forgeline-agent service install`",
        ));
    }
    out
}

fn policy_checks(c: &Config) -> Vec<Check> {
    let mut out = Vec::new();
    if c.cloud.is_none() {
        out.push(check(Level::Warn, "policy: no `cloud` configured"));
    }
    let actions = c.enabled_actions();
    let agents = c.enabled_agents();
    out.push(check(
        Level::Ok,
        format!(
            "policy: actions [{}], agents [{}], repos [{}]",
            actions.join(", "),
            agents
                .iter()
                .map(|a| a.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            c.repos.keys().cloned().collect::<Vec<_>>().join(", ")
        ),
    ));
    if (c.actions.session_reply || c.actions.session_start) && agents.is_empty() {
        out.push(check(
            Level::Warn,
            "policy: session actions are on but no agent is enabled, so they will all be refused",
        ));
    }
    if c.actions.session_start && !c.repos.values().any(|r| !r.start.is_empty()) {
        out.push(check(
            Level::Warn,
            "policy: session.start is on but no repo lists an agent in `start`",
        ));
    }
    for (alias, repo) in &c.repos {
        if !Path::new(&repo.path).is_dir() {
            out.push(check(
                Level::Warn,
                format!(
                    "policy: repos.{alias}.path {} is not a directory",
                    repo.path
                ),
            ));
        }
        for a in &repo.start {
            if !c.agent_enabled(*a) {
                out.push(check(Level::Warn, format!("policy: repos.{alias} lists {} in `start`, but [agents] does not enable it", a.as_str())));
            }
        }
    }
    out
}

fn pause_detail(p: Option<&state::Pause>, now: i64) -> String {
    match p {
        Some(p) => format!(" (by {}, {})", p.by.as_str(), time::fmt_relative(now, p.at)),
        None => " (the pause file is unreadable, which still counts as paused)".into(),
    }
}

/// `doctor`: one line per check; exit status 1 if any check failed.
pub fn doctor(dirs: &Dirs) -> (String, i32) {
    let all = checks(dirs);
    let mut s = String::new();
    for c in &all {
        let tag = match c.level {
            Level::Ok => "ok  ",
            Level::Warn => "warn",
            Level::Fail => "FAIL",
        };
        let _ = writeln!(s, "{tag}  {}", c.text);
    }
    let failed = all.iter().filter(|c| c.level == Level::Fail).count();
    let _ = writeln!(
        s,
        "\n{}",
        if failed == 0 {
            "doctor: all checks passed".to_string()
        } else {
            format!("doctor: {failed} check(s) failed")
        }
    );
    (s, i32::from(failed > 0))
}

/// `status`: the facts, without judging them.
pub fn status(dirs: &Dirs) -> String {
    let now = time::now_ms();
    let state = StateDir::at(&dirs.state);
    let mut s = String::new();
    let _ = writeln!(s, "forgeline-agent {}", crate::VERSION);
    let config = Config::load(&dirs.config_file(), &dirs.home);
    let _ = writeln!(
        s,
        "config:     {}{}",
        dirs.config_file().display(),
        match &config {
            Ok((_, true)) => String::new(),
            Ok((_, false)) => " (absent: everything is off)".into(),
            Err(e) => format!(" (unusable: {e})"),
        }
    );
    if let Ok((c, _)) = &config {
        let p = c.policy_summary();
        let list = |k: &str| {
            p[k].as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default()
        };
        let _ = writeln!(
            s,
            "policy:     actions [{}]; agents [{}]; repos [{}]",
            list("actions"),
            list("agents"),
            list("repos")
        );
        let _ = writeln!(
            s,
            "cloud:      {}",
            c.cloud.as_deref().unwrap_or("(not configured)")
        );
    }
    let _ = writeln!(s, "state:      {}", dirs.state.display());
    let enrolled = match Trust::load(&state) {
        Ok(Some(t)) => format!("yes, as {}", t.device_id),
        Ok(None) => "no (enrolment arrives in P2, #51)".into(),
        Err(e) => format!("unknown ({e})"),
    };
    let _ = writeln!(s, "enrolled:   {enrolled}");
    let paused = match state::pause_state(&state) {
        PauseState::Running => "no".to_string(),
        PauseState::Paused(p) => format!("yes{}", pause_detail(p.as_ref(), now)),
    };
    let _ = writeln!(s, "paused:     {paused}");
    match daemon_status(&state) {
        Ok(d) => {
            let _ = writeln!(
                s,
                "daemon:     running (pid {}, up {})",
                d.pid,
                time::fmt_relative(now, d.started_at).trim_end_matches(" ago")
            );
            let since = d
                .since
                .map(|t| format!(", {}", time::fmt_relative(now, t)))
                .unwrap_or_default();
            let _ = writeln!(
                s,
                "connection: {}{}{}",
                d.connection.replace('_', " "),
                d.detail.map(|x| format!(": {x}")).unwrap_or_default(),
                since
            );
        }
        Err(_) => {
            let _ = writeln!(s, "daemon:     not running");
        }
    }
    if dirs.state.exists() {
        let spool = Spool::new(&state.spool_dir());
        let _ = writeln!(s, "spool:      {} item(s) waiting", spool.len());
    }
    s
}
