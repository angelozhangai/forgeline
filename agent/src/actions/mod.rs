//! Typed actions (docs/cloud-agent.md section 6): the complete list of things the cloud can ask this device to do.
//!
//! Each action is a struct, a validator that builds it from `params`, a policy gate, and an executor. A job whose
//! kind is not in [`run_job`]'s match is rejected as `unsupported`; params that do not validate are rejected as
//! `invalid_params`. Neither is ever executed "best effort", and there is no fallback to anything shell-like:
//! adding a capability means adding a struct here, reviewed like any other code.
//!
//! The gates run in a fixed order, cheapest and least stateful first, so a job that fails several gets the same
//! answer every time (section 6 does not fix this order; reported as doc feedback):
//!
//! 1. `unsupported`     the kind is not one this device implements
//! 2. `invalid_params`  the params do not validate
//! 3. `expired`         now >= `expires_at` (section 5.8: a job may start only while now < `expires_at`)
//! 4. `paused`          the device is paused -- except `device.pause` itself
//! 5. `not_allowed`     the local policy does not allow it
//! 6. `rate_limited`    over `limits.jobs_per_hour` -- `device.pause` is never counted or refused
//! 7. execute

pub mod pause;

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::journal::Journal;
use crate::spool::{Event, Item, Spool};
use crate::state::{self, StateDir};
use crate::time::HOUR_MS;
use crate::wire::{Body, ulid};

/// Action kinds this build implements, reported as `auth.capabilities`.
pub const CAPABILITIES: [&str; 1] = [pause::DevicePause::KIND];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Done,
    Rejected,
    Failed,
}

/// Section 6.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    Ok,
    Paused,
    NotAllowed,
    UnknownSession,
    Unsupported,
    Expired,
    InvalidParams,
    RateLimited,
    UntrustedWorkspace,
    SessionNotWaiting,
    ExecFailed,
    Internal,
}

/// The body of a `result` frame, minus `job_id`. `message` is English written for the owner, who reads it in chat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobResult {
    pub status: Status,
    pub code: Code,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl JobResult {
    pub fn done(message: impl Into<String>) -> JobResult {
        JobResult {
            status: Status::Done,
            code: Code::Ok,
            message: message.into(),
            data: None,
        }
    }
    pub fn rejected(code: Code, message: impl Into<String>) -> JobResult {
        JobResult {
            status: Status::Rejected,
            code,
            message: message.into(),
            data: None,
        }
    }
    pub fn failed(code: Code, message: impl Into<String>) -> JobResult {
        JobResult {
            status: Status::Failed,
            code,
            message: message.into(),
            data: None,
        }
    }
}

/// A job body (section 5.6), validated. `params` stays untyped here: only the action's own validator reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub job_id: String,
    pub kind: String,
    pub attempt: i64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub origin_provider: String,
    pub origin_ref: String,
    pub params: Body,
}

/// Why a job body could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BadJob {
    /// No usable `job_id`: nothing can be acknowledged or answered. Logged locally; the cloud will expire the job
    /// and tell the owner nothing ran.
    Unanswerable(String),
    /// A valid `job_id` but a broken body: acknowledged and rejected as `invalid_params`.
    Invalid { job_id: String, why: String },
}

impl Job {
    pub fn from_body(body: &Body) -> Result<Job, BadJob> {
        let job_id = match body.get("job_id").and_then(|v| v.as_str()) {
            Some(id) if ulid::is_ulid(id) => id.to_string(),
            _ => {
                return Err(BadJob::Unanswerable(
                    "job_id is missing or not a ULID".into(),
                ));
            }
        };
        let invalid = |why: &str| BadJob::Invalid {
            job_id: job_id.clone(),
            why: why.to_string(),
        };
        let int = |k: &str| {
            body.get(k)
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| invalid(&format!("{k} is missing or not an integer")))
        };
        let kind = body
            .get("kind")
            .and_then(|v| v.as_str())
            .filter(|k| !k.is_empty() && k.len() <= 64)
            .ok_or_else(|| invalid("kind is missing"))?;
        let attempt = int("attempt")?;
        let issued_at = int("issued_at")?;
        let expires_at = int("expires_at")?;
        // Section 5.8: a job lives at most as long as the journal remembers it. One that outlived its own
        // deduplication record could be delivered again after the record is gone, and run twice.
        if expires_at - issued_at > crate::journal::RETENTION_MS {
            return Err(invalid("expires_at is more than 24 hours after issued_at"));
        }
        let origin = body
            .get("origin")
            .and_then(|v| v.as_object())
            .ok_or_else(|| invalid("origin is missing"))?;
        let field = |k: &str| {
            origin
                .get(k)
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .ok_or_else(|| invalid(&format!("origin.{k} is missing")))
        };
        let params = body
            .get("params")
            .and_then(|v| v.as_object())
            .cloned()
            .ok_or_else(|| invalid("params is missing or not an object"))?;
        Ok(Job {
            kind: kind.to_string(),
            attempt,
            issued_at,
            expires_at,
            origin_provider: field("provider")?,
            origin_ref: field("ref")?,
            params,
            job_id,
        })
    }
}

/// What an action may touch while it runs.
pub struct Ctx<'a> {
    pub state: &'a StateDir,
    pub config: &'a Config,
    pub journal: &'a Journal,
    pub spool: &'a Spool,
    pub now: i64,
    pub job: &'a Job,
}

impl Ctx<'_> {
    /// Queue an event for the cloud. A full spool is reported on stderr and does not fail the action: the action
    /// already happened, and its result -- which the owner does see -- says so.
    pub fn emit(&self, kind: &str, data: serde_json::Value) {
        if let Err(e) = self
            .spool
            .push(&Item::Event(Event::new(kind, self.now, data)), self.now)
        {
            eprintln!("forgeline-agent: could not queue the {kind} event: {e}");
        }
    }
}

pub trait Action: Sized {
    const KIND: &'static str;
    /// Whether a paused device refuses it. Only something that itself reduces what a device does may say no.
    const PAUSABLE: bool = true;
    /// Whether it counts towards, and is refused by, `limits.jobs_per_hour`.
    const RATE_LIMITED: bool = true;

    /// Build the action from `params`, or say what is wrong with them. Params are a closed schema: an unknown
    /// field is an error, not something to ignore.
    fn validate(params: &Body) -> Result<Self, String>;
    /// Whether the local policy allows this particular action. `Err` is the owner-facing reason.
    fn allowed(&self, config: &Config) -> Result<(), String>;
    fn execute(self, ctx: &Ctx<'_>) -> JobResult;
}

/// The outcome of the gates and the executor, and whether the executor ran (for the journal's rate count).
pub struct Outcome {
    pub result: JobResult,
    pub executed: bool,
}

/// Run one job through the gates and, if it passes, its executor.
pub fn run_job(ctx: &Ctx<'_>) -> Outcome {
    match ctx.job.kind.as_str() {
        pause::DevicePause::KIND => run::<pause::DevicePause>(ctx),
        other => Outcome {
            result: JobResult::rejected(
                Code::Unsupported,
                format!("This device does not implement `{other}`, so nothing ran."),
            ),
            executed: false,
        },
    }
}

pub fn run<A: Action>(ctx: &Ctx<'_>) -> Outcome {
    let refuse = |result: JobResult| Outcome {
        result,
        executed: false,
    };
    let action = match A::validate(&ctx.job.params) {
        Ok(a) => a,
        Err(why) => {
            return refuse(JobResult::rejected(
                Code::InvalidParams,
                format!(
                    "The `{}` request was malformed ({why}), so nothing ran.",
                    A::KIND
                ),
            ));
        }
    };
    if ctx.now >= ctx.job.expires_at {
        return refuse(JobResult::rejected(
            Code::Expired,
            "This instruction is more than 15 minutes old by the time it could run, so nothing ran. Send it again if you still want it.",
        ));
    }
    if A::PAUSABLE && state::pause_state(ctx.state).is_paused() {
        return refuse(JobResult::rejected(
            Code::Paused,
            "This device is paused, so nothing ran. Only `forgeline-agent resume`, run on the device itself, lifts the pause.",
        ));
    }
    if let Err(why) = action.allowed(ctx.config) {
        return refuse(JobResult::rejected(Code::NotAllowed, why));
    }
    if A::RATE_LIMITED {
        let limit = ctx.config.limits.jobs_per_hour as usize;
        if ctx.journal.executed_since(ctx.now - HOUR_MS) >= limit {
            return refuse(JobResult::rejected(
                Code::RateLimited,
                format!(
                    "This device already ran {limit} jobs in the last hour (its local limit), so nothing ran."
                ),
            ));
        }
    }
    Outcome {
        result: action.execute(ctx),
        executed: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::Entry;
    use serde_json::json;

    pub(crate) struct Fixture {
        pub dir: std::path::PathBuf,
        pub state: StateDir,
        pub config: Config,
        pub journal: Journal,
        pub spool: Spool,
    }

    impl Fixture {
        pub fn new() -> Fixture {
            let dir = std::env::temp_dir().join(format!(
                "fa-actions-{}-{}",
                std::process::id(),
                crate::b64::encode(&crate::wire::random_bytes::<6>())
            ));
            let state = StateDir::open(&dir).unwrap();
            let journal = Journal::open(&state.journal_dir(), 0).unwrap();
            let spool = Spool::new(&state.spool_dir());
            Fixture {
                dir,
                state,
                config: Config::default(),
                journal,
                spool,
            }
        }

        pub fn ctx<'a>(&'a self, job: &'a Job, now: i64) -> Ctx<'a> {
            Ctx {
                state: &self.state,
                config: &self.config,
                journal: &self.journal,
                spool: &self.spool,
                now,
                job,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    pub(crate) fn job(kind: &str, params: serde_json::Value) -> Job {
        Job {
            job_id: ulid::new(1000),
            kind: kind.into(),
            attempt: 1,
            issued_at: 1000,
            expires_at: 1000 + 900_000,
            origin_provider: "slack".into(),
            origin_ref: "slack:T:D:1".into(),
            params: params.as_object().unwrap().clone(),
        }
    }

    // A stand-in for a policy-gated action (session.reply and friends arrive in later phases), so the gate order
    // is pinned now rather than discovered when the first real one lands.
    struct Probe;
    impl Action for Probe {
        const KIND: &'static str = "test.probe";
        fn validate(params: &Body) -> Result<Probe, String> {
            if params.is_empty() {
                Ok(Probe)
            } else {
                Err("unexpected params".into())
            }
        }
        fn allowed(&self, config: &Config) -> Result<(), String> {
            if config.actions.session_reply {
                Ok(())
            } else {
                Err("not enabled".into())
            }
        }
        fn execute(self, _ctx: &Ctx<'_>) -> JobResult {
            JobResult::done("probed")
        }
    }

    fn code(f: &Fixture, job: &Job, now: i64) -> Code {
        run::<Probe>(&f.ctx(job, now)).result.code
    }

    #[test]
    fn unknown_kinds_are_unsupported_and_never_run() {
        let f = Fixture::new();
        for kind in [
            "device.resume",
            "shell.exec",
            "session.reply",
            "keys.update",
            "",
        ] {
            let j = job(kind, json!({}));
            let out = run_job(&f.ctx(&j, 1000));
            assert_eq!(
                (out.result.status, out.result.code, out.executed),
                (Status::Rejected, Code::Unsupported, false),
                "{kind}"
            );
        }
    }

    #[test]
    fn gates_run_in_order() {
        let mut f = Fixture::new();
        let ok = job("test.probe", json!({}));
        let bad = job("test.probe", json!({"x": 1}));
        let late = ok.expires_at + 1;
        // Everything wrong at once: params first.
        state::pause(&f.state, state::By::Local, None, 0).unwrap();
        assert_eq!(code(&f, &bad, late), Code::InvalidParams);
        assert_eq!(code(&f, &ok, late), Code::Expired);
        assert_eq!(
            code(&f, &ok, ok.expires_at),
            Code::Expired,
            "expired from expires_at on"
        );
        assert_eq!(
            code(&f, &ok, ok.expires_at - 1),
            Code::Paused,
            "one millisecond before is still in time"
        );
        std::fs::remove_file(f.state.paused_file()).unwrap();
        assert_eq!(code(&f, &ok, 1000), Code::NotAllowed);
        f.config.actions.session_reply = true;
        f.config.limits.jobs_per_hour = 1;
        assert_eq!(code(&f, &ok, 1000), Code::Ok);
        f.journal
            .record(Entry {
                job_id: ulid::new(1000),
                kind: "test.probe".into(),
                received_at: 1000,
                expires_at: None,
                executed: true,
                result: None,
            })
            .unwrap();
        assert_eq!(code(&f, &ok, 1000), Code::RateLimited);
        let later = Job {
            expires_at: 1000 + 2 * HOUR_MS,
            ..ok.clone()
        };
        assert_eq!(
            code(&f, &later, 1000 + HOUR_MS + 1),
            Code::Ok,
            "the window rolls"
        );
    }

    #[test]
    fn job_bodies_are_validated() {
        let body = |v: serde_json::Value| v.as_object().unwrap().clone();
        let good = json!({"job_id": "01M423B2F0ZQ7WE38ED5J4MYAE", "kind": "device.pause", "attempt": 1, "issued_at": 1, "expires_at": 2, "origin": {"provider": "slack", "ref": "r"}, "params": {}});
        let j = Job::from_body(&body(good.clone())).unwrap();
        assert_eq!(
            (j.kind.as_str(), j.origin_ref.as_str()),
            ("device.pause", "r")
        );
        let mut no_id = good.clone();
        no_id["job_id"] = json!("nope");
        assert!(matches!(
            Job::from_body(&body(no_id)),
            Err(BadJob::Unanswerable(_))
        ));
        let mut long_lived = good.clone();
        long_lived["expires_at"] = json!(1 + 86_400_000);
        assert!(
            Job::from_body(&body(long_lived)).is_ok(),
            "exactly 24 hours is allowed"
        );
        for (k, v) in [
            ("params", json!([])),
            ("expires_at", json!("soon")),
            ("expires_at", json!(2 + 86_400_000)),
            ("origin", json!({"provider": "slack"})),
            ("kind", json!("")),
        ] {
            let mut b = good.clone();
            b[k] = v;
            assert!(
                matches!(Job::from_body(&body(b)), Err(BadJob::Invalid { .. })),
                "{k}"
            );
        }
    }

    #[test]
    fn result_codes_are_spelled_as_in_the_design() {
        let all = [
            Code::Ok,
            Code::Paused,
            Code::NotAllowed,
            Code::UnknownSession,
            Code::Unsupported,
            Code::Expired,
            Code::InvalidParams,
            Code::RateLimited,
            Code::UntrustedWorkspace,
            Code::SessionNotWaiting,
            Code::ExecFailed,
            Code::Internal,
        ];
        let names: Vec<String> = all
            .iter()
            .map(|c| {
                serde_json::to_value(c)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            names,
            [
                "ok",
                "paused",
                "not_allowed",
                "unknown_session",
                "unsupported",
                "expired",
                "invalid_params",
                "rate_limited",
                "untrusted_workspace",
                "session_not_waiting",
                "exec_failed",
                "internal"
            ]
        );
    }
}
