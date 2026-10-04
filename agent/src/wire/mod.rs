//! Wire protocol v1 framing (docs/cloud-agent.md section 5): envelopes, the canonical form, Ed25519 signing, and
//! the verifier with its exact check order.
//!
//! This is the third implementation of these rules, after the reference (tools/wire-fixtures.ts) and the Worker
//! (cloud/). None of them is tested against itself: all three must reproduce fixtures/wire/v1/ -- the same
//! canonical bytes, the same signatures, the same rejection code for every bad frame. tests/wire_fixtures.rs
//! runs every fixture through this module. If a fixture and this code disagree, the fixture wins and the
//! disagreement is reported, never worked around here.

pub mod json;
pub mod ulid;

use std::collections::HashMap;

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier as _, VerifyingKey};
use json::Json;
use sha2::{Digest, Sha256};

/// Prepended to the canonical bytes before signing, so a signature made for this protocol never verifies in any
/// other context that signs JSON with the same key, and v2 can never accept a v1 signature.
pub const DOMAIN: &str = "forgeline-wire/1\n";
pub const VERSION: i64 = 1;
/// A frame dated further than this from the receiver's clock is stale. Inclusive: exactly this far is accepted.
pub const WINDOW_MS: i64 = 300_000;
/// How long accepted envelope ids are remembered. A frame dated at the far edge of the window (now + 5 min) stays
/// acceptable until 10 minutes after it was first seen, so remembering it for less would let it be replayed.
pub const REPLAY_MEMORY_MS: i64 = 2 * WINDOW_MS;
/// Section 5.11, in UTF-8 bytes of the raw text. Check 1 refuses anything larger before parsing it.
pub const MAX_FRAME_BYTES: usize = 65_536;

/// Rejection codes, in the order the checks run (section 5.4). The order is part of the protocol: a frame that is
/// wrong in two ways must get the same code from every implementation, or the audit trails disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RejectCode {
    Malformed,
    UnsupportedVersion,
    NonCanonical,
    UnknownKey,
    BadSignature,
    WrongRecipient,
    Stale,
    Replay,
}

impl RejectCode {
    pub const ALL: [RejectCode; 8] = [
        RejectCode::Malformed,
        RejectCode::UnsupportedVersion,
        RejectCode::NonCanonical,
        RejectCode::UnknownKey,
        RejectCode::BadSignature,
        RejectCode::WrongRecipient,
        RejectCode::Stale,
        RejectCode::Replay,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            RejectCode::Malformed => "malformed",
            RejectCode::UnsupportedVersion => "unsupported_version",
            RejectCode::NonCanonical => "non_canonical",
            RejectCode::UnknownKey => "unknown_key",
            RejectCode::BadSignature => "bad_signature",
            RejectCode::WrongRecipient => "wrong_recipient",
            RejectCode::Stale => "stale",
            RejectCode::Replay => "replay",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub code: RejectCode,
    pub why: String,
}

fn reject<T>(code: RejectCode, why: impl Into<String>) -> Result<T, Rejection> {
    Err(Rejection {
        code,
        why: why.into(),
    })
}

pub type Body = serde_json::Map<String, serde_json::Value>;

/// A verified frame, or one about to be sealed.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    /// The `type` field.
    pub kind: String,
    pub id: String,
    pub ts: i64,
    pub from: String,
    pub to: String,
    pub kid: String,
    pub re: Option<String>,
    pub body: Body,
    pub sig: String,
}

/// What a sender decides; [`seal`] adds the version, the key id and the signature.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub kind: String,
    pub id: String,
    pub ts: i64,
    pub from: String,
    pub to: String,
    pub re: Option<String>,
    pub body: Body,
}

/// OS randomness. There is no sensible way to continue without it: every nonce, id and key depends on it.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("the operating system's random number generator failed");
    buf
}

/// A key id is derived from the key, never assigned: nobody keeps a registry in sync, and the same 16 characters
/// are the fingerprint a human compares during enrolment.
pub fn kid_of(public: &[u8; 32]) -> String {
    let mut kid = crate::b64::encode(&Sha256::digest(public));
    kid.truncate(16);
    kid
}

fn signing_input(unsigned_canonical: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(DOMAIN.len() + unsigned_canonical.len());
    v.extend_from_slice(DOMAIN.as_bytes());
    v.extend_from_slice(unsigned_canonical.as_bytes());
    v
}

fn envelope_json(d: &Draft, kid: &str, sig: Option<&str>) -> Json {
    let mut m = std::collections::BTreeMap::new();
    let s = |v: &str| Json::Str(json::utf16(v));
    m.insert(json::utf16("v"), Json::Num(VERSION as f64));
    m.insert(json::utf16("type"), s(&d.kind));
    m.insert(json::utf16("id"), s(&d.id));
    m.insert(json::utf16("ts"), Json::Num(d.ts as f64));
    m.insert(json::utf16("from"), s(&d.from));
    m.insert(json::utf16("to"), s(&d.to));
    m.insert(json::utf16("kid"), s(kid));
    if let Some(re) = &d.re {
        m.insert(json::utf16("re"), s(re));
    }
    m.insert(
        json::utf16("body"),
        Json::from_value(&serde_json::Value::Object(d.body.clone())),
    );
    if let Some(sig) = sig {
        m.insert(json::utf16("sig"), s(sig));
    }
    Json::Obj(m)
}

/// Sign a draft and return the frame text, which is its own canonical form. Fails only for a body the protocol
/// cannot carry (a fraction, an unsafe integer, a non-ASCII key) -- a bug in the caller, reported rather than sent.
pub fn seal(draft: &Draft, key: &SigningKey) -> Result<String, String> {
    let kid = kid_of(&key.verifying_key().to_bytes());
    let unsigned = json::canonicalize(&envelope_json(draft, &kid, None))?;
    let sig = crate::b64::encode(&key.sign(&signing_input(&unsigned)).to_bytes());
    json::canonicalize(&envelope_json(draft, &kid, Some(&sig)))
}

/// A key this receiver trusts, and the only `from` it may sign for.
#[derive(Debug, Clone)]
pub struct TrustedKey {
    pub owner: String,
    pub key: VerifyingKey,
}

#[derive(Debug, Clone, Default)]
pub struct Keyring {
    keys: HashMap<String, TrustedKey>,
}

impl Keyring {
    /// Trust `public` to sign for `owner`. Returns its kid. Fails for bytes that are not a curve point.
    pub fn add(&mut self, owner: &str, public: &[u8; 32]) -> Result<String, String> {
        let key = VerifyingKey::from_bytes(public)
            .map_err(|_| "not an Ed25519 public key".to_string())?;
        let kid = kid_of(public);
        self.keys.insert(
            kid.clone(),
            TrustedKey {
                owner: owner.to_string(),
                key,
            },
        );
        Ok(kid)
    }

    pub fn get(&self, kid: &str) -> Option<&TrustedKey> {
        self.keys.get(kid)
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

const FIELDS: [&str; 10] = [
    "v", "type", "id", "ts", "from", "to", "kid", "re", "body", "sig",
];

fn is_type(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=64).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || *c == b'_' || *c == b'.')
}

pub fn is_party(s: &str) -> bool {
    s == "cloud" || s.strip_prefix("dev_").is_some_and(ulid::is_ulid)
}

fn is_b64url(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// 64 bytes as unpadded base64url: 86 characters, and since those carry 516 bits for 512, the last character's
/// four unused bits are zero -- it is `A`, `Q`, `g` or `w`. Lenient decoders ignore those bits and strict ones refuse
/// them; checking the spelling here, with the other field formats, keeps every implementation on one answer.
fn is_sig(s: &str) -> bool {
    is_b64url(s, 86) && s.ends_with(['A', 'Q', 'g', 'w'])
}

/// One receiver's verifier: who it is, whom it trusts, and the ids it has already accepted.
pub struct Verifier {
    me: String,
    keys: Keyring,
    seen: HashMap<String, i64>,
}

impl Verifier {
    pub fn new(me: &str, keys: Keyring) -> Verifier {
        Verifier {
            me: me.to_string(),
            keys,
            seen: HashMap::new(),
        }
    }

    pub fn me(&self) -> &str {
        &self.me
    }

    /// Verify one raw text frame at receiver time `now` (ms). The checks run in [`RejectCode`] order.
    pub fn verify(&mut self, raw: &str, now: i64) -> Result<Envelope, Rejection> {
        // 1. At most MAX_FRAME_BYTES, a JSON object, `v` an integer. Size first: nothing larger is even parsed.
        //    The version is read before anything else is interpreted: a v2 frame may legitimately have a shape v1
        //    does not understand, and the honest answer is "unsupported", not "malformed".
        if raw.len() > MAX_FRAME_BYTES {
            return reject(
                RejectCode::Malformed,
                format!(
                    "frame is {} bytes, over the {MAX_FRAME_BYTES}-byte limit",
                    raw.len()
                ),
            );
        }
        let parsed = match json::parse(raw) {
            Ok(v) => v,
            Err(e) => return reject(RejectCode::Malformed, format!("not JSON: {e}")),
        };
        let Json::Obj(fields) = &parsed else {
            return reject(RejectCode::Malformed, "not an object");
        };
        let Some(v) = parsed.get("v").and_then(Json::as_safe_integer) else {
            return reject(RejectCode::Malformed, "v is not an integer");
        };
        // 2.
        if v != VERSION {
            return reject(RejectCode::UnsupportedVersion, format!("v={v}"));
        }
        // 3. The closed field set and each field's format.
        let known: Vec<Vec<u16>> = FIELDS.iter().map(|f| json::utf16(f)).collect();
        if let Some(k) = fields.keys().find(|k| !known.contains(k)) {
            return reject(
                RejectCode::Malformed,
                format!("unknown field {}", String::from_utf16_lossy(k)),
            );
        }
        let text = |name: &str, ok: fn(&str) -> bool| -> Result<String, Rejection> {
            match parsed.get(name).and_then(Json::as_string) {
                Some(s) if ok(&s) => Ok(s),
                _ => reject(RejectCode::Malformed, name),
            }
        };
        let kind = text("type", is_type)?;
        let id = text("id", ulid::is_ulid)?;
        let ts = match parsed.get("ts").and_then(Json::as_safe_integer) {
            Some(ts) if ts >= 0 => ts,
            _ => return reject(RejectCode::Malformed, "ts"),
        };
        let from = text("from", is_party)?;
        let to = text("to", is_party)?;
        let kid = text("kid", |s| is_b64url(s, 16))?;
        let re = match parsed.get("re") {
            None => None,
            Some(_) => Some(text("re", ulid::is_ulid)?),
        };
        let Some(body @ Json::Obj(_)) = parsed.get("body") else {
            return reject(RejectCode::Malformed, "body");
        };
        let sig = text("sig", is_sig)?;
        // 4.
        let canon = match json::canonicalize(&parsed) {
            Ok(c) => c,
            Err(e) => return reject(RejectCode::Malformed, e),
        };
        // 5. The raw text must *be* the canonical form, not merely parse to something that has one. This is what
        //    makes parser differences irrelevant: duplicate keys, whitespace, alternative escapes, `1e3` -- any
        //    frame on which two parsers could disagree is one no honest sender produces.
        if canon != raw {
            return reject(
                RejectCode::NonCanonical,
                "frame text is not its own canonical form",
            );
        }
        // 6. A key only ever signs for its owner.
        let Some(trusted) = self.keys.get(&kid).filter(|k| k.owner == from) else {
            return reject(
                RejectCode::UnknownKey,
                format!("kid {kid} does not sign for {from}"),
            );
        };
        // 7.
        let mut unsigned = fields.clone();
        unsigned.remove(&json::utf16("sig"));
        let input =
            signing_input(
                &json::canonicalize(&Json::Obj(unsigned)).map_err(|e| Rejection {
                    code: RejectCode::Malformed,
                    why: e,
                })?,
            );
        let verified = crate::b64::decode_array::<64>(&sig).is_some_and(|bytes| {
            trusted
                .key
                .verify(&input, &Signature::from_bytes(&bytes))
                .is_ok()
        });
        if !verified {
            return reject(RejectCode::BadSignature, "signature does not verify");
        }
        // Only authenticated frames get past this point, so the codes below are facts about the sender.
        // 8.
        if to != self.me {
            return reject(RejectCode::WrongRecipient, format!("addressed to {to}"));
        }
        // 9.
        if (now - ts).abs() > WINDOW_MS {
            return reject(RejectCode::Stale, format!("ts is {} ms from now", now - ts));
        }
        // 10.
        self.seen
            .retain(|_, seen_at| now - *seen_at <= REPLAY_MEMORY_MS);
        let seen_key = format!("{from}/{id}");
        if self.seen.contains_key(&seen_key) {
            return reject(RejectCode::Replay, format!("id {id} already seen"));
        }
        self.seen.insert(seen_key, now);
        let serde_json::Value::Object(body) = body.to_value() else {
            unreachable!("body was checked to be an object");
        };
        Ok(Envelope {
            kind,
            id,
            ts,
            from,
            to,
            kid,
            re,
            body,
            sig,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn draft(to: &str) -> Draft {
        let mut body = Body::new();
        body.insert("key".into(), "01M423B2F0ZQ7WE38ED5J4MYAE".into());
        Draft {
            kind: "ack".into(),
            id: ulid::new(1_000_000),
            ts: 1_000_000,
            from: "cloud".into(),
            to: to.into(),
            re: None,
            body,
        }
    }

    const ME: &str = "dev_01M3ZGYZ00MZDA2E2C003XDNC6";

    #[test]
    fn sealed_frames_verify_once() {
        let k = key(7);
        let mut ring = Keyring::default();
        ring.add("cloud", &k.verifying_key().to_bytes()).unwrap();
        let mut v = Verifier::new(ME, ring);
        let frame = seal(&draft(ME), &k).unwrap();
        let env = v.verify(&frame, 1_000_000).unwrap();
        assert_eq!(env.kind, "ack");
        assert_eq!(env.body["key"], "01M423B2F0ZQ7WE38ED5J4MYAE");
        assert_eq!(
            v.verify(&frame, 1_000_001).unwrap_err().code,
            RejectCode::Replay
        );
    }

    #[test]
    fn replay_memory_outlives_the_window() {
        let k = key(7);
        let mut ring = Keyring::default();
        ring.add("cloud", &k.verifying_key().to_bytes()).unwrap();
        let mut v = Verifier::new(ME, ring);
        // Dated at the far future edge of the window, so it stays acceptable for 10 minutes after first sight.
        let mut d = draft(ME);
        d.ts = 1_000_000 + WINDOW_MS;
        let frame = seal(&d, &k).unwrap();
        v.verify(&frame, 1_000_000).unwrap();
        assert_eq!(
            v.verify(&frame, 1_000_000 + REPLAY_MEMORY_MS)
                .unwrap_err()
                .code,
            RejectCode::Replay
        );
        assert_eq!(
            v.verify(&frame, 1_000_000 + REPLAY_MEMORY_MS + 1)
                .unwrap_err()
                .code,
            RejectCode::Stale
        );
    }

    #[test]
    fn seal_refuses_bodies_the_protocol_cannot_carry() {
        let mut d = draft(ME);
        d.body.insert("x".into(), serde_json::json!(1.5));
        assert!(seal(&d, &key(1)).is_err());
        let mut d = draft(ME);
        d.body.insert("caf\u{e9}".into(), serde_json::json!(1));
        assert!(seal(&d, &key(1)).is_err());
    }

    #[test]
    fn codes_are_spelled_as_in_the_reference() {
        let names: Vec<_> = RejectCode::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(
            names,
            [
                "malformed",
                "unsupported_version",
                "non_canonical",
                "unknown_key",
                "bad_signature",
                "wrong_recipient",
                "stale",
                "replay"
            ]
        );
    }
}
