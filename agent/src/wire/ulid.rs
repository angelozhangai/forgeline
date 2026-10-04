//! ULIDs: 48 bits of milliseconds and 80 random bits, in Crockford base32. Envelope ids, job and event ids, and
//! device ids are all ULIDs (docs/cloud-agent.md section 5.2). A few lines here instead of a crate, as section
//! 11.1 says; the fixtures pin the encoding.

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The format check the reference applies (`/^[0-9A-HJKMNP-TV-Z]{26}$/`). It deliberately does not check that the
/// first character is 0-7 (the 128-bit bound): the reference does not, and the two must agree on what is malformed.
pub fn is_ulid(s: &str) -> bool {
    s.len() == 26 && s.bytes().all(|b| CROCKFORD.contains(&b))
}

/// Encode a timestamp and 80 bits of randomness.
pub fn encode(ms: u64, random: [u8; 10]) -> String {
    let mut r = [0u8; 16];
    r[6..].copy_from_slice(&random);
    let mut n = (u128::from(ms & 0xffff_ffff_ffff) << 80) | u128::from_be_bytes(r);
    let mut out = [0u8; 26];
    for slot in out.iter_mut().rev() {
        *slot = CROCKFORD[(n & 31) as usize];
        n >>= 5;
    }
    out.iter().map(|&b| char::from(b)).collect()
}

/// A fresh ULID for `ms`.
pub fn new(ms: i64) -> String {
    encode(u64::try_from(ms).unwrap_or(0), crate::wire::random_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_the_reference() {
        // tools/wire-fixtures.ts: DEVICE = `dev_${ulid(NOW - 86_400_000, 'device:test')}`, where the 80 random bits
        // are the first 10 bytes of SHA-256(label).
        use sha2::{Digest, Sha256};
        let rnd: [u8; 10] = Sha256::digest(b"device:test")[..10].try_into().unwrap();
        assert_eq!(
            encode(1_791_072_000_000 - 86_400_000, rnd),
            "01M3ZGYZ00MZDA2E2C003XDNC6"
        );
    }

    #[test]
    fn fresh_ids_are_well_formed_and_distinct() {
        let a = new(1_791_072_000_000);
        let b = new(1_791_072_000_000);
        assert!(is_ulid(&a) && is_ulid(&b));
        assert_ne!(a, b);
        assert_eq!(&a[..10], &b[..10], "same millisecond, same time prefix");
    }

    #[test]
    fn format_check() {
        assert!(is_ulid("01M423BN0RBT69J0H0FBXEPW90"));
        assert!(
            is_ulid("ZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
            "the reference does not bound the first character"
        );
        assert!(!is_ulid("01m423bn0rbt69j0h0fbxepw90"));
        assert!(!is_ulid("01M423BN0RBT69J0H0FBXEPW9I"));
        assert!(!is_ulid("01M423BN0RBT69J0H0FBXEPW9"));
    }
}
