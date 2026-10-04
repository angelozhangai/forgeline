// Identifier formats shared by the routes, the Hub and the wire module (docs/cloud-agent.md section 5.2).
//
// ULIDs are generated here rather than pulled in from a package: it is a dozen lines, the Worker has no runtime
// dependencies (section 11.2), and the format is pinned by the wire fixtures anyway.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const DEVICE_ID_RE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isDeviceId(s: string): boolean {
  return DEVICE_ID_RE.test(s);
}

// 48 bits of milliseconds, then 80 random bits, in Crockford base32. Not monotonic within a millisecond:
// nothing here sorts ids generated in the same millisecond against each other, and ids are nonces, so
// unpredictability matters more than order.
export function ulid(ms: number = Date.now()): string {
  let n = BigInt(ms);
  for (const b of crypto.getRandomValues(new Uint8Array(10))) n = (n << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 26; i++) {
    s = CROCKFORD[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}
