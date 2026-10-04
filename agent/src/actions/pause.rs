//! `device.pause` (docs/cloud-agent.md section 6.1): stop this device from running anything the cloud sends.
//!
//! Always allowed, never rate limited, and accepted while already paused: pausing only ever reduces what a device
//! does, so no gate should stand between the owner and stopping it. There is deliberately no `device.resume` --
//! a compromised cloud (T4) can stop a device but never restart it. Only `forgeline-agent resume`, typed on the
//! device, removes the pause file.

use super::{Action, Ctx, JobResult};
use crate::config::Config;
use crate::state::{self, By};
use crate::wire::Body;

pub struct DevicePause;

impl Action for DevicePause {
    const KIND: &'static str = "device.pause";
    const PAUSABLE: bool = false;
    const RATE_LIMITED: bool = false;

    fn validate(params: &Body) -> Result<DevicePause, String> {
        match params.keys().next() {
            None => Ok(DevicePause),
            Some(k) => Err(format!("it takes no params, got `{k}`")),
        }
    }

    fn allowed(&self, _config: &Config) -> Result<(), String> {
        Ok(())
    }

    fn execute(self, ctx: &Ctx<'_>) -> JobResult {
        match state::pause(ctx.state, By::Cloud, Some(&ctx.job.job_id), ctx.now) {
            Ok(true) => {
                ctx.emit(
                    "device.paused",
                    serde_json::json!({ "by": By::Cloud.as_str() }),
                );
                JobResult::done(
                    "Paused. This device will refuse every job until someone runs `forgeline-agent resume` on it.",
                )
            }
            Ok(false) => JobResult::done(
                "Already paused; nothing changed. Only `forgeline-agent resume`, run on the device itself, lifts it.",
            ),
            Err(e) => JobResult::failed(
                super::Code::Internal,
                format!(
                    "Could not create the pause file ({e}), so the device is NOT paused. Stop the daemon on the machine itself."
                ),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{Fixture, job};
    use super::super::{Code, Status, run_job};
    use crate::spool::Item;
    use crate::state::{PauseState, pause_state};
    use serde_json::json;

    #[test]
    fn pauses_records_the_job_and_queues_one_event() {
        let f = Fixture::new();
        let j = job("device.pause", json!({}));
        let out = run_job(&f.ctx(&j, 2000));
        assert_eq!(
            (out.result.status, out.result.code, out.executed),
            (Status::Done, Code::Ok, true)
        );
        let PauseState::Paused(Some(p)) = pause_state(&f.state) else {
            panic!("not paused")
        };
        assert_eq!(p.job_id.as_deref(), Some(j.job_id.as_str()));
        let events = f.spool.events();
        assert_eq!(events.len(), 1);
        assert_eq!(
            (events[0].kind.as_str(), &events[0].data),
            ("device.paused", &json!({"by": "cloud"}))
        );

        // Again: still done, still paused, no second event.
        let again = job("device.pause", json!({}));
        assert_eq!(run_job(&f.ctx(&again, 3000)).result.code, Code::Ok);
        assert_eq!(
            f.spool
                .list()
                .unwrap()
                .0
                .iter()
                .filter(|(_, i)| matches!(i, Item::Event(_)))
                .count(),
            1
        );
    }

    #[test]
    fn needs_no_policy_and_ignores_the_rate_limit() {
        let mut f = Fixture::new();
        f.config.limits.jobs_per_hour = 0;
        let j = job("device.pause", json!({}));
        assert_eq!(run_job(&f.ctx(&j, 2000)).result.code, Code::Ok);
    }

    #[test]
    fn refuses_params_and_late_delivery() {
        let f = Fixture::new();
        let j = job("device.pause", json!({"resume_after": 60}));
        assert_eq!(run_job(&f.ctx(&j, 2000)).result.code, Code::InvalidParams);
        let j = job("device.pause", json!({}));
        assert_eq!(run_job(&f.ctx(&j, j.expires_at)).result.code, Code::Expired);
        assert_eq!(pause_state(&f.state), PauseState::Running);
    }
}
