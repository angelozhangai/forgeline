//! The device side of an established connection: verify every frame, run jobs through the journal and the action
//! gates, acknowledge and answer them, and send spooled events until the cloud acknowledges them.
//!
//! Synchronous and socket-free on purpose: [`Device::on_frame`] takes a frame's text and returns the frames to send,
//! so the whole job path is tested with the golden fixtures and no network (tests/device.rs), and the socket loop
//! in `client.rs` stays a dumb pipe.

use std::collections::HashSet;

use ed25519_dalek::SigningKey;
use serde_json::json;

use crate::actions::{self, BadJob, Code, Ctx, Job, JobResult, Status};
use crate::client::Step;
use crate::config::Config;
use crate::journal::{Entry, Journal};
use crate::spool::Spool;
use crate::state::{self, Audit, StateDir};
use crate::wire::{self, Draft, Envelope, Keyring, RejectCode, Verifier, ulid};

pub type Clock = Box<dyn Fn() -> i64>;

pub struct Device {
    id: String,
    key: SigningKey,
    verifier: Verifier,
    state: StateDir,
    config: Config,
    journal: Journal,
    spool: Spool,
    clock: Clock,
    /// Events sent on the current connection and not yet acknowledged. Cleared on reconnect, so every unacked
    /// event is sent again on the next connection (at least once; the cloud deduplicates by `event_id`).
    sent: HashSet<String>,
}

impl Device {
    /// `cloud_keys` are the pinned cloud keys (from `trust.json`); `key` is this device's own signing key.
    pub fn new(
        id: &str,
        key: SigningKey,
        cloud_keys: Keyring,
        state: StateDir,
        config: Config,
        clock: Clock,
    ) -> std::io::Result<Device> {
        let journal = Journal::open(&state.journal_dir(), clock())?;
        let spool = Spool::new(&state.spool_dir());
        Ok(Device {
            id: id.to_string(),
            key,
            verifier: Verifier::new(id, cloud_keys),
            state,
            config,
            journal,
            spool,
            clock,
            sent: HashSet::new(),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    fn seal(&self, kind: &str, re: Option<&str>, body: serde_json::Value) -> Option<String> {
        let now = (self.clock)();
        let serde_json::Value::Object(body) = body else {
            return None;
        };
        let draft = Draft {
            kind: kind.into(),
            id: ulid::new(now),
            ts: now,
            from: self.id.clone(),
            to: "cloud".into(),
            re: re.map(str::to_string),
            body,
        };
        match wire::seal(&draft, &self.key) {
            Ok(f) => Some(f),
            Err(e) => {
                // Only a bug can get here (a body the protocol cannot carry); say so rather than send nothing quietly.
                self.audit(
                    "send",
                    "error",
                    Some(&format!("could not seal a {kind} frame: {e}")),
                    re,
                );
                None
            }
        }
    }

    fn audit(&self, action: &str, outcome: &str, reason: Option<&str>, reference: Option<&str>) {
        let entry = Audit {
            at: (self.clock)(),
            actor: "cloud",
            action,
            outcome,
            reason,
            reference,
        };
        if let Err(e) = state::audit(&self.state, &entry) {
            eprintln!("forgeline-agent: could not write the audit log: {e}");
        }
    }

    /// Called once the handshake is done: a new connection, so every unacknowledged event goes out again.
    pub fn on_open(&mut self) -> Vec<String> {
        self.sent.clear();
        self.pending_events()
    }

    /// Event frames for spooled events not yet sent on this connection. Each attempt is a new envelope (new id,
    /// new ts, new signature) carrying the same `event_id` (section 5.7).
    pub fn pending_events(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        for e in self.spool.events() {
            if self.sent.contains(&e.event_id) {
                continue;
            }
            if let Some(f) = self.seal(
                "event",
                None,
                json!({ "event_id": e.event_id, "kind": e.kind, "at": e.at, "data": e.data }),
            ) {
                self.sent.insert(e.event_id.clone());
                out.push(f);
            }
        }
        out
    }

    pub fn on_frame(&mut self, raw: &str) -> Step {
        let now = (self.clock)();
        let env = match self.verifier.verify(raw, now) {
            Ok(env) => env,
            Err(rej) => {
                self.audit(
                    "frame",
                    "rejected",
                    Some(&format!("{}: {}", rej.code.as_str(), rej.why)),
                    None,
                );
                // Section 5.9: malformed and non_canonical close the connection with 4000 after a signed error.
                // The other codes are about an individual frame from a sender that may be honest (a clock off by
                // six minutes, a retry that crossed a reconnect): drop the frame and keep the connection.
                return match rej.code {
                    RejectCode::Malformed | RejectCode::NonCanonical => Step::Close {
                        code: 4000,
                        reason: rej.code.as_str().into(),
                        send: self.seal("error", None, json!({ "code": rej.code.as_str(), "message": format!("Frame refused: {}.", rej.why) })).into_iter().collect(),
                    },
                    _ => Step::Send(vec![]),
                };
            }
        };
        match env.kind.as_str() {
            "job" => Step::Send(self.on_job(&env)),
            "ack" => {
                if let Some(key) = env.body.get("key").and_then(|k| k.as_str()) {
                    if let Err(e) = self.spool.remove(key) {
                        eprintln!("forgeline-agent: could not drop acknowledged event {key}: {e}");
                    }
                    self.sent.remove(key);
                }
                Step::Send(vec![])
            }
            "error" => {
                let code = env.body.get("code").and_then(|c| c.as_str()).unwrap_or("?");
                self.audit("cloud_error", "error", Some(code), Some(&env.id));
                Step::Send(vec![])
            }
            other => {
                // Handshake frames after the handshake, or a type from a newer protocol: verified, so not an attack,
                // but nothing to do with it.
                self.audit(
                    "frame",
                    "rejected",
                    Some(&format!("unexpected {other} frame")),
                    Some(&env.id),
                );
                Step::Send(vec![])
            }
        }
    }

    fn ack(&self, frame: &Envelope, key: &str) -> Option<String> {
        self.seal("ack", Some(&frame.id), json!({ "key": key }))
    }

    fn result(&self, frame: &Envelope, job_id: &str, r: &JobResult) -> Option<String> {
        let mut body =
            json!({ "job_id": job_id, "status": r.status, "code": r.code, "message": r.message });
        if let Some(data) = &r.data {
            body["data"] = data.clone();
        }
        self.seal("result", Some(&frame.id), body)
    }

    fn on_job(&mut self, frame: &Envelope) -> Vec<String> {
        let now = (self.clock)();
        let parsed = Job::from_body(&frame.body);
        let job_id = match &parsed {
            Ok(j) => j.job_id.clone(),
            Err(BadJob::Invalid { job_id, .. }) => job_id.clone(),
            Err(BadJob::Unanswerable(why)) => {
                self.audit(
                    "job",
                    "rejected",
                    Some(&format!("unusable job frame: {why}")),
                    Some(&frame.id),
                );
                return vec![];
            }
        };

        // A duplicate: acknowledge again, and answer again if it already has an answer. Never run it again.
        if let Some(entry) = self.journal.get(&job_id).cloned() {
            let mut out: Vec<String> = self.ack(frame, &job_id).into_iter().collect();
            let result = match entry.result {
                Some(r) => r,
                None => {
                    // Received, never finished: the daemon stopped mid-job. Running it now could run it twice.
                    let r = JobResult::failed(
                        Code::Internal,
                        "This device restarted while the job was running, so its outcome is unknown; it was not run again.",
                    );
                    self.finish(Entry {
                        result: Some(r.clone()),
                        ..entry
                    });
                    r
                }
            };
            out.extend(self.result(frame, &job_id, &result));
            self.audit(
                "job",
                "ok",
                Some("duplicate delivery; acknowledged and answered again, not run again"),
                Some(&job_id),
            );
            return out;
        }

        // Durable before acknowledged: if this fails, do not ack, and the cloud redelivers.
        let kind = match &parsed {
            Ok(j) => j.kind.clone(),
            Err(_) => frame
                .body
                .get("kind")
                .and_then(|k| k.as_str())
                .unwrap_or("unknown")
                .to_string(),
        };
        // Only a validated job's expiry extends how long its record is kept; an invalid one (say, rejected for
        // living longer than 24 hours) must not pin its entry for as long as it claims.
        let expires_at = parsed.as_ref().ok().map(|j| j.expires_at);
        let entry = Entry {
            job_id: job_id.clone(),
            kind: kind.clone(),
            received_at: now,
            expires_at,
            executed: false,
            result: None,
        };
        if let Err(e) = self.journal.record(entry.clone()) {
            self.audit(
                "job",
                "error",
                Some(&format!(
                    "could not journal the job, so it was not acknowledged: {e}"
                )),
                Some(&job_id),
            );
            return vec![];
        }
        let mut out: Vec<String> = self.ack(frame, &job_id).into_iter().collect();

        let (result, executed) = match &parsed {
            Ok(job) => {
                let ctx = Ctx {
                    state: &self.state,
                    config: &self.config,
                    journal: &self.journal,
                    spool: &self.spool,
                    now,
                    job,
                };
                let o = actions::run_job(&ctx);
                (o.result, o.executed)
            }
            Err(BadJob::Invalid { why, .. }) => (
                JobResult::rejected(
                    Code::InvalidParams,
                    format!("The job was malformed ({why}), so nothing ran."),
                ),
                false,
            ),
            Err(BadJob::Unanswerable(_)) => unreachable!("returned above"),
        };
        self.finish(Entry {
            executed,
            result: Some(result.clone()),
            ..entry
        });
        let outcome = match result.status {
            Status::Done => "ok",
            Status::Rejected => "rejected",
            Status::Failed => "error",
        };
        let code = serde_json::to_value(result.code)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        self.audit(
            &format!("job {kind}"),
            outcome,
            Some(&format!("{code}: {}", result.message)),
            Some(&job_id),
        );
        out.extend(self.result(frame, &job_id, &result));
        // A job may have queued events (device.pause queues device.paused); send them now rather than next time.
        out.extend(self.pending_events());
        out
    }

    fn finish(&mut self, entry: Entry) {
        if let Err(e) = self.journal.record(entry) {
            // The job ran; only its record is missing. A redelivery will be answered "interrupted", never re-run.
            eprintln!("forgeline-agent: could not record a job result: {e}");
        }
    }

    /// Drop journal entries past their retention.
    pub fn maintain(&mut self) {
        self.journal.prune((self.clock)());
    }

    /// The `auth` body P2 will send: what this build implements and what the local policy allows.
    pub fn capabilities_and_policy(&self) -> (Vec<&'static str>, serde_json::Value) {
        (actions::CAPABILITIES.to_vec(), self.config.policy_summary())
    }
}
