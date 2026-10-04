//! Where things live (docs/cloud-agent.md sections 8.2 and 8.3), and the permission rules for what the agent
//! writes there.
//!
//! The XDG layout is used on macOS too (`~/.config`, `~/.local/state`), as the design says: one layout to
//! document, and one that downstream installers can predict on every platform.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const APP: &str = "forgeline-agent";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dirs {
    pub home: PathBuf,
    /// `$XDG_CONFIG_HOME/forgeline-agent`
    pub config: PathBuf,
    /// `$XDG_STATE_HOME/forgeline-agent`
    pub state: PathBuf,
}

impl Dirs {
    pub fn from_env() -> Result<Dirs, String> {
        Dirs::from_vars(|k| std::env::var_os(k))
    }

    pub fn from_vars(get: impl Fn(&str) -> Option<OsString>) -> Result<Dirs, String> {
        let home = get("HOME")
            .filter(|h| !h.is_empty())
            .map(PathBuf::from)
            .ok_or("HOME is not set")?;
        if !home.is_absolute() {
            return Err(format!("HOME is not an absolute path: {}", home.display()));
        }
        // The XDG spec says a relative value is invalid and must be ignored, not resolved against the cwd: a
        // daemon and a hook started from different directories would otherwise disagree about where state is.
        let xdg = |var: &str, default: &[&str]| -> PathBuf {
            match get(var).map(PathBuf::from) {
                Some(p) if p.is_absolute() => p,
                _ => default.iter().fold(home.clone(), |p, part| p.join(part)),
            }
        };
        Ok(Dirs {
            config: xdg("XDG_CONFIG_HOME", &[".config"]).join(APP),
            state: xdg("XDG_STATE_HOME", &[".local", "state"]).join(APP),
            home,
        })
    }

    pub fn config_file(&self) -> PathBuf {
        self.config.join("config.toml")
    }
}

/// The effective uid of this process: the only uid allowed to own the agent's files or talk to its socket.
pub fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// Create `path` (and missing parents) with the leaf at mode 0700; if it exists, require that this user owns it
/// and tighten it to 0700. Refuses a directory owned by someone else rather than writing secrets into it.
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = fs::metadata(path)?;
    if !meta.is_dir() {
        return Err(io::Error::other(format!(
            "{} exists and is not a directory",
            path.display()
        )));
    }
    if meta.uid() != euid() {
        return Err(io::Error::other(format!(
            "{} is owned by uid {}, not by this user (uid {})",
            path.display(),
            meta.uid(),
            euid()
        )));
    }
    // The umask can strip bits from the mode given at creation but never add them; an existing directory may
    // have been made by hand. Either way, set it explicitly.
    if meta.mode() & 0o777 != 0o700 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Why `path` is not private to this user (owned by us, no group or other permission bits), or `None` if it is.
/// Used by `doctor` and before trusting a secret read from disk.
pub fn not_private(path: &Path, meta: &fs::Metadata) -> Option<String> {
    if meta.uid() != euid() {
        return Some(format!(
            "{} is owned by uid {}, not by this user",
            path.display(),
            meta.uid()
        ));
    }
    if meta.mode() & 0o077 != 0 {
        return Some(format!(
            "{} has mode {:o}; it must not be accessible to group or others",
            path.display(),
            meta.mode() & 0o777
        ));
    }
    None
}

/// Write `bytes` to `path` atomically with mode 0600: a temporary file in the same directory, flushed to disk,
/// then renamed over the target. A reader (another process, or this one after a crash) sees the old content or
/// the new, never half of either -- which is what lets the journal promise "recorded before acknowledged".
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomic(path, bytes, true)
}

/// [`write_private`] without the flush to disk: still atomic against crashes of this process, but a power loss
/// may lose it. For records that are cheap to lose (a hook report, a session's last-seen time), because a full
/// flush costs tens of milliseconds on macOS (F_FULLFSYNC) and hooks have a budget of milliseconds.
pub fn write_private_unsynced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomic(path, bytes, false)
}

fn write_atomic(path: &Path, bytes: &[u8], sync: bool) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("no parent directory"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("no file name"))?;
    let mut tmp_name = OsString::from(".tmp-");
    tmp_name.push(name);
    // Unique per writer, so a hook and the daemon writing the same file never share a temporary.
    tmp_name.push(format!(
        "-{}-{}",
        std::process::id(),
        crate::b64::encode(&crate::wire::random_bytes::<6>())
    ));
    let tmp = dir.join(tmp_name);
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
        f.write_all(bytes)?;
        if sync {
            f.sync_all()?;
        }
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Append one line to a 0600 log file, creating it if needed.
pub fn append_private(path: &Path, line: &str) -> io::Result<()> {
    let mut f = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(line.as_bytes())?;
    f.write_all(b"\n")
}

/// Expand a leading `~` against `home`. Anything else is returned unchanged.
pub fn expand_home(p: &str, home: &Path) -> PathBuf {
    if p == "~" {
        home.to_path_buf()
    } else if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn dirs(vars: &[(&str, &str)]) -> Result<Dirs, String> {
        let m: HashMap<String, OsString> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), OsString::from(v)))
            .collect();
        Dirs::from_vars(|k| m.get(k).cloned())
    }

    #[test]
    fn xdg_defaults_and_overrides() {
        let d = dirs(&[("HOME", "/home/u")]).unwrap();
        assert_eq!(
            d.config_file(),
            PathBuf::from("/home/u/.config/forgeline-agent/config.toml")
        );
        assert_eq!(
            d.state,
            PathBuf::from("/home/u/.local/state/forgeline-agent")
        );
        let d = dirs(&[
            ("HOME", "/home/u"),
            ("XDG_CONFIG_HOME", "/cfg"),
            ("XDG_STATE_HOME", "/st"),
        ])
        .unwrap();
        assert_eq!(d.config, PathBuf::from("/cfg/forgeline-agent"));
        assert_eq!(d.state, PathBuf::from("/st/forgeline-agent"));
    }

    #[test]
    fn relative_xdg_values_are_ignored_and_home_is_required() {
        let d = dirs(&[("HOME", "/home/u"), ("XDG_STATE_HOME", "rel/state")]).unwrap();
        assert_eq!(
            d.state,
            PathBuf::from("/home/u/.local/state/forgeline-agent")
        );
        assert!(dirs(&[]).is_err());
        assert!(dirs(&[("HOME", "relative")]).is_err());
    }

    #[test]
    fn expands_home() {
        let h = Path::new("/home/u");
        assert_eq!(expand_home("~/src/x", h), PathBuf::from("/home/u/src/x"));
        assert_eq!(expand_home("~", h), PathBuf::from("/home/u"));
        assert_eq!(expand_home("~other/x", h), PathBuf::from("~other/x"));
        assert_eq!(expand_home("/abs", h), PathBuf::from("/abs"));
    }
}
