//! The state directory (docs/cloud-agent.md section 8.3): mode 0700, and every file in it 0600.
//!
//! Also the pause switch, the record of reported sessions, and the device's own audit log -- the small pieces of
//! state that more than one process (daemon, hook, CLI) touches.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::Agent;
use crate::paths;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateDir {
    root: PathBuf,
}

const SUBDIRS: [&str; 4] = ["journal", "spool", "sessions", "log"];

impl StateDir {
    /// A handle without touching the disk (for `status` and `doctor`, which must not create anything).
    pub fn at(root: &Path) -> StateDir {
        StateDir {
            root: root.to_path_buf(),
        }
    }

    /// Create the directory tree with private permissions, or verify and tighten an existing one.
    pub fn open(root: &Path) -> io::Result<StateDir> {
        paths::ensure_private_dir(root)?;
        for sub in SUBDIRS {
            paths::ensure_private_dir(&root.join(sub))?;
        }
        Ok(StateDir::at(root))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn trust_file(&self) -> PathBuf {
        self.root.join("trust.json")
    }
    pub fn device_key_file(&self) -> PathBuf {
        self.root.join("device.key")
    }
    pub fn paused_file(&self) -> PathBuf {
        self.root.join("paused")
    }
    pub fn journal_dir(&self) -> PathBuf {
        self.root.join("journal")
    }
    pub fn spool_dir(&self) -> PathBuf {
        self.root.join("spool")
    }
    pub fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }
    pub fn log_dir(&self) -> PathBuf {
        self.root.join("log")
    }
    pub fn socket(&self) -> PathBuf {
        self.root.join("agent.sock")
    }

    /// Problems with the permissions of the tree, in words. Empty = fine. Read-only.
    pub fn permission_problems(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut check = |p: PathBuf, dir: bool| match fs::metadata(&p) {
            Ok(meta) => {
                if dir && !meta.is_dir() {
                    out.push(format!("{} is not a directory", p.display()));
                } else if let Some(why) = paths::not_private(&p, &meta) {
                    out.push(why);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => out.push(format!("{}: {e}", p.display())),
        };
        check(self.root.clone(), true);
        for sub in SUBDIRS {
            check(self.root.join(sub), true);
        }
        for f in [
            self.trust_file(),
            self.device_key_file(),
            self.paused_file(),
        ] {
            check(f, false);
        }
        out
    }
}

// ---- Pause --------------------------------------------------------------------------------------------------

/// Who paused the device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum By {
    Local,
    Cloud,
}

impl By {
    pub fn as_str(self) -> &'static str {
        match self {
            By::Local => "local",
            By::Cloud => "cloud",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pause {
    pub by: By,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PauseState {
    Running,
    /// Paused. `None` when the file is there but cannot be read: still paused (fail closed).
    Paused(Option<Pause>),
}

impl PauseState {
    pub fn is_paused(&self) -> bool {
        matches!(self, PauseState::Paused(_))
    }
}

/// Whether the device is paused. Presence of the file is the whole switch; anything short of "definitely
/// absent" counts as paused, because a pause that silently stops working is worse than one that sticks.
pub fn pause_state(state: &StateDir) -> PauseState {
    let p = state.paused_file();
    match fs::symlink_metadata(&p) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => PauseState::Running,
        Err(_) => PauseState::Paused(None),
        Ok(_) => PauseState::Paused(
            fs::read(&p)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok()),
        ),
    }
}

/// Pause the device. `Ok(false)` if it was already paused (the original record is kept: who paused it first is
/// the useful fact). There is deliberately no counterpart here: removing the file is the local `resume` command
/// alone (`cli.rs`), so no code path reachable from the cloud can lift a pause.
pub fn pause(state: &StateDir, by: By, job_id: Option<&str>, now: i64) -> io::Result<bool> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let record = Pause {
        by,
        at: now,
        job_id: job_id.map(str::to_string),
    };
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(state.paused_file())
    {
        Ok(mut f) => {
            // If this write fails the empty file still pauses the device; report the error anyway.
            f.write_all(&serde_json::to_vec(&record).map_err(io::Error::other)?)?;
            Ok(true)
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

// ---- Sessions ------------------------------------------------------------------------------------------------

/// A session this device has reported: the fact `session.reply` will gate on (P6), recorded from hook reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRecord {
    pub agent: Agent,
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook: Option<String>,
    pub last_report_at: i64,
}

/// Session ids become file names, so only a conservative alphabet is accepted (Claude and Codex use UUIDs).
pub fn is_session_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && !s.starts_with('.')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn session_file(state: &StateDir, agent: Agent, session: &str) -> PathBuf {
    state
        .sessions_dir()
        .join(format!("{}.{session}.json", agent.as_str()))
}

pub fn record_session(state: &StateDir, rec: &SessionRecord) -> io::Result<()> {
    if !is_session_id(&rec.session) {
        return Err(io::Error::other(format!(
            "not a usable session id: {:?}",
            rec.session
        )));
    }
    paths::write_private_unsynced(
        &session_file(state, rec.agent, &rec.session),
        &serde_json::to_vec(rec).map_err(io::Error::other)?,
    )
}

pub fn session(state: &StateDir, agent: Agent, session: &str) -> Option<SessionRecord> {
    if !is_session_id(session) {
        return None;
    }
    serde_json::from_slice(&fs::read(session_file(state, agent, session)).ok()?).ok()
}

/// Forget sessions not reported since `cutoff`. Returns how many were removed.
pub fn prune_sessions(state: &StateDir, cutoff: i64) -> usize {
    let Ok(entries) = fs::read_dir(state.sessions_dir()) else {
        return 0;
    };
    let mut n = 0;
    for e in entries.flatten() {
        let stale = fs::read(e.path())
            .ok()
            .and_then(|b| serde_json::from_slice::<SessionRecord>(&b).ok())
            .is_none_or(|r| r.last_report_at < cutoff);
        if stale && fs::remove_file(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

// ---- Audit ---------------------------------------------------------------------------------------------------

/// One line of `log/audit.jsonl`: what happened, on whose instruction, and how it ended. The device's own record,
/// independent of the cloud's (section 4.3, threat 7: if the cloud is ever compromised, this is what the owner
/// reads to reconstruct what ran).
#[derive(Debug, Clone, Serialize)]
pub struct Audit<'a> {
    pub at: i64,
    /// `local` (the CLI), `cloud` (a verified frame), `hook`, or `daemon`.
    pub actor: &'a str,
    pub action: &'a str,
    /// `ok`, `rejected` or `error`, as in the cloud's audit table.
    pub outcome: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'a str>,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<&'a str>,
}

pub fn audit_file(state: &StateDir) -> PathBuf {
    state.log_dir().join("audit.jsonl")
}

/// Append to the audit log. Failure is returned, and callers report it on stderr: losing the audit trail must
/// not be silent, but it must not stop a pause either.
pub fn audit(state: &StateDir, entry: &Audit<'_>) -> io::Result<()> {
    paths::append_private(
        &audit_file(state),
        &serde_json::to_string(entry).map_err(io::Error::other)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fa-state-{}-{}",
            std::process::id(),
            crate::b64::encode(&crate::wire::random_bytes::<6>())
        ));
        d.join("forgeline-agent")
    }

    #[test]
    fn creates_a_private_tree_and_tightens_an_existing_one() {
        let root = tmp();
        let s = StateDir::open(&root).unwrap();
        for d in [
            root.clone(),
            s.journal_dir(),
            s.spool_dir(),
            s.sessions_dir(),
            s.log_dir(),
        ] {
            assert_eq!(
                fs::metadata(&d).unwrap().permissions().mode() & 0o777,
                0o700,
                "{}",
                d.display()
            );
        }
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!s.permission_problems().is_empty());
        StateDir::open(&root).unwrap();
        assert!(s.permission_problems().is_empty());
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn pause_is_sticky_and_records_who() {
        let root = tmp();
        let s = StateDir::open(&root).unwrap();
        assert_eq!(pause_state(&s), PauseState::Running);
        assert!(pause(&s, By::Cloud, Some("01M423B2F0ZQ7WE38ED5J4MYAE"), 5).unwrap());
        assert!(
            !pause(&s, By::Local, None, 6).unwrap(),
            "a second pause changes nothing"
        );
        let PauseState::Paused(Some(p)) = pause_state(&s) else {
            panic!("not paused")
        };
        assert_eq!((p.by, p.at), (By::Cloud, 5));
        assert_eq!(
            fs::metadata(s.paused_file()).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn an_unreadable_or_garbage_pause_file_still_pauses() {
        let root = tmp();
        let s = StateDir::open(&root).unwrap();
        fs::write(s.paused_file(), b"not json").unwrap();
        assert_eq!(pause_state(&s), PauseState::Paused(None));
        fs::remove_file(s.paused_file()).unwrap();
        fs::create_dir(s.paused_file()).unwrap();
        assert!(pause_state(&s).is_paused(), "even a directory in its place");
        fs::remove_dir(s.paused_file()).unwrap();
        // Cannot even look: still paused. (Root ignores permissions, so this half only means something otherwise.)
        if paths::euid() != 0 {
            fs::set_permissions(&root, fs::Permissions::from_mode(0o000)).unwrap();
            let state = pause_state(&s);
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(state, PauseState::Paused(None));
        }
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn sessions_are_recorded_pruned_and_only_with_safe_ids() {
        let root = tmp();
        let s = StateDir::open(&root).unwrap();
        let rec = SessionRecord {
            agent: Agent::Claude,
            session: "6f1c2a9e-4b7d-4e2a-9c31-0d5e8f7a1b24".into(),
            cwd: Some("/x".into()),
            hook: Some("Stop".into()),
            last_report_at: 100,
        };
        record_session(&s, &rec).unwrap();
        assert_eq!(session(&s, Agent::Claude, &rec.session), Some(rec.clone()));
        assert_eq!(session(&s, Agent::Codex, &rec.session), None);
        for bad in ["../x", "", ".hidden", "a/b", "a b"] {
            assert!(
                record_session(
                    &s,
                    &SessionRecord {
                        session: bad.into(),
                        ..rec.clone()
                    }
                )
                .is_err(),
                "{bad:?}"
            );
        }
        assert_eq!(prune_sessions(&s, 100), 0);
        assert_eq!(prune_sessions(&s, 101), 1);
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn audit_lines_are_private_json() {
        let root = tmp();
        let s = StateDir::open(&root).unwrap();
        audit(
            &s,
            &Audit {
                at: 1,
                actor: "local",
                action: "pause",
                outcome: "ok",
                reason: None,
                reference: Some("x"),
            },
        )
        .unwrap();
        audit(
            &s,
            &Audit {
                at: 2,
                actor: "cloud",
                action: "job",
                outcome: "rejected",
                reason: Some("expired"),
                reference: None,
            },
        )
        .unwrap();
        let text = fs::read_to_string(audit_file(&s)).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["ref"], "x");
        assert_eq!(lines[1]["reason"], "expired");
        assert_eq!(
            fs::metadata(audit_file(&s)).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }
}
