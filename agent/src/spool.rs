//! The spool (docs/cloud-agent.md sections 5.7 and 8.3): work that must survive the daemon being down.
//!
//! Two kinds of item, one directory:
//! - **events** waiting to be sent to the cloud. Written before the first send, deleted only on the cloud's `ack`
//!   (keyed by `event_id`), so an event survives restarts and lost connections and is sent at least once.
//! - **hook reports** a hook could not hand to the daemon because it was not running. The daemon processes and
//!   deletes them when it starts (and periodically, to cover a hook that raced a restart).
//!
//! One file per item, written atomically: a hook process and the daemon never see each other's half-written files.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::local_api::HookReport;
use crate::paths;
use crate::wire::ulid;

/// Bounded (section 5.11): a device that has been offline for weeks, with a hook firing every turn, must not fill
/// the disk. Past this, new items are refused and the refusal is logged by whoever tried.
pub const MAX_ITEMS: usize = 1000;

/// An event body exactly as it goes into an `event` frame (section 5.6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub event_id: String,
    pub kind: String,
    pub at: i64,
    pub data: serde_json::Value,
}

impl Event {
    pub fn new(kind: &str, at: i64, data: serde_json::Value) -> Event {
        Event {
            event_id: ulid::new(at),
            kind: kind.into(),
            at,
            data,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "item", rename_all = "lowercase")]
pub enum Item {
    Event(Event),
    Hook(HookReport),
}

pub struct Spool {
    dir: PathBuf,
    limit: usize,
}

/// Readable items as (id, item), oldest first; and the ids of unreadable files.
pub type Listing = (Vec<(String, Item)>, Vec<String>);

impl Spool {
    pub fn new(dir: &Path) -> Spool {
        Spool::with_limit(dir, MAX_ITEMS)
    }

    pub fn with_limit(dir: &Path, limit: usize) -> Spool {
        Spool {
            dir: dir.to_path_buf(),
            limit,
        }
    }

    fn file(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// Ids of the items on disk, oldest first (ids are ULIDs, so name order is time order).
    fn ids(&self) -> io::Result<Vec<String>> {
        let mut ids: Vec<String> = fs::read_dir(&self.dir)?
            .flatten()
            .filter_map(|e| {
                e.file_name()
                    .to_str()
                    .and_then(|n| n.strip_suffix(".json"))
                    .filter(|n| ulid::is_ulid(n))
                    .map(str::to_string)
            })
            .collect();
        ids.sort();
        Ok(ids)
    }

    pub fn len(&self) -> usize {
        self.ids().map_or(0, |v| v.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Store an item. Events are stored under their `event_id`, so the cloud's ack names the file to delete.
    pub fn push(&self, item: &Item, now: i64) -> io::Result<String> {
        if self.len() >= self.limit {
            return Err(io::Error::other(format!(
                "the spool already holds {} items",
                self.limit
            )));
        }
        let id = match item {
            Item::Event(e) if ulid::is_ulid(&e.event_id) => e.event_id.clone(),
            Item::Event(e) => {
                return Err(io::Error::other(format!(
                    "not an event id: {:?}",
                    e.event_id
                )));
            }
            Item::Hook(_) => ulid::new(now),
        };
        let bytes = serde_json::to_vec(item).map_err(io::Error::other)?;
        // Events are flushed to disk: the owner is told about them. A hook report is written unsynced -- the hook
        // has a budget of milliseconds, and losing one report to a power cut costs only a session's last-seen time.
        match item {
            Item::Event(_) => paths::write_private(&self.file(&id), &bytes)?,
            Item::Hook(_) => paths::write_private_unsynced(&self.file(&id), &bytes)?,
        }
        Ok(id)
    }

    /// Every readable item, oldest first. An unreadable file is skipped and named in the second list, so callers
    /// can report it rather than silently lose it.
    pub fn list(&self) -> io::Result<Listing> {
        let mut good = Vec::new();
        let mut bad = Vec::new();
        for id in self.ids()? {
            match fs::read(self.file(&id))
                .ok()
                .and_then(|b| serde_json::from_slice::<Item>(&b).ok())
            {
                Some(item) => good.push((id, item)),
                None => bad.push(id),
            }
        }
        Ok((good, bad))
    }

    pub fn events(&self) -> Vec<Event> {
        self.list()
            .map(|(items, _)| {
                items
                    .into_iter()
                    .filter_map(|(_, i)| {
                        if let Item::Event(e) = i {
                            Some(e)
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Delete an item. Only ids that could have come from [`Spool::push`] are honoured, so an `ack.key` from the
    /// network can never name a path outside the spool.
    pub fn remove(&self, id: &str) -> io::Result<bool> {
        if !ulid::is_ulid(id) {
            return Ok(false);
        }
        match fs::remove_file(self.file(id)) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Agent;

    fn spool() -> (Spool, PathBuf) {
        let d = std::env::temp_dir().join(format!(
            "fa-spool-{}-{}",
            std::process::id(),
            crate::b64::encode(&crate::wire::random_bytes::<6>())
        ));
        fs::create_dir_all(&d).unwrap();
        (Spool::new(&d), d)
    }

    fn report() -> HookReport {
        HookReport {
            agent: Agent::Claude,
            at: 5,
            hook: Some("Stop".into()),
            session: Some("s1".into()),
            cwd: None,
            payload: serde_json::json!({"session_id": "s1"}),
        }
    }

    #[test]
    fn events_are_stored_under_their_id_and_removed_by_it() {
        let (s, d) = spool();
        let e = Event::new(
            "device.paused",
            1_791_072_000_000,
            serde_json::json!({"by": "local"}),
        );
        assert_eq!(s.push(&Item::Event(e.clone()), 0).unwrap(), e.event_id);
        s.push(&Item::Hook(report()), 1_791_072_000_001).unwrap();
        assert_eq!(s.events(), vec![e.clone()]);
        let (items, bad) = s.list().unwrap();
        assert_eq!(items.len(), 2);
        assert!(bad.is_empty());
        assert!(s.remove(&e.event_id).unwrap());
        assert!(!s.remove(&e.event_id).unwrap());
        assert!(!s.remove("../../etc/passwd").unwrap());
        assert_eq!(s.len(), 1);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn unreadable_items_are_reported_not_dropped() {
        let (s, d) = spool();
        fs::write(d.join("01M423B2F0ZQ7WE38ED5J4MYAE.json"), b"garbage").unwrap();
        let (items, bad) = s.list().unwrap();
        assert!(items.is_empty());
        assert_eq!(bad, ["01M423B2F0ZQ7WE38ED5J4MYAE"]);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn the_spool_is_bounded() {
        let (_, d) = spool();
        let s = Spool::with_limit(&d, 5);
        for i in 0..5 {
            s.push(&Item::Hook(report()), i).unwrap();
        }
        assert!(s.push(&Item::Hook(report()), 0).is_err());
        fs::remove_dir_all(&d).unwrap();
    }
}
