//! The job path on the device, driven by the golden fixtures and with no network: verify -> journal -> ack ->
//! gates -> execute -> result, plus events and their acks. Every frame the device sends is checked by a verifier
//! playing the cloud, trusting only the device's test key.

mod common;

use common::{TempDir, device_id, fixture, key, keyring};
use forgeline_agent::client::Step;
use forgeline_agent::config::Config;
use forgeline_agent::device::Device;
use forgeline_agent::spool::Spool;
use forgeline_agent::state::{self, By, PauseState, StateDir};
use forgeline_agent::wire::{Body, Draft, Envelope, Verifier, seal, ulid};
use serde_json::{Value, json};

const NOW: i64 = 1_791_072_000_000;

struct Rig {
    _dir: TempDir,
    state: StateDir,
    device: Device,
    cloud: Verifier,
}

impl Rig {
    fn new() -> Rig {
        Rig::with_config(Config::default())
    }

    fn with_config(config: Config) -> Rig {
        let dir = TempDir::new("dev");
        let state = StateDir::open(&dir.path().join("state")).unwrap();
        let device = Device::new(
            &device_id(),
            key("device").signing(),
            keyring(&["cloud"]),
            state.clone(),
            config,
            Box::new(|| NOW),
        )
        .unwrap();
        Rig {
            _dir: dir,
            state,
            device,
            cloud: Verifier::new("cloud", keyring(&["device"])),
        }
    }

    /// Feed a frame; return what the device sent, each verified as the cloud would verify it.
    fn feed(&mut self, raw: &str) -> Vec<Envelope> {
        match self.device.on_frame(raw) {
            Step::Send(frames) => frames
                .iter()
                .map(|f| {
                    self.cloud
                        .verify(f, NOW)
                        .expect("the device sent a frame the cloud refuses")
                })
                .collect(),
            Step::Close { code, .. } => panic!("unexpected close {code}"),
        }
    }

    fn audit(&self) -> Vec<Value> {
        std::fs::read_to_string(state::audit_file(&self.state))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

/// A job from the cloud, sealed with the cloud test key. A fresh envelope id each time, as on every redelivery.
fn job(body: Value) -> String {
    let Value::Object(body) = body else { panic!() };
    let draft = Draft {
        kind: "job".into(),
        id: ulid::new(NOW),
        ts: NOW - 100,
        from: "cloud".into(),
        to: device_id(),
        re: None,
        body,
    };
    seal(&draft, &key("cloud").signing()).unwrap()
}

fn job_body(job_id: &str, kind: &str, expires_at: i64, params: Value) -> Value {
    json!({ "job_id": job_id, "kind": kind, "attempt": 1, "issued_at": NOW - 1000, "expires_at": expires_at, "origin": { "provider": "slack", "ref": "slack:T:D:1" }, "params": params })
}

fn kinds(frames: &[Envelope]) -> Vec<&str> {
    frames.iter().map(|f| f.kind.as_str()).collect()
}

#[test]
fn the_pause_fixture_is_acked_executed_answered_and_reported() {
    let mut rig = Rig::new();
    let f = fixture("job-device-pause");
    let job_frame: Value = serde_json::from_str(&f.frames[0]).unwrap();
    let job_id = job_frame["body"]["job_id"].as_str().unwrap();
    let out = rig.feed(&f.frames[0]);
    assert_eq!(kinds(&out), ["ack", "result", "event"]);
    let (ack, result, event) = (&out[0], &out[1], &out[2]);
    assert_eq!(ack.re.as_deref(), job_frame["id"].as_str());
    assert_eq!(ack.body["key"], job_id);
    assert_eq!(result.re.as_deref(), job_frame["id"].as_str());
    assert_eq!(
        (
            &result.body["job_id"],
            &result.body["status"],
            &result.body["code"]
        ),
        (&json!(job_id), &json!("done"), &json!("ok"))
    );
    assert!(
        result.body["message"]
            .as_str()
            .unwrap()
            .contains("forgeline-agent resume")
    );
    assert_eq!(
        (&event.body["kind"], &event.body["data"]),
        (&json!("device.paused"), &json!({"by": "cloud"}))
    );
    let PauseState::Paused(Some(p)) = state::pause_state(&rig.state) else {
        panic!("not paused")
    };
    assert_eq!((p.by, p.job_id.as_deref()), (By::Cloud, Some(job_id)));
    assert!(
        rig.audit().iter().any(|a| a["action"] == "job device.pause"
            && a["outcome"] == "ok"
            && a["ref"] == job_id)
    );
}

#[test]
fn a_redelivered_job_is_acked_and_answered_again_but_never_run_again() {
    let mut rig = Rig::new();
    let job_id = ulid::new(NOW);
    let body = job_body(&job_id, "device.pause", NOW + 60_000, json!({}));
    let first = rig.feed(&job(body.clone()));
    assert_eq!(kinds(&first), ["ack", "result", "event"]);
    let first_result = first[1].body.clone();

    // A new envelope with the same job_id is a redelivery (a lost ack, a reconnect): re-ack, re-send the stored
    // result. (The same envelope again would be a replay, refused before this point -- see the next test.)
    let again = rig.feed(&job(body));
    assert_eq!(kinds(&again), ["ack", "result"]);
    assert_eq!(again[0].body["key"], job_id.as_str());
    assert_eq!(again[1].body, first_result);
    assert_eq!(
        Spool::new(&rig.state.spool_dir()).events().len(),
        1,
        "no second device.paused event"
    );
}

#[test]
fn a_replayed_envelope_is_dropped_and_audited() {
    let mut rig = Rig::new();
    let f = fixture("job-device-pause");
    assert_eq!(rig.feed(&f.frames[0]).len(), 3);
    assert!(rig.feed(&f.frames[0]).is_empty());
    assert!(
        rig.audit()
            .iter()
            .any(|a| a["outcome"] == "rejected"
                && a["reason"].as_str().unwrap().starts_with("replay"))
    );
}

#[test]
fn an_unknown_kind_is_rejected_as_unsupported_and_journaled() {
    // session.reply is P6. Until then the device must say so -- not ignore it, not attempt it.
    let mut rig = Rig::new();
    let f = fixture("job-session-reply");
    let out = rig.feed(&f.frames[0]);
    assert_eq!(kinds(&out), ["ack", "result"]);
    assert_eq!(
        (&out[1].body["status"], &out[1].body["code"]),
        (&json!("rejected"), &json!("unsupported"))
    );
    assert_eq!(state::pause_state(&rig.state), PauseState::Running);
}

#[test]
fn bad_job_bodies_are_answered_when_they_can_be_and_never_run() {
    let mut rig = Rig::new();
    let job_id = ulid::new(NOW);
    let mut body = job_body(&job_id, "device.pause", NOW + 60_000, json!({}));
    body.as_object_mut().unwrap().remove("params");
    let out = rig.feed(&job(body));
    assert_eq!(kinds(&out), ["ack", "result"]);
    assert_eq!(out[1].body["code"], "invalid_params");

    let out = rig.feed(&job(job_body(
        &ulid::new(NOW),
        "device.pause",
        NOW + 60_000,
        json!({"for_minutes": 5}),
    )));
    assert_eq!(out[1].body["code"], "invalid_params");

    // No usable job_id: nothing can be acknowledged or answered. Logged, and the cloud will expire it.
    let out = rig.feed(&job(job_body(
        "not-a-ulid",
        "device.pause",
        NOW + 60_000,
        json!({}),
    )));
    assert!(out.is_empty());
    assert!(rig.audit().iter().any(|a| {
        a["reason"]
            .as_str()
            .is_some_and(|r| r.contains("unusable job frame"))
    }));
    assert_eq!(state::pause_state(&rig.state), PauseState::Running);
}

#[test]
fn an_expired_job_is_rejected_even_when_delivered_in_time() {
    let mut rig = Rig::new();
    let out = rig.feed(&job(job_body(
        &ulid::new(NOW),
        "device.pause",
        NOW - 1,
        json!({}),
    )));
    assert_eq!(out[1].body["code"], "expired");
    assert_eq!(state::pause_state(&rig.state), PauseState::Running);
}

#[test]
fn tampered_forged_misaddressed_and_stale_frames_are_dropped() {
    for name in [
        "reject-tampered-body",
        "reject-forged-signature",
        "reject-unknown-key",
        "reject-wrong-recipient",
        "reject-stale-past",
        "reject-stale-future",
    ] {
        let mut rig = Rig::new();
        let f = fixture(name);
        assert!(rig.feed(&f.frames[0]).is_empty(), "{name}");
        assert_eq!(
            state::pause_state(&rig.state),
            PauseState::Running,
            "{name}"
        );
        assert_eq!(rig.audit().len(), 1, "{name}: audited");
    }
}

#[test]
fn malformed_and_non_canonical_frames_close_the_connection_after_a_signed_error() {
    for (name, code) in [
        ("reject-whitespace", "non_canonical"),
        ("reject-not-json", "malformed"),
        ("reject-extra-field", "malformed"),
    ] {
        let mut rig = Rig::new();
        let f = fixture(name);
        let Step::Close {
            code: close, send, ..
        } = rig.device.on_frame(&f.frames[0])
        else {
            panic!("{name}: expected a close")
        };
        assert_eq!(close, 4000, "{name}");
        assert_eq!(send.len(), 1);
        let err = rig.cloud.verify(&send[0], NOW).unwrap();
        assert_eq!(
            (err.kind.as_str(), &err.body["code"]),
            ("error", &json!(code)),
            "{name}"
        );
    }
}

#[test]
fn events_are_resent_on_every_connection_until_acked() {
    let mut rig = Rig::new();
    let spool = Spool::new(&rig.state.spool_dir());
    let event = forgeline_agent::spool::Event::new("device.paused", NOW, json!({"by": "local"}));
    spool
        .push(&forgeline_agent::spool::Item::Event(event.clone()), NOW)
        .unwrap();

    let sent: Vec<Envelope> = rig
        .device
        .on_open()
        .iter()
        .map(|f| rig.cloud.verify(f, NOW).unwrap())
        .collect();
    assert_eq!(kinds(&sent), ["event"]);
    assert_eq!(sent[0].body["event_id"], event.event_id.as_str());
    assert!(
        rig.device.pending_events().is_empty(),
        "sent once per connection"
    );
    // A reconnect: sent again, as a new envelope with the same event_id.
    let again: Vec<Envelope> = rig
        .device
        .on_open()
        .iter()
        .map(|f| rig.cloud.verify(f, NOW).unwrap())
        .collect();
    assert_eq!(again[0].body["event_id"], event.event_id.as_str());
    assert_ne!(again[0].id, sent[0].id);

    let mut ack = Body::new();
    ack.insert("key".into(), event.event_id.clone().into());
    let ack = seal(
        &Draft {
            kind: "ack".into(),
            id: ulid::new(NOW),
            ts: NOW,
            from: "cloud".into(),
            to: device_id(),
            re: Some(again[0].id.clone()),
            body: ack,
        },
        &key("cloud").signing(),
    )
    .unwrap();
    assert!(rig.feed(&ack).is_empty());
    assert!(spool.events().is_empty());
    assert!(rig.device.on_open().is_empty());
}

#[test]
fn the_auth_report_names_capabilities_and_aliases_never_paths() {
    let config = Config::parse("[agents]\nclaude = true\n[actions]\n\"session.reply\" = true\n[repos.forgeline]\npath = \"/srv/secret-layout/forgeline\"\n", std::path::Path::new("/h")).unwrap();
    let rig = Rig::with_config(config);
    let (caps, policy) = rig.device.capabilities_and_policy();
    assert_eq!(caps, ["device.pause"]);
    assert_eq!(
        policy,
        json!({"actions": ["session.reply"], "repos": ["forgeline"], "agents": ["claude"]})
    );
    assert!(!policy.to_string().contains("secret-layout"));
}
