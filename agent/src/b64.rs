//! base64url without padding (RFC 4648 section 5): the only encoding the wire protocol uses for keys, signatures
//! and nonces (docs/cloud-agent.md section 5.3).
//!
//! Written here rather than pulled in because the protocol depends on one precise behaviour that general-purpose
//! decoders make configurable and default differently: what to do with the unused low bits of the last character.
//! Node's decoder (behind the reference) and `atob` (in the Worker) ignore them; strict decoders refuse them. The
//! protocol settles it by requiring them to be zero -- for a signature, the last character is one of `A Q g w`,
//! checked with the field formats (check 3) -- and this decoder is strict to match: one spelling per value.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = |i: usize| u32::from(chunk.get(i).copied().unwrap_or(0));
        let n = (b(0) << 16) | (b(1) << 8) | b(2);
        // 1 byte -> 2 characters, 2 -> 3, 3 -> 4: no padding.
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

fn sextet(c: u8) -> Option<u32> {
    let v = match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'-' => 62,
        b'_' => 63,
        _ => return None,
    };
    Some(u32::from(v))
}

/// Decode unpadded base64url. `None` for a character outside the alphabet, padding, a length that no byte string
/// encodes to (4n + 1), or a last character whose unused low bits are not zero.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3 + 2);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= sextet(c)? << (18 - 6 * i);
        }
        let produced = chunk.len() - 1;
        // The bits below the last whole byte: 8 of the 24 for a 3-character tail, 16 for a 2-character one.
        if n & (0x00ff_ffff >> (8 * produced)) != 0 {
            return None;
        }
        for i in 0..produced {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    Some(out)
}

/// Decode into exactly `N` bytes, or `None`.
pub fn decode_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    decode(text)?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4648_vectors_without_padding() {
        for (raw, enc) in [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg"),
            ("fooba", "Zm9vYmE"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode(raw.as_bytes()), enc);
            assert_eq!(decode(enc).unwrap(), raw.as_bytes());
        }
    }

    #[test]
    fn url_safe_alphabet() {
        assert_eq!(encode(&[0xfb, 0xff]), "-_8");
        assert_eq!(decode("-_8").unwrap(), vec![0xfb, 0xff]);
    }

    #[test]
    fn refuses_padding_foreign_characters_and_impossible_lengths() {
        assert_eq!(decode("Zg=="), None);
        assert_eq!(decode("Zm9v+A"), None);
        assert_eq!(decode("Zm9v/A"), None);
        assert_eq!(decode("Z"), None);
        assert_eq!(decode("Zm9vY"), None);
    }

    #[test]
    fn refuses_unused_trailing_bits() {
        // "Zg" and "Zh" differ only in the 4 bits that do not reach the output byte: one spelling per value.
        assert_eq!(decode_array::<1>("Zg"), Some(*b"f"));
        assert_eq!(decode("Zh"), None);
        assert_eq!(decode("Zm9"), None, "a 3-character tail has 2 unused bits");
        assert_eq!(decode("Zm8").unwrap(), b"fo");
    }
}
