//! Where the device's Ed25519 private key lives (docs/cloud-agent.md sections 4.1 A5 and 9.1): the login Keychain
//! on macOS, a 0600 file on Linux, one trait in front of both. The key is generated on the device at enrolment
//! (P2) and never leaves it; nothing in this module sends it anywhere.
//!
//! Tests use [`FileKeyStore`] and [`MemoryKeyStore`]; nothing in the test suite touches a real Keychain.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

use ed25519_dalek::SigningKey;

use crate::config::KeyStoreKind;
use crate::paths;
use crate::state::StateDir;

pub trait KeyStore {
    /// Where the key is, in words, for `status` and `doctor`.
    fn describe(&self) -> String;
    /// The device key, or `None` if there is none yet.
    fn load(&self) -> Result<Option<SigningKey>, String>;
    fn save(&self, key: &SigningKey) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// A fresh key from the OS random number generator.
pub fn generate() -> SigningKey {
    SigningKey::from_bytes(&crate::wire::random_bytes())
}

/// The store this machine uses: the configured one, else the Keychain on macOS and the file elsewhere.
pub fn for_platform(
    kind: Option<KeyStoreKind>,
    state: &StateDir,
) -> Result<Box<dyn KeyStore>, String> {
    match kind {
        Some(KeyStoreKind::File) => Ok(Box::new(FileKeyStore::new(state.device_key_file()))),
        #[cfg(target_os = "macos")]
        Some(KeyStoreKind::Keychain) | None => Ok(Box::new(keychain::KeychainKeyStore::new(
            keychain::SERVICE,
            keychain::ACCOUNT,
        ))),
        #[cfg(not(target_os = "macos"))]
        Some(KeyStoreKind::Keychain) => {
            Err("key_store = \"keychain\" is only available on macOS".into())
        }
        #[cfg(not(target_os = "macos"))]
        None => Ok(Box::new(FileKeyStore::new(state.device_key_file()))),
    }
}

/// The seed as base64url text, so a human inspecting the file sees what it is, and a stray newline from an
/// editor does not change the key.
fn encode_seed(key: &SigningKey) -> String {
    crate::b64::encode(key.as_bytes())
}

fn decode_seed(text: &str) -> Result<SigningKey, String> {
    crate::b64::decode_array::<32>(text.trim())
        .map(|seed| SigningKey::from_bytes(&seed))
        .ok_or_else(|| "the stored device key is not 32 bytes of base64url".to_string())
}

pub struct FileKeyStore {
    path: PathBuf,
}

impl FileKeyStore {
    pub fn new(path: PathBuf) -> FileKeyStore {
        FileKeyStore { path }
    }
}

impl KeyStore for FileKeyStore {
    fn describe(&self) -> String {
        format!("file {}", self.path.display())
    }

    fn load(&self) -> Result<Option<SigningKey>, String> {
        let meta = match fs::metadata(&self.path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("{}: {e}", self.path.display())),
        };
        // Refuse a key others could have read, the way ssh does: it may already be copied, and using it anyway
        // would hide that. The fix is a new enrolment, not a chmod.
        if let Some(why) = paths::not_private(&self.path, &meta) {
            return Err(format!(
                "{why}; refusing to use a device key others may have read -- revoke this device and enrol it again"
            ));
        }
        let text =
            fs::read_to_string(&self.path).map_err(|e| format!("{}: {e}", self.path.display()))?;
        decode_seed(&text).map(Some)
    }

    fn save(&self, key: &SigningKey) -> Result<(), String> {
        paths::write_private(&self.path, format!("{}\n", encode_seed(key)).as_bytes())
            .map_err(|e| format!("{}: {e}", self.path.display()))
    }

    fn delete(&self) -> Result<(), String> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("{}: {e}", self.path.display())),
        }
    }
}

#[derive(Default)]
pub struct MemoryKeyStore {
    seed: Mutex<Option<[u8; 32]>>,
}

impl KeyStore for MemoryKeyStore {
    fn describe(&self) -> String {
        "memory".into()
    }
    fn load(&self) -> Result<Option<SigningKey>, String> {
        Ok(self
            .seed
            .lock()
            .map_err(|e| e.to_string())?
            .map(|s| SigningKey::from_bytes(&s)))
    }
    fn save(&self, key: &SigningKey) -> Result<(), String> {
        *self.seed.lock().map_err(|e| e.to_string())? = Some(key.to_bytes());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        *self.seed.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub mod keychain {
    //! The login Keychain, as a generic password item.
    //!
    //! Known limitation, reported as doc feedback: a Keychain item's access list is bound to the code signature
    //! of the binary that created it. An ad-hoc-signed binary changes identity on every upgrade, so after an
    //! upgrade macOS asks the user before handing the key over -- a dialog a launchd daemon cannot answer. The
    //! fixes are a Developer ID signature on releases, or `key_store = "file"`.

    use super::{KeyStore, decode_seed, encode_seed};
    use ed25519_dalek::SigningKey;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    pub const SERVICE: &str = "forgeline-agent";
    pub const ACCOUNT: &str = "device-key";
    // errSecItemNotFound
    const NOT_FOUND: i32 = -25300;

    pub struct KeychainKeyStore {
        service: String,
        account: String,
    }

    impl KeychainKeyStore {
        pub fn new(service: &str, account: &str) -> KeychainKeyStore {
            KeychainKeyStore {
                service: service.into(),
                account: account.into(),
            }
        }
    }

    impl KeyStore for KeychainKeyStore {
        fn describe(&self) -> String {
            format!(
                "login Keychain, service {:?}, account {:?}",
                self.service, self.account
            )
        }

        fn load(&self) -> Result<Option<SigningKey>, String> {
            match get_generic_password(&self.service, &self.account) {
                Ok(bytes) => decode_seed(&String::from_utf8_lossy(&bytes)).map(Some),
                Err(e) if e.code() == NOT_FOUND => Ok(None),
                Err(e) => Err(format!("Keychain: {e}")),
            }
        }

        fn save(&self, key: &SigningKey) -> Result<(), String> {
            set_generic_password(&self.service, &self.account, encode_seed(key).as_bytes())
                .map_err(|e| format!("Keychain: {e}"))
        }

        fn delete(&self) -> Result<(), String> {
            match delete_generic_password(&self.service, &self.account) {
                Ok(()) => Ok(()),
                Err(e) if e.code() == NOT_FOUND => Ok(()),
                Err(e) => Err(format!("Keychain: {e}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn round_trip(store: &dyn KeyStore) {
        assert!(store.load().unwrap().is_none());
        let k = generate();
        store.save(&k).unwrap();
        assert_eq!(store.load().unwrap().unwrap().to_bytes(), k.to_bytes());
        store.delete().unwrap();
        assert!(store.load().unwrap().is_none());
        store.delete().unwrap();
    }

    #[test]
    fn memory_store_round_trips() {
        round_trip(&MemoryKeyStore::default());
    }

    #[test]
    fn file_store_round_trips_at_0600_and_refuses_a_readable_key() {
        let dir = std::env::temp_dir().join(format!(
            "fa-key-{}-{}",
            std::process::id(),
            crate::b64::encode(&crate::wire::random_bytes::<6>())
        ));
        let state = StateDir::open(&dir).unwrap();
        let store = FileKeyStore::new(state.device_key_file());
        round_trip(&store);
        store.save(&generate()).unwrap();
        assert_eq!(
            fs::metadata(state.device_key_file())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::set_permissions(state.device_key_file(), fs::Permissions::from_mode(0o640)).unwrap();
        let err = store.load().unwrap_err();
        assert!(err.contains("refusing"), "{err}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn generated_keys_differ() {
        assert_ne!(generate().to_bytes(), generate().to_bytes());
    }

    // Touches the real login Keychain, so it is opt-in: `cargo test -- --ignored keychain`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn keychain_store_round_trips() {
        let account = format!(
            "test-{}",
            crate::b64::encode(&crate::wire::random_bytes::<6>())
        );
        round_trip(&keychain::KeychainKeyStore::new(
            "forgeline-agent-test",
            &account,
        ));
    }
}
