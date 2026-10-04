//! The job journal (docs/cloud-agent.md section 5.7): every `job_id` this device has received in the last 24 hours,
//! recorded **before** it is acknowledged, with its result once there is one.
//!
//! Delivery is at least once, so the same job can arrive many times (a lost ack, a reconnect, a cloud retry). The
//! journal is what turns that into "runs at most once": a duplicate is re-acknowledged and, if it already ran, its
//! stored result is sent again -- it is never executed a second time.
//!
//! One file per job (`journal/<job_id>.json`), written atomically, so a crash leaves either no entry or a whole one.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::actions::JobResult;
use crate::paths;
use crate::time::DAY_MS;
use crate::wire::ulid;

pub const RETENTION_MS: i64 = DAY_MS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub job_id: String,
    pub kind: String,
    pub received_at: i64,
    /// Kept so the entry outlives the job: see [`Journal::prune`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// Whether the job got past every gate and its executor ran. Rate limiting counts these.
    #[serde(default)]
    pub executed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<JobResult>,
}

pub struct Journal {
    dir: PathBuf,
    entries: HashMap<String, Entry>,
}

impl Journal {
    /// Load every entry and drop those older than 24 hours.
    pub fn open(dir: &Path, now: i64) -> io::Result<Journal> {
        let mut entries = HashMap::new();
        for e in fs::read_dir(dir)? {
            let path = e?.path();
            let Some(job_id) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".json"))
                .filter(|n| ulid::is_ulid(n))
            else {
                continue;
            };
            let entry = match fs::read(&path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Entry>(&b).ok())
            {
                Some(e) if e.job_id == job_id => e,
                // Unreadable: the job was received, and nothing says what happened to it. Keep it as received and
                // unfinished, so a redelivery is answered "interrupted" instead of running a second time. Its age
                // is unknown, so it is kept for a full retention period from now.
                _ => Entry {
                    job_id: job_id.to_string(),
                    kind: "unknown".into(),
                    received_at: now,
                    expires_at: None,
                    executed: true,
                    result: None,
                },
            };
            entries.insert(job_id.to_string(), entry);
        }
        let mut j = Journal {
            dir: dir.to_path_buf(),
            entries,
        };
        j.prune(now);
        Ok(j)
    }

    fn file(&self, job_id: &str) -> PathBuf {
        self.dir.join(format!("{job_id}.json"))
    }

    pub fn get(&self, job_id: &str) -> Option<&Entry> {
        self.entries.get(job_id)
    }

    /// Persist an entry durably (written, flushed, renamed into place). Only after this returns may the job be
    /// acknowledged.
    pub fn record(&mut self, entry: Entry) -> io::Result<()> {
        if !ulid::is_ulid(&entry.job_id) {
            return Err(io::Error::other(format!(
                "not a job id: {:?}",
                entry.job_id
            )));
        }
        paths::write_private(
            &self.file(&entry.job_id),
            &serde_json::to_vec(&entry).map_err(io::Error::other)?,
        )?;
        self.entries.insert(entry.job_id.clone(), entry);
        Ok(())
    }

    /// Jobs that ran in `[since, now]` and count towards the hourly limit (`device.pause` never does).
    pub fn executed_since(&self, since: i64) -> usize {
        self.entries
            .values()
            .filter(|e| {
                e.executed
                    && e.received_at >= since
                    && e.kind
                        != <crate::actions::pause::DevicePause as crate::actions::Action>::KIND
            })
            .count()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Forget entries that are both older than 24 hours and past their job's expiry. Jobs live at most 24 hours
    /// (section 5.8), but `received_at` is this device's clock and `expires_at` the cloud's: with the device's clock
    /// behind, a record kept for exactly 24 hours after receipt could vanish while the job is still runnable, and
    /// a redelivery in that gap would run it twice.
    pub fn prune(&mut self, now: i64) {
        let old: Vec<String> = self
            .entries
            .values()
            .filter(|e| now - e.received_at > RETENTION_MS && e.expires_at.is_none_or(|x| now >= x))
            .map(|e| e.job_id.clone())
            .collect();
        for id in old {
            if fs::remove_file(self.file(&id)).is_ok() || !self.file(&id).exists() {
                self.entries.remove(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::{Code, Status};

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "fa-journal-{}-{}",
            std::process::id(),
            crate::b64::encode(&crate::wire::random_bytes::<6>())
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    const JOB: &str = "01M423B2F0ZQ7WE38ED5J4MYAE";

    fn entry(at: i64) -> Entry {
        Entry {
            job_id: JOB.into(),
            kind: "session.reply".into(),
            received_at: at,
            expires_at: None,
            executed: false,
            result: None,
        }
    }

    #[test]
    fn entries_survive_a_restart_with_their_result() {
        let d = dir();
        let mut j = Journal::open(&d, 1000).unwrap();
        j.record(entry(1000)).unwrap();
        let mut done = entry(1000);
        done.executed = true;
        done.result = Some(JobResult {
            status: Status::Done,
            code: Code::Ok,
            message: "ok".into(),
            data: None,
        });
        j.record(done.clone()).unwrap();
        let j = Journal::open(&d, 2000).unwrap();
        assert_eq!(j.get(JOB), Some(&done));
        assert_eq!(j.executed_since(0), 1);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn entries_older_than_a_day_are_dropped() {
        let d = dir();
        let mut j = Journal::open(&d, 0).unwrap();
        j.record(entry(0)).unwrap();
        assert!(
            Journal::open(&d, RETENTION_MS).unwrap().get(JOB).is_some(),
            "exactly 24 h is still kept"
        );
        let j = Journal::open(&d, RETENTION_MS + 1).unwrap();
        assert!(j.get(JOB).is_none());
        assert!(!d.join(format!("{JOB}.json")).exists());

        // An entry whose job has not expired yet is kept past 24 hours.
        let mut j = Journal::open(&d, 0).unwrap();
        j.record(Entry {
            expires_at: Some(RETENTION_MS + 60_000),
            ..entry(0)
        })
        .unwrap();
        assert!(
            Journal::open(&d, RETENTION_MS + 1)
                .unwrap()
                .get(JOB)
                .is_some()
        );
        assert!(
            Journal::open(&d, RETENTION_MS + 60_000)
                .unwrap()
                .get(JOB)
                .is_none()
        );
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn an_unreadable_entry_still_blocks_a_rerun() {
        let d = dir();
        fs::write(d.join(format!("{JOB}.json")), b"{ truncated").unwrap();
        fs::write(d.join("not-a-job.json"), b"{}").unwrap();
        let j = Journal::open(&d, 5).unwrap();
        let e = j.get(JOB).expect("kept");
        assert!(e.result.is_none() && e.executed);
        assert_eq!(j.len(), 1);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn refuses_ids_that_are_not_ulids() {
        let d = dir();
        let mut j = Journal::open(&d, 0).unwrap();
        let mut e = entry(0);
        e.job_id = "../escape".into();
        assert!(j.record(e).is_err());
        fs::remove_dir_all(&d).unwrap();
    }
}
