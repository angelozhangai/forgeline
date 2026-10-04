//! Shared by the integration tests: the golden fixtures of fixtures/wire/v1/ and throwaway directories.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use ed25519_dalek::SigningKey;
use forgeline_agent::wire::Keyring;
use serde::Deserialize;

pub const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/wire/v1");

#[derive(Debug, Clone, Deserialize)]
pub struct TestKey {
    pub name: String,
    pub owner: Option<String>,
    pub seed_hex: String,
    pub public: String,
    pub kid: String,
}

impl TestKey {
    pub fn signing(&self) -> SigningKey {
        SigningKey::from_bytes(&hex(&self.seed_hex).try_into().unwrap())
    }
    pub fn public_bytes(&self) -> [u8; 32] {
        forgeline_agent::b64::decode_array(&self.public).unwrap()
    }
}

#[derive(Debug, Deserialize)]
struct KeyFile {
    keys: Vec<TestKey>,
}

pub fn keys() -> Vec<TestKey> {
    let text = fs::read_to_string(Path::new(FIXTURES).join("keys.json")).unwrap();
    serde_json::from_str::<KeyFile>(&text).unwrap().keys
}

pub fn key(name: &str) -> TestKey {
    keys()
        .into_iter()
        .find(|k| k.name == name)
        .unwrap_or_else(|| panic!("no test key {name}"))
}

pub fn key_by_kid(kid: &str) -> Option<TestKey> {
    keys().into_iter().find(|k| k.kid == kid)
}

/// The device id the fixtures use.
pub fn device_id() -> String {
    key("device").owner.unwrap()
}

/// A keyring trusting the named test keys, each for its owner.
pub fn keyring(names: &[&str]) -> Keyring {
    let mut ring = Keyring::default();
    for n in names {
        let k = key(n);
        ring.add(k.owner.as_deref().unwrap(), &k.public_bytes())
            .unwrap();
    }
    ring
}

#[derive(Debug, Clone, Deserialize)]
pub struct Fixture {
    pub about: String,
    pub receiver: String,
    pub now: i64,
    pub trust: Vec<String>,
    pub frames: Vec<String>,
    pub expect: Vec<String>,
}

pub fn fixtures() -> Vec<(String, Fixture)> {
    let mut out: Vec<(String, Fixture)> = fs::read_dir(Path::new(FIXTURES).join("frames"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| {
            (
                p.file_stem().unwrap().to_string_lossy().into_owned(),
                serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap(),
            )
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

pub fn fixture(name: &str) -> Fixture {
    fixtures()
        .into_iter()
        .find(|(n, _)| n == name)
        .unwrap_or_else(|| panic!("no fixture {name}"))
        .1
}

pub fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// A directory removed on drop. Kept short: a Unix socket path inside it must fit in 104 bytes on macOS.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        let rnd = forgeline_agent::b64::encode(&forgeline_agent::wire::random_bytes::<4>())
            .replace(['-', '_'], "x");
        let p = std::env::temp_dir().join(format!("fa-{tag}-{rnd}"));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
