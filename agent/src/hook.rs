//! `forgeline-agent hook <agent> [payload]`: the entry point coding agents run for every hook event (section 8.1).
//!
//! The contract with the coding agent is absolute: **return in milliseconds, exit 0, print nothing on stdout.**
//! Claude Code treats a hook's stdout as context or as a decision depending on the event, and a non-zero exit as
//! a failure it may show the model or the user; a slow hook stalls the session. So this path:
//! - never starts an async runtime and never reads the config;
//! - reads stdin with a deadline (and not at all from a terminal);
//! - hands the report to the daemon over the local socket with a short timeout, or spools it if that fails;
//! - writes any problem to `log/hook.log`, never to stdout or stderr;
//! - catches panics, and exits 0 whatever happened.
//!
//! Codex's `notify` passes its JSON as the last argument instead of on stdin, hence the optional `payload`.

use std::io::{IsTerminal, Read};
use std::sync::mpsc;
use std::time::Duration;

use crate::config::Agent;
use crate::local_api::{self, HookReport, Request};
use crate::paths::{self, Dirs};
use crate::spool::{Item, Spool};
use crate::state::StateDir;
use crate::time;

const STDIN_DEADLINE: Duration = Duration::from_millis(1500);
const DAEMON_TIMEOUT: Duration = Duration::from_millis(300);

/// Run the hook. The return value is the process exit code, and it is always 0.
pub fn main(args: &[String]) -> i32 {
    // The default panic hook prints to stderr; route it to the log like everything else.
    std::panic::set_hook(Box::new(|info| log(&format!("panic: {info}"))));
    let _ = std::panic::catch_unwind(|| {
        if let Err(e) = run(args) {
            log(&format!(
                "hook {}: {e}",
                args.first().map_or("", String::as_str)
            ));
        }
    });
    0
}

fn run(args: &[String]) -> Result<(), String> {
    let agent = args
        .first()
        .and_then(|a| Agent::parse(a))
        .ok_or("expected `hook claude|codex|cursor`")?;
    let raw = match args.get(1) {
        Some(arg) => arg.clone().into_bytes(),
        None => read_stdin(),
    };
    let report = report(agent, &raw, time::now_ms());
    let dirs = Dirs::from_env()?;
    let state = StateDir::open(&dirs.state).map_err(|e| e.to_string())?;
    let req = Request::Hook { report };
    match local_api::request(&state.socket(), &req, DAEMON_TIMEOUT) {
        Ok(resp) if resp.ok => return Ok(()),
        // The daemon is down, busy, or said no: keep the report for it rather than lose it.
        Ok(resp) => log(&format!(
            "daemon refused the report ({}); spooling it",
            resp.error.unwrap_or_default()
        )),
        Err(_) => {}
    }
    let Request::Hook { report } = req else {
        unreachable!()
    };
    Spool::new(&state.spool_dir())
        .push(&Item::Hook(report), time::now_ms())
        .map(|_| ())
        .map_err(|e| format!("could not spool the report: {e}"))
}

/// Read stdin up to [`local_api::MAX_REQUEST`] bytes or until [`STDIN_DEADLINE`]. Coding agents write the JSON and
/// close the pipe at once; a terminal, or a pipe nobody closes, must not hang the session.
fn read_stdin() -> Vec<u8> {
    if std::io::stdin().is_terminal() {
        return Vec::new();
    }
    let (tx, rx) = mpsc::channel();
    // Detached on purpose: if the deadline passes, the process exits and takes the reader with it.
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::stdin()
            .take(local_api::MAX_REQUEST as u64)
            .read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    rx.recv_timeout(STDIN_DEADLINE).unwrap_or_default()
}

/// Build a report from whatever the agent sent. The field names differ per agent; anything not found stays
/// `None`, and the whole payload is kept for the daemon (P5 turns it into events).
pub fn report(agent: Agent, raw: &[u8], at: i64) -> HookReport {
    let payload: serde_json::Value = serde_json::from_slice(raw).unwrap_or(serde_json::Value::Null);
    let first = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| payload.get(*k).and_then(|v| v.as_str()).map(str::to_string))
    };
    let (hook, session, cwd) = match agent {
        Agent::Claude => (
            first(&["hook_event_name"]),
            first(&["session_id"]),
            first(&["cwd"]),
        ),
        Agent::Codex => (
            first(&["type", "hook_event_name"]),
            first(&["thread-id", "thread_id", "session_id"]),
            first(&["cwd"]),
        ),
        Agent::Cursor => (
            first(&["hook_event_name"]),
            first(&["conversation_id", "session_id"]),
            payload
                .get("workspace_roots")
                .and_then(|r| r.get(0))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| first(&["cwd"])),
        ),
    };
    HookReport {
        agent,
        at,
        hook,
        session,
        cwd,
        payload,
    }
}

/// Best effort: a hook has nowhere else to complain, and must not complain on stdout or stderr.
fn log(line: &str) {
    if let Ok(dirs) = Dirs::from_env() {
        let _ = paths::append_private(
            &StateDir::at(&dirs.state).log_dir().join("hook.log"),
            &format!("{} {line}", time::fmt_utc(time::now_ms())),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_claude_fields() {
        let r = report(
            Agent::Claude,
            br#"{"session_id":"abc","cwd":"/w","hook_event_name":"Stop","transcript_path":"/t"}"#,
            7,
        );
        assert_eq!(
            (
                r.hook.as_deref(),
                r.session.as_deref(),
                r.cwd.as_deref(),
                r.at
            ),
            (Some("Stop"), Some("abc"), Some("/w"), 7)
        );
        assert_eq!(r.payload["transcript_path"], "/t");
    }

    #[test]
    fn extracts_codex_notify_fields() {
        let r = report(
            Agent::Codex,
            br#"{"type":"agent-turn-complete","thread-id":"t1","cwd":"/w"}"#,
            0,
        );
        assert_eq!(
            (r.hook.as_deref(), r.session.as_deref(), r.cwd.as_deref()),
            (Some("agent-turn-complete"), Some("t1"), Some("/w"))
        );
    }

    #[test]
    fn extracts_cursor_fields() {
        let r = report(
            Agent::Cursor,
            br#"{"conversation_id":"c1","hook_event_name":"stop","workspace_roots":["/w"]}"#,
            0,
        );
        assert_eq!(
            (r.hook.as_deref(), r.session.as_deref(), r.cwd.as_deref()),
            (Some("stop"), Some("c1"), Some("/w"))
        );
    }

    #[test]
    fn garbage_is_kept_as_an_empty_report() {
        let r = report(Agent::Claude, b"not json", 0);
        assert_eq!(
            (r.hook, r.session, r.payload),
            (None, None, serde_json::Value::Null)
        );
    }
}
