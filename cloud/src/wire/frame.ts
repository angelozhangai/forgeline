// Wire protocol v1 framing on WebCrypto Ed25519: envelope verification and signing
// (docs/cloud-agent.md sections 5.2-5.4).
//
// The contract is fixtures/wire/v1/, not this file: test/wire.test.ts feeds every fixture through
// verifyFrame() and requires exactly the stated verdict, and re-signs every accepted fixture frame with
// seal() and requires the identical bytes (Ed25519 is deterministic, so a fixed key gives a fixed signature).
// When this file and the fixtures disagree, this file is wrong -- or the protocol is changing, in which case
// the reference (tools/wire-fixtures.ts) and the fixtures change first.
import * as b64 from './base64url.ts';
import { CanonicalError, canonicalize } from './canonical.ts';

// Prepended to the canonical bytes before signing, so a signature made for this protocol can never be
// replayed as a valid signature in another context that signs JSON with the same key; v2 gets a new prefix.
export const DOMAIN = 'forgeline-wire/1\n';
export const VERSION = 1;
// |now - ts| must be at most this (inclusive). It also bounds how long ids must stay in the replay cache.
export const WINDOW_MS = 300_000;
// Frame size limit (sections 5.4 step 1 and 5.11), in UTF-8 bytes of the raw text. Checked before parsing,
// because parsing is the expensive part an oversized frame would be sent to provoke.
export const MAX_FRAME_BYTES = 64 * 1024;

// The rejection codes, in the order the checks run (section 5.4). The order is part of the protocol: a frame
// that is wrong in two ways must get the same code from every implementation, or the audit trails disagree.
export const REJECT_CODES = ['malformed', 'unsupported_version', 'non_canonical', 'unknown_key', 'bad_signature', 'wrong_recipient', 'stale', 'replay'] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export interface Envelope {
  v: number;
  type: string;
  id: string;
  ts: number;
  from: string;
  to: string;
  kid: string;
  re?: string;
  body: Record<string, unknown>;
  sig: string;
}
export type Unsigned = Omit<Envelope, 'sig'>;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PARTY_RE = /^(cloud|dev_[0-9A-HJKMNP-TV-Z]{26})$/;
const KID_RE = /^[A-Za-z0-9_-]{16}$/;
// 64 bytes, base64url without padding: 86 characters carry 516 bits for 512, so the last character's four low bits
// are unused and must be zero (A, Q, g or w). atob ignores those bits; Rust's base64 refuses them. Without this
// rule the same frame would verify here and be malformed on the device.
const SIG_RE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const TYPE_RE = /^[a-z][a-z_.]{0,63}$/;
const FIELDS = new Set(['v', 'type', 'id', 'ts', 'from', 'to', 'kid', 're', 'body', 'sig']);

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

// Check 3 of section 5.4: the field set and every field's format. Returns what is wrong, or null.
// Shared by verifyFrame() and seal(), so the Worker can never emit a frame its own verifier calls malformed.
function shapeError(e: Record<string, unknown>): string | null {
  for (const k of Object.keys(e)) if (!FIELDS.has(k)) return `unknown field ${k}`;
  if (typeof e.type !== 'string' || !TYPE_RE.test(e.type)) return 'type';
  if (typeof e.id !== 'string' || !ULID_RE.test(e.id)) return 'id';
  if (typeof e.ts !== 'number' || !Number.isSafeInteger(e.ts) || e.ts < 0) return 'ts';
  if (typeof e.from !== 'string' || !PARTY_RE.test(e.from)) return 'from';
  if (typeof e.to !== 'string' || !PARTY_RE.test(e.to)) return 'to';
  if (typeof e.kid !== 'string' || !KID_RE.test(e.kid)) return 'kid';
  if ('re' in e && (typeof e.re !== 'string' || !ULID_RE.test(e.re))) return 're';
  if (!isObject(e.body)) return 'body';
  if (typeof e.sig !== 'string' || !SIG_RE.test(e.sig)) return 'sig';
  return null;
}

const utf8 = new TextEncoder();

export function signingInput(unsigned: Unsigned): Uint8Array {
  return utf8.encode(DOMAIN + canonicalize(unsigned));
}

// A key id is derived from the key, never assigned: no registry to keep in sync, and the same short string is
// the fingerprint a human compares at enrolment.
export async function kidOf(rawPublicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawPublicKey));
  return b64.encode(digest).slice(0, 16);
}

export async function importPublicKey(rawPublicKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawPublicKey, { name: 'Ed25519' }, false, ['verify']);
}

// -- Verification ---------------------------------------------------------------------------------

export interface TrustedKey {
  owner: string; // 'cloud' or a device id: the only `from` this key may sign for
  key: CryptoKey;
}

// Ids accepted inside the window, keyed `${from}/${id}`. Deliberately synchronous: verifyFrame() checks and
// records in one step after its last await, so two copies of a frame verified concurrently cannot both pass.
// A Hub that persists the cache loads it before verifying, rather than making this interface async.
export interface ReplayCache {
  has(key: string): boolean;
  add(key: string): unknown;
}

export interface VerifyContext {
  self: string; // 'cloud', or this device's id
  now: number;
  keys: ReadonlyMap<string, TrustedKey>; // by kid
  seen: ReplayCache;
}

export type Verdict = { ok: true; env: Envelope } | { ok: false; code: RejectCode; why: string };

const reject = (code: RejectCode, why: string): Verdict => ({ ok: false, code, why });

export async function verifyFrame(raw: string, ctx: VerifyContext): Promise<Verdict> {
  // 1. A text frame within the size limit that parses as a JSON object whose `v` is an integer.
  if (new TextEncoder().encode(raw).length > MAX_FRAME_BYTES) return reject('malformed', 'frame larger than MAX_FRAME_BYTES');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject('malformed', 'not JSON');
  }
  if (!isObject(parsed)) return reject('malformed', 'not an object');
  const e = parsed;
  if (typeof e.v !== 'number' || !Number.isSafeInteger(e.v)) return reject('malformed', 'v is not an integer');
  // 2. The version, before anything else is interpreted: a v2 frame may have a shape v1 does not understand,
  //    and the honest answer to it is "unsupported", not "malformed".
  if (e.v !== VERSION) return reject('unsupported_version', `v=${e.v}`);
  // 3. Field set and formats.
  const shape = shapeError(e);
  if (shape) return reject('malformed', shape);
  // 4. Canonicalisable.
  let canon: string;
  try {
    canon = canonicalize(e);
  } catch (err) {
    if (err instanceof CanonicalError) return reject('malformed', err.message);
    throw err;
  }
  // 5. The text *is* its canonical form. This is what makes parser differences irrelevant: duplicate keys,
  //    whitespace, alternative escapes, 1e3 for 1000 -- no honest sender produces a frame two parsers could
  //    read differently, so such a frame is refused before anyone has to decide which reading is right.
  if (canon !== raw) return reject('non_canonical', 'frame text is not its own canonical form');
  const env = e as unknown as Envelope;
  // 6. A trusted key, and one that signs for the claimed sender. A key only ever speaks for its own owner.
  const trusted = ctx.keys.get(env.kid);
  if (!trusted || trusted.owner !== env.from) return reject('unknown_key', `kid ${env.kid} does not sign for ${env.from}`);
  // 7. The signature.
  const { sig, ...unsigned } = env;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify('Ed25519', trusted.key, b64.decode(sig), signingInput(unsigned));
  } catch {
    // A runtime that throws instead of returning false (an encoding it rejects outright) gets the same answer.
    valid = false;
  }
  if (!valid) return reject('bad_signature', 'signature does not verify');
  // Only authenticated frames get this far, so the codes below are facts about the sender, not guesses.
  // 8. Addressed to us.
  if (env.to !== ctx.self) return reject('wrong_recipient', `addressed to ${env.to}`);
  // 9. Inside the window, inclusive at both edges.
  if (Math.abs(ctx.now - env.ts) > WINDOW_MS) return reject('stale', `ts is ${ctx.now - env.ts} ms from now`);
  // 10. Not seen before. Checked and recorded with no await in between (see ReplayCache).
  const seenKey = `${env.from}/${env.id}`;
  if (ctx.seen.has(seenKey)) return reject('replay', `id ${env.id} already seen`);
  ctx.seen.add(seenKey);
  return { ok: true, env };
}

// -- Signing --------------------------------------------------------------------------------------

export interface Signer {
  kid: string;
  owner: string; // the `from` this key signs for
  key: CryptoKey; // private, usage 'sign'
}

// PKCS#8 wrapping of a raw 32-byte Ed25519 seed (RFC 8410): the fixed DER header, then the seed. WebCrypto
// imports private keys only as PKCS#8 or JWK, and JWK would need the public half up front.
const PKCS8_ED25519_PREFIX = b64.fromHex('302e020100300506032b657004220420');

// A signer from a 32-byte seed. The private key is imported non-extractable; the public half is derived once,
// through a short-lived extractable copy, only to compute the kid.
export async function signerFromSeed(seed: Uint8Array, owner: string): Promise<Signer> {
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  der.set(PKCS8_ED25519_PREFIX);
  der.set(seed, PKCS8_ED25519_PREFIX.length);
  const extractable = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
  const jwk = (await crypto.subtle.exportKey('jwk', extractable)) as JsonWebKey;
  if (typeof jwk.x !== 'string') throw new Error('Ed25519 key export carried no public half');
  const kid = await kidOf(b64.decode(jwk.x));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  return { kid, owner, key };
}

// Sign an envelope and return the frame text: its canonical form, which is the only form a receiver accepts.
// Refuses to sign anything the verifier would refuse as malformed, and a kid or sender that is not the
// signer's -- a frame like that could only ever be rejected, so producing one is a bug worth failing on.
export async function seal(unsigned: Unsigned, signer: Signer): Promise<string> {
  if (unsigned.kid !== signer.kid) throw new Error(`kid ${unsigned.kid} is not the signer's (${signer.kid})`);
  if (unsigned.from !== signer.owner) throw new Error(`the signer signs for ${signer.owner}, not ${unsigned.from}`);
  if (unsigned.v !== VERSION) throw new Error(`v must be ${VERSION}`);
  const sig = b64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', signer.key, signingInput(unsigned))));
  const env: Envelope = { ...unsigned, sig };
  const shape = shapeError(env as unknown as Record<string, unknown>);
  if (shape) throw new Error(`refusing to seal a malformed envelope: ${shape}`);
  return canonicalize(env);
}
