//! The JSON the wire verifier sees, and its canonical form (docs/cloud-agent.md section 5.3).
//!
//! Why not just serde_json: the verification order (section 5.4) is part of the protocol, and the reference
//! (tools/wire-fixtures.ts) reads frames with ECMAScript's `JSON.parse`. That parser accepts things serde_json
//! refuses -- a lone surrogate escape (`"\ud800"`), a number too large for a double (`1e400` becomes Infinity),
//! any nesting depth -- and only refuses them later, at canonicalisation. So a frame with `"v":2` *and* a lone
//! surrogate somewhere in its body is `unsupported_version` in the reference; with serde_json it would be
//! `malformed`, and the audit trails of the cloud and the device would disagree about the same frame.
//!
//! This reader therefore models `JSON.parse` exactly: numbers are IEEE doubles (parsed with correct rounding,
//! as JavaScript does), strings are sequences of UTF-16 code units (so lone surrogates survive parsing), a
//! duplicated key keeps its last value, and object keys sort by UTF-16 code units, which is what
//! `Array.prototype.sort` does. Nesting depth is bounded by the protocol itself ([`MAX_DEPTH`]).
//!
//! The canonical form is RFC 8785 restricted as the protocol says: safe integers only, printable-ASCII keys,
//! strings escaped exactly as `JSON.stringify` escapes them, lone surrogates refused.

use std::collections::BTreeMap;

/// Deepest nesting a frame may have, the envelope being depth 1 (docs/cloud-agent.md section 5.4, check 1). The
/// protocol bounds it because a Rust stack overflow is an abort, not an error -- and a bound only one implementation
/// enforced made a deep `"v":2` frame `malformed` here and `unsupported_version` in the reference. The reference and
/// the cloud check it on the raw text before parsing; refusing while parsing gives the same verdict, because every
/// failure at check 1 is `malformed`. Pinned by the fixtures `accept-depth-limit`, `reject-too-deep` and
/// `order-depth-before-version`.
pub const MAX_DEPTH: usize = 32;

/// 2^53 - 1: the largest integer a double holds exactly, and so the largest number the protocol allows.
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    /// UTF-16 code units, exactly as JavaScript holds a string; may contain lone surrogates.
    Str(Vec<u16>),
    Arr(Vec<Json>),
    /// Keyed by UTF-16 code units, so iteration order is JavaScript's default sort order.
    Obj(BTreeMap<Vec<u16>, Json>),
}

pub fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// The safe integer a number holds, if it holds one. `-0` is the integer 0, as `Number.isSafeInteger` says.
pub fn safe_integer(n: f64) -> Option<i64> {
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER {
        Some(n as i64)
    } else {
        None
    }
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(map) => map.get(&utf16(key)),
            _ => None,
        }
    }

    /// The string, if this is a well-formed string (no lone surrogates).
    pub fn as_string(&self) -> Option<String> {
        match self {
            Json::Str(units) => String::from_utf16(units).ok(),
            _ => None,
        }
    }

    pub fn as_safe_integer(&self) -> Option<i64> {
        match self {
            Json::Num(n) => safe_integer(*n),
            _ => None,
        }
    }

    /// Convert from serde_json, for values this program builds and is about to sign. A number serde_json holds
    /// as an integer is converted through f64 exactly as JavaScript would hold it; canonicalisation then refuses
    /// anything that is not a safe integer.
    pub fn from_value(v: &serde_json::Value) -> Json {
        match v {
            serde_json::Value::Null => Json::Null,
            serde_json::Value::Bool(b) => Json::Bool(*b),
            serde_json::Value::Number(n) => Json::Num(n.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(s) => Json::Str(utf16(s)),
            serde_json::Value::Array(items) => {
                Json::Arr(items.iter().map(Json::from_value).collect())
            }
            serde_json::Value::Object(map) => Json::Obj(
                map.iter()
                    .map(|(k, v)| (utf16(k), Json::from_value(v)))
                    .collect(),
            ),
        }
    }

    /// Convert to serde_json. Only meaningful for a value that has already canonicalised (so every number is a
    /// safe integer and every string well formed); anything else is replaced by null rather than invented.
    pub fn to_value(&self) -> serde_json::Value {
        match self {
            Json::Null => serde_json::Value::Null,
            Json::Bool(b) => serde_json::Value::Bool(*b),
            Json::Num(n) => {
                safe_integer(*n).map_or(serde_json::Value::Null, serde_json::Value::from)
            }
            Json::Str(units) => {
                String::from_utf16(units).map_or(serde_json::Value::Null, serde_json::Value::String)
            }
            Json::Arr(items) => {
                serde_json::Value::Array(items.iter().map(Json::to_value).collect())
            }
            Json::Obj(map) => serde_json::Value::Object(
                map.iter()
                    .filter_map(|(k, v)| String::from_utf16(k).ok().map(|k| (k, v.to_value())))
                    .collect(),
            ),
        }
    }
}

/// Parse text the way `JSON.parse` does (see the module comment). The error is a short English reason.
pub fn parse(text: &str) -> Result<Json, String> {
    let mut p = Parser { text, i: 0 };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != text.len() {
        return Err(format!("unexpected text after the value at byte {}", p.i));
    }
    Ok(v)
}

struct Parser<'a> {
    text: &'a str,
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.i).copied()
    }

    // JSON whitespace is exactly these four; a BOM or a non-breaking space is not whitespace to JSON.parse.
    fn ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.i += 1;
        }
    }

    fn expect(&mut self, b: u8) -> Result<(), String> {
        if self.peek() == Some(b) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at byte {}", char::from(b), self.i))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, String> {
        match self.peek() {
            None => Err("unexpected end of text".into()),
            Some(b'{') => self.object(depth + 1),
            Some(b'[') => self.array(depth + 1),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => self.literal("true", Json::Bool(true)),
            Some(b'f') => self.literal("false", Json::Bool(false)),
            Some(b'n') => self.literal("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(format!("unexpected character at byte {}", self.i)),
        }
    }

    fn literal(&mut self, word: &str, v: Json) -> Result<Json, String> {
        if self.text[self.i..].starts_with(word) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(format!("unexpected character at byte {}", self.i))
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, String> {
        if depth > MAX_DEPTH {
            return Err(format!("nested deeper than {MAX_DEPTH} levels"));
        }
        self.i += 1;
        self.ws();
        let mut map = BTreeMap::new();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Json::Obj(map));
        }
        loop {
            if self.peek() != Some(b'"') {
                return Err(format!("expected a key at byte {}", self.i));
            }
            let k = self.string()?;
            self.ws();
            self.expect(b':')?;
            self.ws();
            let v = self.value(depth)?;
            // A duplicated key keeps its last value, as in JSON.parse. Canonical text can never contain one, so
            // such a frame always ends up non_canonical; what matters is that it gets that far, as it does there.
            map.insert(k, v);
            self.ws();
            match self.peek() {
                Some(b',') => {
                    self.i += 1;
                    self.ws();
                }
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Obj(map));
                }
                _ => return Err(format!("expected ',' or '}}' at byte {}", self.i)),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, String> {
        if depth > MAX_DEPTH {
            return Err(format!("nested deeper than {MAX_DEPTH} levels"));
        }
        self.i += 1;
        self.ws();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value(depth)?);
            self.ws();
            match self.peek() {
                Some(b',') => {
                    self.i += 1;
                    self.ws();
                }
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(format!("expected ',' or ']' at byte {}", self.i)),
            }
        }
    }

    fn string(&mut self) -> Result<Vec<u16>, String> {
        self.i += 1; // the opening quote
        let mut out = Vec::new();
        loop {
            let Some(b) = self.peek() else {
                return Err("unterminated string".into());
            };
            match b {
                b'"' => {
                    self.i += 1;
                    return Ok(out);
                }
                b'\\' => {
                    let esc = self.text.as_bytes().get(self.i + 1).copied();
                    self.i += 2;
                    let unit = match esc {
                        Some(b'"') => 0x22,
                        Some(b'\\') => 0x5c,
                        Some(b'/') => 0x2f,
                        Some(b'b') => 0x08,
                        Some(b'f') => 0x0c,
                        Some(b'n') => 0x0a,
                        Some(b'r') => 0x0d,
                        Some(b't') => 0x09,
                        Some(b'u') => {
                            let hex = self
                                .text
                                .get(self.i..self.i + 4)
                                .ok_or("truncated \\u escape")?;
                            if !hex.bytes().all(|h| h.is_ascii_hexdigit()) {
                                return Err(format!("bad \\u escape at byte {}", self.i));
                            }
                            self.i += 4;
                            // A lone surrogate is kept as is: JSON.parse accepts it, and canonicalisation is what
                            // refuses it (check 4, after the version check).
                            u16::from_str_radix(hex, 16).map_err(|e| e.to_string())?
                        }
                        _ => return Err(format!("bad escape at byte {}", self.i - 1)),
                    };
                    out.push(unit);
                }
                0x00..=0x1f => {
                    return Err(format!(
                        "raw control character in a string at byte {}",
                        self.i
                    ));
                }
                0x20..=0x7f => {
                    out.push(u16::from(b));
                    self.i += 1;
                }
                _ => {
                    // Non-ASCII: the input is a &str, so a whole character starts here.
                    let c = self.text[self.i..]
                        .chars()
                        .next()
                        .ok_or("unterminated string")?;
                    let mut buf = [0u16; 2];
                    out.extend_from_slice(c.encode_utf16(&mut buf));
                    self.i += c.len_utf8();
                }
            }
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.i;
        let bytes = self.text.as_bytes();
        let digits = |i: &mut usize| {
            let s = *i;
            while bytes.get(*i).is_some_and(u8::is_ascii_digit) {
                *i += 1;
            }
            *i - s
        };
        let mut i = self.i;
        if bytes.get(i) == Some(&b'-') {
            i += 1;
        }
        match bytes.get(i) {
            Some(b'0') => i += 1,
            Some(b'1'..=b'9') => {
                digits(&mut i);
            }
            _ => return Err(format!("bad number at byte {start}")),
        }
        if bytes.get(i) == Some(&b'.') {
            i += 1;
            if digits(&mut i) == 0 {
                return Err(format!("bad number at byte {start}"));
            }
        }
        if let Some(b'e' | b'E') = bytes.get(i) {
            i += 1;
            if let Some(b'+' | b'-') = bytes.get(i) {
                i += 1;
            }
            if digits(&mut i) == 0 {
                return Err(format!("bad number at byte {start}"));
            }
        }
        self.i = i;
        // Rust's float parsing is correctly rounded, like JavaScript's, and overflows to infinity rather than
        // failing, like JavaScript's. Both matter: `1e400` must parse here and be refused later.
        let n: f64 = self.text[start..i]
            .parse()
            .map_err(|_| format!("bad number at byte {start}"))?;
        Ok(Json::Num(n))
    }
}

/// The canonical form of a value, or why it has none. Every error here is `malformed` (check 4).
pub fn canonicalize(v: &Json) -> Result<String, String> {
    let mut out = String::new();
    write(v, &mut out)?;
    Ok(out)
}

fn write(v: &Json, out: &mut String) -> Result<(), String> {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Num(n) => match safe_integer(*n) {
            Some(i) => out.push_str(&i.to_string()),
            None => return Err(format!("not a safe integer: {n}")),
        },
        Json::Str(units) => quote(units, out)?,
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out)?;
            }
            out.push(']');
        }
        Json::Obj(map) => {
            out.push('{');
            for (i, (k, item)) in map.iter().enumerate() {
                // Printable ASCII only, and at least one character: the reference's /^[\x20-\x7e]+$/.
                if k.is_empty() || !k.iter().all(|u| (0x20..=0x7e).contains(u)) {
                    return Err("an object key is empty or not printable ASCII".into());
                }
                if i > 0 {
                    out.push(',');
                }
                quote(k, out)?;
                out.push(':');
                write(item, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

// Exactly JSON.stringify's QuoteJSONString: the seven short escapes, \u00xx (lowercase hex) for the remaining
// control characters, and every other character as itself -- including U+2028, U+2029 and DEL.
fn quote(units: &[u16], out: &mut String) -> Result<(), String> {
    out.push('"');
    for c in char::decode_utf16(units.iter().copied()) {
        let c = c.map_err(|_| "a string holds a lone surrogate".to_string())?;
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(text: &str) -> Result<String, String> {
        canonicalize(&parse(text)?)
    }

    #[test]
    fn parses_what_json_parse_parses() {
        assert_eq!(
            canon(" {\"a\" : [1, -0, 1.0, 1e3, 10E-1, true, false, null]} ").unwrap(),
            "{\"a\":[1,0,1,1000,1,true,false,null]}"
        );
        assert_eq!(canon("\"\\u00E9\\/\"").unwrap(), "\"\u{e9}/\"");
    }

    #[test]
    fn refuses_what_json_parse_refuses() {
        for bad in [
            "",
            "01",
            "1.",
            ".5",
            "+1",
            "-",
            "[1,]",
            "{\"a\":1,}",
            "{a:1}",
            "'a'",
            "\"\t\"",
            "\u{feff}1",
            "1 2",
            "[",
            "\"\\x\"",
            "nul",
            "\"\\u12\"",
        ] {
            assert!(parse(bad).is_err(), "{bad:?} should not parse");
        }
    }

    #[test]
    fn parses_then_refuses_lone_surrogates_and_unsafe_numbers() {
        // Parsing must succeed (as in JSON.parse); only the canonical form refuses them.
        for text in [
            "\"\\ud800\"",
            "\"\\udc00x\"",
            "1e400",
            "9007199254740992",
            "1.5",
            "99999999999999999999999",
        ] {
            let v = parse(text).unwrap_or_else(|e| panic!("{text}: {e}"));
            assert!(
                canonicalize(&v).is_err(),
                "{text} should have no canonical form"
            );
        }
        // A correctly paired surrogate is one character.
        assert_eq!(canon("\"\\ud83d\\ude80\"").unwrap(), "\"\u{1F680}\"");
    }

    #[test]
    fn duplicate_keys_keep_the_last_value() {
        assert_eq!(canon("{\"a\":1,\"a\":2}").unwrap(), "{\"a\":2}");
    }

    #[test]
    fn keys_sort_by_utf16_code_units() {
        // U+FF61 sorts after U+1F680 in UTF-16 (0xFF61 > 0xD83D) but before it in UTF-8 or by code point.
        // Such keys are refused by the canonical form anyway; the order is checked on the parsed tree.
        let v = parse("{\"\\uff61\":1,\"\\ud83d\\ude80\":2}").unwrap();
        let Json::Obj(map) = v else { panic!() };
        let keys: Vec<_> = map.keys().cloned().collect();
        assert_eq!(keys, vec![vec![0xd83d, 0xde80], vec![0xff61]]);
    }

    #[test]
    fn refuses_empty_and_non_ascii_keys() {
        assert!(canon("{\"\":1}").is_err());
        assert!(canon("{\"caf\\u00e9\":1}").is_err());
        assert!(canon("{\"a\\u007f\":1}").is_err());
    }

    #[test]
    fn depth_is_bounded() {
        let ok = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        assert!(parse(&ok).is_ok());
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
        assert!(parse(&deep).is_err());
    }

    #[test]
    fn serde_round_trip_of_canonical_values() {
        let v = parse("{\"b\":[1,{\"c\":\"\\u0001\"}],\"a\":-5}").unwrap();
        assert_eq!(Json::from_value(&v.to_value()), v);
    }
}
