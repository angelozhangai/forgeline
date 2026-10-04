//! `trust.json` (docs/cloud-agent.md section 8.3): this device's id, the cloud it enrolled with, and the cloud keys
//! it pinned. Written only by `enroll` and by a verified `keys.update` (both P2); P3 reads it.
//!
//! Every field is checked on load, and a key whose kid does not match its bytes is refused: a pinned key that
//! does not hash to its own name means the file was edited by hand or damaged, and trusting it would make the
//! kid -- the fingerprint the owner compared at enrolment -- meaningless.

use std::fs;
use std::io;

use serde::{Deserialize, Serialize};

use crate::config::normalize_cloud;
use crate::paths;
use crate::state::StateDir;
use crate::wire::{self, Keyring};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trust {
    pub device_id: String,
    pub cloud: String,
    pub keys: Vec<PinnedKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinnedKey {
    pub kid: String,
    /// The raw 32-byte public key, base64url.
    pub public: String,
}

impl Trust {
    /// `Ok(None)` when the device has not been enrolled.
    pub fn load(state: &StateDir) -> Result<Option<Trust>, String> {
        let path = state.trust_file();
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let t: Trust =
            serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        t.keyring()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Some(t))
    }

    pub fn save(&self, state: &StateDir) -> Result<(), String> {
        self.keyring()?;
        let text = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        paths::write_private(&state.trust_file(), &text).map_err(|e| e.to_string())
    }

    /// The pinned keys as a verifier keyring, every one signing only for `cloud`.
    pub fn keyring(&self) -> Result<Keyring, String> {
        if !self.device_id.starts_with("dev_") || !wire::is_party(&self.device_id) {
            return Err(format!(
                "device_id {:?} is not dev_ followed by a ULID",
                self.device_id
            ));
        }
        normalize_cloud(&self.cloud)?;
        if self.keys.is_empty() {
            return Err("no pinned cloud key".into());
        }
        let mut ring = Keyring::default();
        for k in &self.keys {
            let public = crate::b64::decode_array::<32>(&k.public)
                .ok_or_else(|| format!("pinned key {} is not 32 bytes of base64url", k.kid))?;
            let kid = ring.add("cloud", &public)?;
            if kid != k.kid {
                return Err(format!(
                    "pinned key {} hashes to kid {kid}; the file was altered",
                    k.kid
                ));
            }
        }
        Ok(ring)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The cloud test key from fixtures/wire/v1/keys.json (RFC 8032 TEST 1 -- public, test-only).
    const CLOUD_PUBLIC: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const CLOUD_KID: &str = "If4x36FUomFia_hU";

    fn trust() -> Trust {
        Trust {
            device_id: "dev_01M3ZGYZ00MZDA2E2C003XDNC6".into(),
            cloud: "https://agent.example.com".into(),
            keys: vec![PinnedKey {
                kid: CLOUD_KID.into(),
                public: CLOUD_PUBLIC.into(),
            }],
        }
    }

    #[test]
    fn a_valid_file_round_trips() {
        let dir = std::env::temp_dir().join(format!(
            "fa-trust-{}-{}",
            std::process::id(),
            crate::b64::encode(&crate::wire::random_bytes::<6>())
        ));
        let state = StateDir::open(&dir).unwrap();
        assert_eq!(Trust::load(&state).unwrap(), None);
        trust().save(&state).unwrap();
        assert_eq!(Trust::load(&state).unwrap(), Some(trust()));
        assert_eq!(
            trust().keyring().unwrap().get(CLOUD_KID).unwrap().owner,
            "cloud"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_kid_that_does_not_match_its_key_is_refused() {
        let mut t = trust();
        t.keys[0].kid = "AAAAAAAAAAAAAAAA".into();
        assert!(t.keyring().unwrap_err().contains("altered"));
    }

    #[test]
    fn bad_ids_urls_and_empty_pins_are_refused() {
        let mut t = trust();
        t.device_id = "cloud".into();
        assert!(t.keyring().is_err());
        let mut t = trust();
        t.cloud = "http://agent.example.com".into();
        assert!(t.keyring().is_err());
        let mut t = trust();
        t.keys.clear();
        assert!(t.keyring().is_err());
    }
}
