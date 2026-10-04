// Canonical JSON for wire protocol v1 (docs/cloud-agent.md section 5.3).
//
// This is the Worker's own implementation, written against the document and tested against
// fixtures/wire/v1/canonical.json -- deliberately not an import of tools/wire-fixtures.ts. The reference exists
// so that independent implementations can disagree with it in CI; one that re-exports the reference can only
// ever agree. test/arch-boundary.test.ts in the root suite fails if cloud/ imports anything from tools/.
//
// RFC 8785 (JCS), restricted so that its two hard parts never arise:
//  * numbers are safe integers only. JCS serialises numbers with ECMAScript's shortest round-trip double
//    formatting, which other languages struggle to reproduce; the protocol has no fractions (times are integer
//    milliseconds), so it refuses them instead.
//  * object keys are printable ASCII only. JCS sorts keys by UTF-16 code units, Rust's BTreeMap by UTF-8
//    bytes; the two orders agree everywhere below U+FFFF, and ASCII keys keep "sorted" one thing everywhere.
// Strings are escaped exactly as JSON.stringify escapes them (that is what JCS specifies), and lone surrogates
// are refused: JCS refuses them, and the Rust agent's strings cannot hold them.

export class CanonicalError extends Error {}

const KEY_RE = /^[\x20-\x7e]+$/;

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new CanonicalError(`not a safe integer: ${value}`);
      // String(-0) is "0", which is what JCS wants.
      return String(value);
    case 'string':
      if (!value.isWellFormed()) throw new CanonicalError('string holds a lone surrogate');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      // The default sort compares UTF-16 code units; with ASCII-only keys that is byte order too.
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        if (!KEY_RE.test(k)) throw new CanonicalError(`key is not printable ASCII: ${JSON.stringify(k)}`);
        parts.push(`${JSON.stringify(k)}:${canonicalize(obj[k])}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      // undefined, functions, bigints, symbols: none of them is JSON, and silently dropping one (as
      // JSON.stringify does with undefined) would sign something other than what the caller built.
      throw new CanonicalError(`not a JSON value: ${typeof value}`);
  }
}
