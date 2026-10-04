//! The local configuration (docs/cloud-agent.md section 8.2): human-edited, never written by the agent, and
//! **everything defaults to off**. A missing file is a valid configuration -- the one that allows nothing.
//!
//! This file is the device's policy. The cloud can read a summary of it (`auth.policy`) so it can refuse early
//! with a clear message, but nothing the cloud sends can change it: that is the red line "the cloud can never
//! widen a device's local policy" (section 4.5).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths;

/// The coding agents a device may drive. Closed: a new one is a code change here, never a config string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
    Cursor,
}

impl Agent {
    pub const ALL: [Agent; 3] = [Agent::Claude, Agent::Codex, Agent::Cursor];

    pub fn as_str(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Cursor => "cursor",
        }
    }

    pub fn parse(s: &str) -> Option<Agent> {
        Agent::ALL.into_iter().find(|a| a.as_str() == s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyStoreKind {
    /// The login Keychain (macOS only; the default there).
    Keychain,
    /// `device.key` in the state directory, mode 0600 (the default on Linux). Also the answer for a headless Mac
    /// whose login keychain is locked while the daemon runs.
    File,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Where to enrol and connect: `https://<worker-host>`. Plain `http://` is accepted only for a loopback host.
    #[serde(default)]
    pub cloud: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub key_store: Option<KeyStoreKind>,
    #[serde(default)]
    pub limits: Limits,
    #[serde(default)]
    pub agents: Agents,
    #[serde(default)]
    pub actions: Actions,
    #[serde(default)]
    pub repos: BTreeMap<String, Repo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    /// Jobs this device runs per rolling hour; the cloud also caps at 60, and the lower bound wins. `device.pause`
    /// is never counted or refused: a limit must not stand between the owner and stopping a device.
    pub jobs_per_hour: u32,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { jobs_per_hour: 30 }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Agents {
    pub claude: bool,
    pub codex: bool,
    pub cursor: bool,
}

/// The configurable actions. `device.pause` is not here because it is always allowed (pausing only ever reduces
/// what a device does), and `keys.update` because it is gated by signature, not by policy.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Actions {
    #[serde(rename = "session.reply")]
    pub session_reply: bool,
    #[serde(rename = "session.start")]
    pub session_start: bool,
    #[serde(rename = "permission.answer")]
    pub permission_answer: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Repo {
    /// A local path. It never leaves the device: the cloud only ever sees the alias.
    pub path: String,
    /// The agents `session.start` may launch in this repository.
    #[serde(default)]
    pub start: Vec<Agent>,
}

impl Config {
    /// Read and validate the file. A missing file is `Ok((Config::default(), false))`: everything off.
    pub fn load(file: &Path, home: &Path) -> Result<(Config, bool), String> {
        let text = match fs::read_to_string(file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok((Config::default(), false));
            }
            Err(e) => return Err(format!("cannot read {}: {e}", file.display())),
        };
        // The policy must be this user's alone. A file another local user can write is a file through which they
        // can widen what the cloud may do here (T7 in section 4.2) -- refuse it rather than obey it.
        use std::os::unix::fs::MetadataExt;
        let meta =
            fs::metadata(file).map_err(|e| format!("cannot stat {}: {e}", file.display()))?;
        if meta.uid() != paths::euid() {
            return Err(format!(
                "{} is owned by uid {}, not by this user; refusing to take a policy from it",
                file.display(),
                meta.uid()
            ));
        }
        if meta.mode() & 0o022 != 0 {
            return Err(format!(
                "{} is writable by group or others; refusing to take a policy someone else could widen (chmod go-w)",
                file.display()
            ));
        }
        let config = Config::parse(&text, home).map_err(|e| format!("{}: {e}", file.display()))?;
        Ok((config, true))
    }

    pub fn parse(text: &str, home: &Path) -> Result<Config, String> {
        let mut c: Config =
            toml::from_str(text).map_err(|e| e.to_string().trim_end().to_string())?;
        c.validate(home)?;
        Ok(c)
    }

    fn validate(&mut self, home: &Path) -> Result<(), String> {
        if let Some(cloud) = &self.cloud {
            self.cloud = Some(normalize_cloud(cloud)?);
        }
        if let Some(name) = &self.device_name {
            if name.trim().is_empty()
                || name.chars().count() > 64
                || name.chars().any(char::is_control)
            {
                return Err(
                    "device_name must be 1-64 characters with no control characters".into(),
                );
            }
        }
        if cfg!(not(target_os = "macos")) && self.key_store == Some(KeyStoreKind::Keychain) {
            return Err("key_store = \"keychain\" is only available on macOS".into());
        }
        for (alias, repo) in &mut self.repos {
            if !is_alias(alias) {
                return Err(format!(
                    "repos.{alias}: an alias is 1-64 characters of A-Z a-z 0-9 . _ -"
                ));
            }
            let path = paths::expand_home(&repo.path, home);
            if !path.is_absolute() {
                return Err(format!(
                    "repos.{alias}.path must be absolute or start with ~/"
                ));
            }
            repo.path = path.to_string_lossy().into_owned();
            repo.start.sort();
            repo.start.dedup();
        }
        Ok(())
    }

    pub fn agent_enabled(&self, a: Agent) -> bool {
        match a {
            Agent::Claude => self.agents.claude,
            Agent::Codex => self.agents.codex,
            Agent::Cursor => self.agents.cursor,
        }
    }

    /// The configurable action kinds that are switched on, sorted.
    pub fn enabled_actions(&self) -> Vec<&'static str> {
        let a = &self.actions;
        let mut v: Vec<&'static str> = [
            ("permission.answer", a.permission_answer),
            ("session.reply", a.session_reply),
            ("session.start", a.session_start),
        ]
        .into_iter()
        .filter_map(|(k, on)| on.then_some(k))
        .collect();
        v.sort_unstable();
        v
    }

    pub fn enabled_agents(&self) -> Vec<Agent> {
        Agent::ALL
            .into_iter()
            .filter(|a| self.agent_enabled(*a))
            .collect()
    }

    pub fn repo_path(&self, alias: &str) -> Option<PathBuf> {
        self.repos.get(alias).map(|r| PathBuf::from(&r.path))
    }

    /// What the device reports in `auth.policy`: action kinds, repository **aliases**, agents. Never a path --
    /// the cloud cannot name a directory, and it has no business knowing the layout of the owner's disk.
    pub fn policy_summary(&self) -> serde_json::Value {
        serde_json::json!({
            "actions": self.enabled_actions(),
            "repos": self.repos.keys().collect::<Vec<_>>(),
            "agents": self.enabled_agents().iter().map(|a| a.as_str()).collect::<Vec<_>>(),
        })
    }
}

pub fn is_alias(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `https://host[:port]` with nothing after it but an optional `/`. `http://` only for loopback: the frames are
/// signed either way, but enrolment pins the cloud's key on first use over this connection (section 3.6), and a
/// first use over plain HTTP across a network would pin whatever answered.
pub fn normalize_cloud(url: &str) -> Result<String, String> {
    let bad = || {
        format!("cloud must be https://<host> (or http://localhost for development), got {url:?}")
    };
    let (scheme, rest) = url.split_once("://").ok_or_else(bad)?;
    let host_port = rest.strip_suffix('/').unwrap_or(rest);
    if host_port.is_empty() || host_port.contains(['/', '?', '#', '@', ' ']) {
        return Err(bad());
    }
    let host = if host_port.starts_with('[') {
        host_port
            .split_once(']')
            .map(|(h, _)| format!("{h}]"))
            .ok_or_else(bad)?
    } else {
        host_port.split(':').next().unwrap_or_default().to_string()
    };
    match scheme {
        "https" => {}
        "http" if matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]") => {}
        _ => return Err(bad()),
    }
    Ok(format!("{scheme}://{host_port}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Config, String> {
        Config::parse(text, Path::new("/home/u"))
    }

    #[test]
    fn an_empty_file_allows_nothing() {
        let c = parse("").unwrap();
        assert!(c.enabled_actions().is_empty());
        assert!(c.enabled_agents().is_empty());
        assert!(c.repos.is_empty());
        assert!(c.cloud.is_none());
        assert_eq!(c.limits.jobs_per_hour, 30);
        assert_eq!(
            c.policy_summary(),
            serde_json::json!({"actions": [], "repos": [], "agents": []})
        );
    }

    const EXAMPLE: &str = r#"
cloud = "https://agent.example.com/"
device_name = "studio"

[limits]
jobs_per_hour = 30

[agents]
claude = true
codex = true
cursor = false

[actions]
"session.reply" = true
"session.start" = false
"permission.answer" = false

[repos.forgeline]
path = "~/src/forgeline"
start = ["claude", "claude"]
"#;

    #[test]
    fn the_documented_example_parses() {
        let c = parse(EXAMPLE).unwrap();
        assert_eq!(c.cloud.as_deref(), Some("https://agent.example.com"));
        assert_eq!(c.enabled_actions(), ["session.reply"]);
        assert_eq!(c.enabled_agents(), [Agent::Claude, Agent::Codex]);
        assert_eq!(c.repos["forgeline"].path, "/home/u/src/forgeline");
        assert_eq!(c.repos["forgeline"].start, [Agent::Claude]);
        // The same summary the handshake fixture carries.
        assert_eq!(
            c.policy_summary(),
            serde_json::json!({"actions": ["session.reply"], "repos": ["forgeline"], "agents": ["claude", "codex"]})
        );
    }

    #[test]
    fn the_policy_summary_never_carries_a_path() {
        let c = parse(EXAMPLE).unwrap();
        let summary = c.policy_summary().to_string();
        assert!(!summary.contains("/home/u"), "{summary}");
        assert!(!summary.contains("src/forgeline"), "{summary}");
    }

    #[test]
    fn unknown_keys_are_errors_not_silently_ignored() {
        // A typo in a policy file must not read as "allowed" or as "the setting you think you wrote".
        assert!(parse("[action]\n\"session.reply\" = true").is_err());
        assert!(parse("[actions]\n\"session.replay\" = true").is_err());
        assert!(parse("[actions]\n\"device.pause\" = false").is_err());
        assert!(parse("[agents]\nclaud = true").is_err());
        assert!(parse("[repos.x]\npath = \"/x\"\nstart = [\"vim\"]").is_err());
        assert!(parse("cloud_url = \"https://x\"").is_err());
    }

    #[test]
    fn validates_aliases_paths_and_names() {
        assert!(parse("[repos.\"a/b\"]\npath = \"/x\"").is_err());
        assert!(parse("[repos.ok]\npath = \"relative/x\"").is_err());
        assert!(parse("device_name = \"\"").is_err());
        assert!(parse("device_name = \"a\\nb\"").is_err());
    }

    #[test]
    fn cloud_urls() {
        assert_eq!(
            normalize_cloud("https://x.example.com").unwrap(),
            "https://x.example.com"
        );
        assert_eq!(
            normalize_cloud("https://x.example.com:8443/").unwrap(),
            "https://x.example.com:8443"
        );
        assert_eq!(
            normalize_cloud("http://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert_eq!(
            normalize_cloud("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_cloud("http://[::1]:8787").unwrap(),
            "http://[::1]:8787"
        );
        for bad in [
            "http://x.example.com",
            "http://localhost.evil.com",
            "https://x/path",
            "https://x?q",
            "https://u@x",
            "ftp://x",
            "x.example.com",
            "https://",
        ] {
            assert!(normalize_cloud(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn agents_round_trip() {
        for a in Agent::ALL {
            assert_eq!(Agent::parse(a.as_str()), Some(a));
        }
        assert_eq!(Agent::parse("vim"), None);
    }
}
