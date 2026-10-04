// base64url without padding (RFC 4648 section 5), the encoding of every key, signature and nonce on the wire.
//
// Built on btoa/atob because the Worker has no Buffer (no nodejs_compat, see wrangler.jsonc). atob implements
// the WHATWG "forgiving-base64 decode": padding is optional and the unused low bits of the last character are
// discarded, exactly like Node's Buffer.from(s, 'base64url') in the reference implementation
// (tools/wire-fixtures.ts). Callers check the alphabet and length with a regex first, so atob only ever sees
// strings it can decode.

export function encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decode(s: string): Uint8Array {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
