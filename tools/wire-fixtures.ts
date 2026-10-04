// The reference implementation of wire protocol v1 framing (docs/cloud-agent.md, "Wire protocol v1"), and the
// generator of the golden fixtures under fixtures/wire/v1/ that every other implementation is tested against.
//
// Why a reference lives here, outside cloud/ and agent/: the protocol has two implementations in two
// languages -- the Worker (TypeScript on workerd, WebCrypto) and forgeline-agent (Rust). Each tested only
// against itself would happily agree with its own bugs. Both instead must reproduce these files exactly: the
// same canonical bytes, the same Ed25519 signatures (Ed25519 is deterministic, so a fixed key gives a fixed
// signature), and the same rejection code for every bad frame. Three implementations agreeing on one set of
// files is the whole point; two that each only agree with themselves prove nothing.
//
//   node tools/wire-fixtures.ts --write   regenerate fixtures/wire/v1/ after a deliberate protocol change
//   node tools/wire-fixtures.ts --check   exit 1 if the files on disk differ from what this file generates
//
// test/wire-fixtures.test.ts runs the check on every `npm run ci` and re-verifies every frame with the verifier
// below, so a hand-edited fixture and a changed generator both turn CI red.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = join(ROOT, 'fixtures/wire/v1');

// Prepended to the canonical bytes before signing. A signature made for this protocol can then never be
// replayed as a valid signature in any other context that happens to sign JSON with the same key, and v2 can
// change the prefix so a v1 signature never verifies as v2.
export const DOMAIN = 'forgeline-wire/1\n';
// A frame whose `ts` is further than this from the receiver's clock is refused (inclusive bound: exactly
// WINDOW_MS away is still accepted -- fixtures pin both sides of the edge). Ids are remembered for at least
// this long on each side of now, so the window is also what bounds the replay cache.
export const WINDOW_MS = 300_000;
// Measured in UTF-8 bytes of the raw text frame, before parsing: nothing larger is even looked at.
export const MAX_FRAME_BYTES = 65_536;
export const VERSION = 1;

// Rejection codes, in the order the checks run. The order is part of the protocol: a frame that is wrong in two
// ways must be rejected with the same code by every implementation, or the audit trails disagree.
export const REJECT_CODES = [
  'malformed',
  'unsupported_version',
  'non_canonical',
  'unknown_key',
  'bad_signature',
  'wrong_recipient',
  'stale',
  'replay',
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export class WireError extends Error {
  readonly code: RejectCode;
  constructor(code: RejectCode, message: string) {
    super(message);
    this.code = code;
  }
}

// -- Canonical JSON ------------------------------------------------------------------------------
// RFC 8785 (JCS), restricted so the two hard parts of JCS never come up:
//  * numbers must be safe integers. JCS's number serialisation is ECMAScript's shortest round-trip double
//    formatting, which is notoriously hard to reproduce outside JavaScript; the protocol has no use for
//    fractions (times are integer milliseconds), so it forbids them instead of reimplementing that.
//  * object keys must be printable ASCII. JCS sorts keys by UTF-16 code units, Rust's BTreeMap by UTF-8 bytes;
//    the two orders differ only above U+FFFF, so restricting keys makes "sort the keys" mean one thing everywhere.
// Strings are escaped exactly as JSON.stringify does (that is what JCS specifies), and lone surrogates are
// refused because JCS refuses them and Rust strings cannot hold them.
const KEY_RE = /^[\x20-\x7e]+$/;

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new WireError('malformed', `not a safe integer: ${value}`);
      return String(value); // String(-0) is "0"
    case 'string':
      if (!value.isWellFormed()) throw new WireError('malformed', 'string holds a lone surrogate');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      for (const k of keys) if (!KEY_RE.test(k)) throw new WireError('malformed', `key is not printable ASCII: ${JSON.stringify(k)}`);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
    }
    default:
      throw new WireError('malformed', `not a JSON value: ${typeof value}`);
  }
}

// -- Envelope ------------------------------------------------------------------------------------
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
// 64 bytes, base64url without padding. 86 characters carry 516 bits for 512, so the last character's four low bits
// are unused and must be zero: only A, Q, g or w can end a signature. Lenient decoders (Node, atob) ignore those bits
// while strict ones (Rust's base64) refuse them, so without this rule one frame could verify on one side and be
// malformed on the other.
const SIG_RE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const TYPE_RE = /^[a-z][a-z_.]{0,63}$/;
const FIELDS = new Set(['v', 'type', 'id', 'ts', 'from', 'to', 'kid', 're', 'body', 'sig']);

export function signingInput(env: Unsigned): Buffer {
  return Buffer.from(DOMAIN + canonicalize(env), 'utf8');
}

export function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

// A key id is derived from the key, never assigned: nobody has to keep a registry in sync, and the same short
// string doubles as the fingerprint a human compares during enrolment.
export function kidOf(rawPublicKey: Buffer): string {
  return b64url(createHash('sha256').update(rawPublicKey).digest()).slice(0, 16);
}

export interface TrustedKey {
  owner: string; // 'cloud' or a device id: the only `from` this key may sign for
  publicKey: KeyObject;
}

export interface VerifyContext {
  self: string; // 'cloud' or this device's id
  now: number;
  keys: Map<string, TrustedKey>; // by kid
  seen: Set<string>; // `${from}/${id}` of every frame accepted inside the window
}

export type Verdict = { ok: true; env: Envelope } | { ok: false; code: RejectCode; why: string };

function reject(code: RejectCode, why: string): Verdict {
  return { ok: false, code, why };
}

// Verify one raw text frame. The checks run in REJECT_CODES order; see that list for why the order matters.
export function verifyFrame(raw: string, ctx: VerifyContext): Verdict {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return reject('malformed', 'frame larger than MAX_FRAME_BYTES');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject('malformed', 'not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return reject('malformed', 'not an object');
  const e = parsed as Record<string, unknown>;
  // The version is read before anything else is interpreted: a v2 frame may legitimately have a shape this
  // code does not understand, and the honest answer to it is "unsupported", not "malformed".
  if (typeof e.v !== 'number' || !Number.isSafeInteger(e.v)) return reject('malformed', 'v is not an integer');
  if (e.v !== VERSION) return reject('unsupported_version', `v=${e.v}`);
  for (const k of Object.keys(e)) if (!FIELDS.has(k)) return reject('malformed', `unknown field ${k}`);
  if (typeof e.type !== 'string' || !TYPE_RE.test(e.type)) return reject('malformed', 'type');
  if (typeof e.id !== 'string' || !ULID_RE.test(e.id)) return reject('malformed', 'id');
  if (typeof e.ts !== 'number' || !Number.isSafeInteger(e.ts) || e.ts < 0) return reject('malformed', 'ts');
  if (typeof e.from !== 'string' || !PARTY_RE.test(e.from)) return reject('malformed', 'from');
  if (typeof e.to !== 'string' || !PARTY_RE.test(e.to)) return reject('malformed', 'to');
  if (typeof e.kid !== 'string' || !KID_RE.test(e.kid)) return reject('malformed', 'kid');
  if (e.re !== undefined && (typeof e.re !== 'string' || !ULID_RE.test(e.re))) return reject('malformed', 're');
  if (e.body === null || typeof e.body !== 'object' || Array.isArray(e.body)) return reject('malformed', 'body');
  if (typeof e.sig !== 'string' || !SIG_RE.test(e.sig)) return reject('malformed', 'sig');
  // The raw text must *be* the canonical form, not merely parse to something with a canonical form. This is
  // what makes parser differences irrelevant: duplicate keys, whitespace, escapes written differently, "1e3"
  // for 1000 -- any frame where two parsers could disagree is one that no honest sender produces.
  let canon: string;
  try {
    canon = canonicalize(e);
  } catch (err) {
    return reject('malformed', (err as Error).message);
  }
  if (canon !== raw) return reject('non_canonical', 'frame text is not its own canonical form');
  const env = e as unknown as Envelope;
  const key = ctx.keys.get(env.kid);
  if (!key || key.owner !== env.from) return reject('unknown_key', `kid ${env.kid} does not sign for ${env.from}`);
  const { sig, ...unsigned } = env;
  if (!verify(null, signingInput(unsigned), key.publicKey, Buffer.from(sig, 'base64url'))) return reject('bad_signature', 'signature does not verify');
  // Only authenticated frames get past this point, so the codes below are facts about the sender, not guesses.
  if (env.to !== ctx.self) return reject('wrong_recipient', `addressed to ${env.to}`);
  if (Math.abs(ctx.now - env.ts) > WINDOW_MS) return reject('stale', `ts is ${ctx.now - env.ts} ms from now`);
  const seenKey = `${env.from}/${env.id}`;
  if (ctx.seen.has(seenKey)) return reject('replay', `id ${env.id} already seen`);
  ctx.seen.add(seenKey);
  return { ok: true, env };
}

// -- Test keys -----------------------------------------------------------------------------------
// The secret keys of RFC 8032 section 7.1, TEST 1-3: published, so they are obviously and permanently unfit for
// anything but tests. test/wire-fixtures.test.ts pins their public halves to the RFC's values, so nobody can
// quietly swap a real key in here.
const TEST_SEEDS = {
  cloud: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  device: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
  attacker: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
} as const;
type KeyName = keyof typeof TEST_SEEDS;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface TestKey {
  name: KeyName;
  seed: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  raw: Buffer;
  kid: string;
}

function testKey(name: KeyName): TestKey {
  const seed = TEST_SEEDS[name];
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { name, seed, privateKey, publicKey, raw, kid: kidOf(raw) };
}

// -- Deterministic ids ---------------------------------------------------------------------------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// A ULID whose 80 "random" bits are a hash of a label, so regenerating the fixtures is byte-stable.
function ulid(ms: number, label: string): string {
  const rnd = createHash('sha256').update(label).digest().subarray(0, 10);
  let n = (BigInt(ms) << 80n) | BigInt(`0x${rnd.toString('hex')}`);
  let s = '';
  for (let i = 0; i < 26; i++) {
    s = CROCKFORD[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

function nonce(label: string): string {
  return b64url(createHash('sha256').update(`nonce:${label}`).digest());
}

// -- The fixtures --------------------------------------------------------------------------------
export interface Fixture {
  about: string;
  receiver: string; // the `self` of the verifying side
  now: number;
  trust: string[]; // kids (from keys.json) the receiver trusts for this case
  frames: string[]; // raw text frames, fed in order to one verifier with one replay cache
  expect: string[]; // 'ok' or a RejectCode, one per frame
}

// 2026-10-04T00:00:00Z. Every frame is dated relative to it.
export const NOW = Date.UTC(2026, 9, 4);
export const DEVICE = `dev_${ulid(NOW - 86_400_000, 'device:test')}`;
export const OTHER_DEVICE = `dev_${ulid(NOW - 86_400_000, 'device:other')}`;
const SESSION = '6f1c2a9e-4b7d-4e2a-9c31-0d5e8f7a1b24';

function seal(env: Unsigned, key: TestKey): Envelope {
  return { ...env, sig: b64url(sign(null, signingInput(env), key.privateKey)) };
}

function frame(env: Envelope): string {
  return canonicalize(env);
}

// Build an unsigned envelope. `tsOffset` is relative to NOW; the id is derived from the label.
function env(label: string, tsOffset: number, fields: Omit<Unsigned, 'v' | 'id' | 'ts'> & { id?: string }): Unsigned {
  const ts = NOW + tsOffset;
  const out: Unsigned = { v: VERSION, type: fields.type, id: fields.id ?? ulid(ts, label), ts, from: fields.from, to: fields.to, kid: fields.kid, body: fields.body };
  if (fields.re !== undefined) out.re = fields.re;
  return out;
}

// One string that exercises every escaping rule the canonical form has: quote, backslash, the short escapes,
// a control character that has no short escape, U+2028 (which JSON.stringify leaves alone), a non-ASCII Latin
// letter, CJK, and an emoji outside the BMP (a surrogate pair in UTF-16, four bytes in UTF-8). The CJK is
// written as escapes because this repository's English-only guard scans tracked source.
const TRICKY_TEXT = 'Done \u2705 "quoted" back\\slash\ttab\nline\u0001ctl\u2028sep caf\u00e9 \u4fee\u590d \u{1F680}';

export function buildFixtures(): { keys: string; canonical: string; frames: Map<string, string> } {
  const k = { cloud: testKey('cloud'), device: testKey('device'), attacker: testKey('attacker') };
  const fixtures = new Map<string, Fixture>();
  const add = (name: string, f: Fixture) => fixtures.set(name, f);
  const toDevice = (f: Omit<Fixture, 'receiver' | 'now' | 'trust'>): Fixture => ({ receiver: DEVICE, now: NOW, trust: [k.cloud.kid], ...f });
  const toCloud = (f: Omit<Fixture, 'receiver' | 'now' | 'trust'>): Fixture => ({ receiver: 'cloud', now: NOW, trust: [k.device.kid], ...f });

  // ---- The handshake ----
  const nC = nonce('challenge');
  const nD = nonce('device');
  const challenge = seal(env('challenge', -3_000, { type: 'challenge', from: 'cloud', to: DEVICE, kid: k.cloud.kid, body: { nonce: nC, versions: [1] } }), k.cloud);
  add('handshake-1-challenge', toDevice({ about: 'The cloud speaks first: a fresh nonce, signed with its pinned key, listing the versions it accepts.', frames: [frame(challenge)], expect: ['ok'] }));
  const auth = seal(
    env('auth', -2_900, {
      type: 'auth',
      from: DEVICE,
      to: 'cloud',
      kid: k.device.kid,
      re: challenge.id,
      body: {
        challenge: nC,
        nonce: nD,
        version: 1,
        agent: { version: '0.1.0', os: 'macos', arch: 'aarch64' },
        capabilities: ['session.reply', 'device.pause'],
        policy: { actions: ['session.reply'], repos: ['forgeline'], agents: ['claude', 'codex'] },
      },
    }),
    k.device,
  );
  add('handshake-2-auth', toCloud({ about: "The device answers: it signs the cloud's nonce (proof of its key, bound to this connection), adds its own, and reports what its local policy allows.", frames: [frame(auth)], expect: ['ok'] }));
  const welcome = seal(env('welcome', -2_800, { type: 'welcome', from: 'cloud', to: DEVICE, kid: k.cloud.kid, re: auth.id, body: { nonce: nD, conn: ulid(NOW - 2_800, 'conn'), heartbeat_s: 30, jobs_enabled: true } }), k.cloud);
  add('handshake-3-welcome', toDevice({ about: "The cloud signs the device's nonce back: now both sides have proven their keys on this connection.", frames: [frame(welcome)], expect: ['ok'] }));

  // ---- An event and its ack ----
  const eventId = ulid(NOW - 60_000, 'event:turn');
  const event = seal(
    env('event', -60_000, {
      type: 'event',
      from: DEVICE,
      to: 'cloud',
      kid: k.device.kid,
      body: {
        event_id: eventId,
        kind: 'session.turn_completed',
        at: NOW - 60_500,
        data: { agent: 'claude', session: SESSION, project: 'forgeline', title: 'fix the flaky lease test', summary: TRICKY_TEXT, turn: 3, duration_s: 412 },
      },
    }),
    k.device,
  );
  add('event-turn-completed', toCloud({ about: 'A session finished a turn. The summary exercises every string-escaping rule of the canonical form.', frames: [frame(event)], expect: ['ok'] }));
  const eventAck = seal(env('ack:event', -59_900, { type: 'ack', from: 'cloud', to: DEVICE, kid: k.cloud.kid, re: event.id, body: { key: eventId } }), k.cloud);
  add('ack-event', toDevice({ about: 'The cloud has stored the event; the device may drop it from its spool.', frames: [frame(eventAck)], expect: ['ok'] }));

  // ---- A job, its ack and its results ----
  const jobId = ulid(NOW - 20_000, 'job:reply');
  const jobBody = {
    job_id: jobId,
    kind: 'session.reply',
    attempt: 1,
    issued_at: NOW - 20_000,
    expires_at: NOW - 20_000 + 900_000,
    origin: { provider: 'slack', ref: 'slack:T00000000:D00000000:1791071980.000100' },
    params: { agent: 'claude', session: SESSION, text: 'Looks good \u2014 now run the full suite and open the PR.' },
  };
  const job = seal(env('job', -1_000, { type: 'job', from: 'cloud', to: DEVICE, kid: k.cloud.kid, body: jobBody }), k.cloud);
  add('job-session-reply', toDevice({ about: "The owner replied under a card; the cloud asks the device to deliver the text into that session. Each delivery attempt is a new envelope; job_id is the idempotency key.", frames: [frame(job)], expect: ['ok'] }));
  const jobAck = seal(env('ack:job', -900, { type: 'ack', from: DEVICE, to: 'cloud', kid: k.device.kid, re: job.id, body: { key: jobId } }), k.device);
  add('ack-job', toCloud({ about: 'The device has persisted the job; the cloud stops redelivering it.', frames: [frame(jobAck)], expect: ['ok'] }));
  const done = seal(
    env('result:done', -500, { type: 'result', from: DEVICE, to: 'cloud', kid: k.device.kid, re: job.id, body: { job_id: jobId, status: 'done', code: 'ok', message: 'Woke the open session; it is running the reply now.', data: { route: 'wake' } } }),
    k.device,
  );
  add('result-done', toCloud({ about: 'The job ran.', frames: [frame(done)], expect: ['ok'] }));
  const rejected = seal(
    env('result:rejected', -400, {
      type: 'result',
      from: DEVICE,
      to: 'cloud',
      kid: k.device.kid,
      re: job.id,
      body: { job_id: jobId, status: 'rejected', code: 'unknown_session', message: 'This device has not reported that session in the last 12 hours, so it will not write into it.' },
    }),
    k.device,
  );
  add('result-rejected', toCloud({ about: 'The device refused the job by its own local policy, and says why in words the owner will read.', frames: [frame(rejected)], expect: ['ok'] }));
  const pause = seal(
    env('job:pause', -300, {
      type: 'job',
      from: 'cloud',
      to: DEVICE,
      kid: k.cloud.kid,
      body: { job_id: ulid(NOW - 300, 'job:pause'), kind: 'device.pause', attempt: 1, issued_at: NOW - 300, expires_at: NOW - 300 + 900_000, origin: { provider: 'slack', ref: 'slack:T00000000:D00000000:1791071999.000200' }, params: {} },
    }),
    k.cloud,
  );
  add('job-device-pause', toDevice({ about: 'The cloud may pause a device. There is deliberately no matching resume job: only the device itself can lift a pause.', frames: [frame(pause)], expect: ['ok'] }));
  const error = seal(env('error', -200, { type: 'error', from: 'cloud', to: DEVICE, kid: k.cloud.kid, re: auth.id, body: { code: 'revoked', message: 'This device was revoked; enrol it again to reconnect.' } }), k.cloud);
  add('error-revoked', toDevice({ about: 'A protocol-level error, signed like everything else, sent just before the cloud closes the socket.', frames: [frame(error)], expect: ['ok'] }));

  // ---- Rejections ----
  const tampered = { ...job, body: { ...jobBody, params: { ...jobBody.params, text: 'rm -rf ~ and push --force' } } };
  add('reject-tampered-body', toDevice({ about: 'A valid job whose text was changed in transit.', frames: [frame(tampered)], expect: ['bad_signature'] }));
  const { sig: _sig, ...jobUnsigned } = job;
  const forged = seal(jobUnsigned, k.attacker); // kid still names the cloud's key
  add('reject-forged-signature', toDevice({ about: "Signed with someone else's key while claiming the cloud's kid.", frames: [frame(forged)], expect: ['bad_signature'] }));
  const strangerJob = seal(env('job:stranger', -1_000, { type: 'job', from: 'cloud', to: DEVICE, kid: k.attacker.kid, body: jobBody }), k.attacker);
  add('reject-unknown-key', toDevice({ about: 'A correctly signed frame from a key the device never pinned.', frames: [frame(strangerJob)], expect: ['unknown_key'] }));
  const impersonation = seal(env('event:impersonate', -1_000, { type: 'event', from: OTHER_DEVICE, to: 'cloud', kid: k.device.kid, body: event.body }), k.device);
  add('reject-key-owner-mismatch', toCloud({ about: "A trusted device key signing a frame that claims to come from another device. A key only ever signs for its own owner.", frames: [frame(impersonation)], expect: ['unknown_key'] }));
  const misrouted = seal(env('job:other-device', -1_000, { type: 'job', from: 'cloud', to: OTHER_DEVICE, kid: k.cloud.kid, body: jobBody }), k.cloud);
  add('reject-wrong-recipient', toDevice({ about: 'A genuine job, addressed to a different device, replayed to this one.', frames: [frame(misrouted)], expect: ['wrong_recipient'] }));
  const old = seal(env('job:old', -(WINDOW_MS + 1), { type: 'job', from: 'cloud', to: DEVICE, kid: k.cloud.kid, body: jobBody }), k.cloud);
  add('reject-stale-past', toDevice({ about: 'One millisecond older than the window.', frames: [frame(old)], expect: ['stale'] }));
  const future = seal(env('job:future', WINDOW_MS + 1, { type: 'job', from: 'cloud', to: DEVICE, kid: k.cloud.kid, body: jobBody }), k.cloud);
  add('reject-stale-future', toDevice({ about: 'One millisecond further in the future than the window allows.', frames: [frame(future)], expect: ['stale'] }));
  const edge = seal(env('job:edge', -WINDOW_MS, { type: 'job', from: 'cloud', to: DEVICE, kid: k.cloud.kid, body: jobBody }), k.cloud);
  add('accept-window-edge', toDevice({ about: 'Exactly at the edge of the window: the bound is inclusive.', frames: [frame(edge)], expect: ['ok'] }));
  add('reject-replay', toDevice({ about: 'The same frame twice: the first is accepted, the second is a replay.', frames: [frame(job), frame(job)], expect: ['ok', 'replay'] }));
  const v2 = seal({ ...env('job:v2', -1_000, { type: 'job', from: 'cloud', to: DEVICE, kid: k.cloud.kid, body: jobBody }), v: 2 }, k.cloud);
  add('reject-version-future', toDevice({ about: 'A version this implementation does not speak.', frames: [frame(v2)], expect: ['unsupported_version'] }));
  const v0 = seal({ ...env('job:v0', -1_000, { type: 'job', from: 'cloud', to: DEVICE, kid: k.cloud.kid, body: jobBody }), v: 0 }, k.cloud);
  add('reject-version-downgrade', toDevice({ about: 'A downgrade to a version that never existed. There is no fallback: anything but 1 is refused.', frames: [frame(v0)], expect: ['unsupported_version'] }));
  add('reject-whitespace', toDevice({ about: 'A genuine frame, pretty-printed. Valid JSON, valid signature over its parse, refused anyway: the text must be canonical.', frames: [JSON.stringify(job, null, 1)], expect: ['non_canonical'] }));
  // JSON.stringify keeps insertion order and adds no whitespace, so key order is the only thing wrong here.
  const reordered = JSON.stringify({ v: job.v, type: job.type, id: job.id, ts: job.ts, from: job.from, to: job.to, kid: job.kid, body: job.body, sig: job.sig });
  add('reject-key-order', toDevice({ about: 'A genuine frame with its top-level keys out of order.', frames: [reordered], expect: ['non_canonical'] }));
  const duplicated = frame(job).replace(`"to":"${DEVICE}"`, `"to":"${OTHER_DEVICE}","to":"${DEVICE}"`);
  add('reject-duplicate-key', toDevice({ about: 'A duplicated key. Parsers disagree on which copy wins; requiring canonical text makes the question moot.', frames: [duplicated], expect: ['non_canonical'] }));
  add('reject-fraction', toDevice({ about: 'A number with a fraction. The protocol has integers only.', frames: [frame(job).replace('"attempt":1', '"attempt":1.5')], expect: ['malformed'] }));
  const { kid: _kid, ...noKid } = job;
  add('reject-missing-field', toDevice({ about: 'No kid.', frames: [canonicalize(noKid)], expect: ['malformed'] }));
  add('reject-extra-field', toDevice({ about: 'An unknown top-level field. The envelope is closed; extensions go in the body.', frames: [canonicalize({ ...job, x: 1 })], expect: ['malformed'] }));
  add('reject-not-json', toDevice({ about: 'Not JSON at all.', frames: ['ping?'], expect: ['malformed'] }));
  const lastSig = job.sig.at(-1)!;
  const sloppySig = job.sig.slice(0, -1) + B64URL[B64URL.indexOf(lastSig) | 1];
  add('reject-sig-padding-bits', toDevice({ about: "A genuine signature whose last character sets an unused bit. Lenient base64 decoders read the same 64 bytes and the signature would verify; the rule makes every implementation refuse it.", frames: [frame({ ...job, sig: sloppySig })], expect: ['malformed'] }));
  const oversized = seal(env('job:oversized', -1_000, { type: 'job', from: 'cloud', to: DEVICE, kid: k.cloud.kid, body: { ...jobBody, params: { ...jobBody.params, text: 'x'.repeat(MAX_FRAME_BYTES) } } }), k.cloud);
  add('reject-oversized', toDevice({ about: 'A correctly signed frame over the size limit. Size is checked before parsing.', frames: [frame(oversized)], expect: ['malformed'] }));

  // ---- Two faults at once: these pin the *order* of the checks (section 5.4), which single-fault frames cannot ----
  add('order-version-before-fields', toDevice({ about: 'Unsupported version and an unknown field: the version is checked first.', frames: [canonicalize({ ...v2, x: 1 })], expect: ['unsupported_version'] }));
  add('order-fields-before-canonical', toDevice({ about: 'Missing kid and not canonical: fields are checked first.', frames: [JSON.stringify(noKid, null, 1)], expect: ['malformed'] }));
  add('order-canonical-before-key', toDevice({ about: 'Not canonical and an unknown key: canonical text is checked first.', frames: [JSON.stringify(strangerJob, null, 1)], expect: ['non_canonical'] }));
  add('order-key-before-signature', toDevice({ about: 'An unknown key and a signature that does not verify: the key is checked first.', frames: [frame({ ...strangerJob, body: tampered.body })], expect: ['unknown_key'] }));
  add('order-signature-before-recipient', toDevice({ about: 'A bad signature on a frame addressed to another device: the signature is checked first.', frames: [frame({ ...misrouted, body: tampered.body })], expect: ['bad_signature'] }));
  const oldMisrouted = seal(env('job:old-other-device', -(WINDOW_MS + 1), { type: 'job', from: 'cloud', to: OTHER_DEVICE, kid: k.cloud.kid, body: jobBody }), k.cloud);
  add('order-recipient-before-stale', toDevice({ about: 'Addressed to another device and stale: the recipient is checked first.', frames: [frame(oldMisrouted)], expect: ['wrong_recipient'] }));
  const staleRepeat = seal({ ...jobUnsigned, ts: NOW - WINDOW_MS - 1 }, k.cloud);
  add('order-stale-before-replay', toDevice({ about: 'An id seen before, now arriving outside the window: stale is checked before replay.', frames: [frame(job), frame(staleRepeat)], expect: ['ok', 'stale'] }));

  // ---- keys.json ----
  const keys = {
    about: 'TEST KEYS ONLY. The secret keys of RFC 8032 section 7.1 (TEST 1-3), which are public. Never use them outside tests.',
    keys: (['cloud', 'device', 'attacker'] as const).map((n) => ({
      name: n,
      owner: n === 'cloud' ? 'cloud' : n === 'device' ? DEVICE : null,
      seed_hex: k[n].seed,
      public: b64url(k[n].raw),
      kid: k[n].kid,
    })),
  };

  // ---- canonical.json ----
  const canonicalCases: { about: string; input: string; canonical?: string; error?: true }[] = [
    { about: 'keys sorted, whitespace removed, nesting', input: '{ "b": [3, {"z": null, "a": true}], "a": "x" }' },
    { about: 'keys are compared as strings, not numbers: "10" sorts before "9"', input: '{"9":0,"10":1,"a_b":2,"aB":3,"A":4}' },
    { about: 'every escaping rule at once', input: JSON.stringify({ s: TRICKY_TEXT }) },
    { about: 'escapes in the input are normalised: \\u0041 becomes A, \\/ becomes /', input: '{"s":"\\u0041\\/\\u00e9"}' },
    { about: 'all 32 control characters', input: JSON.stringify({ s: Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') }) },
    { about: 'negative and large safe integers', input: '{"a":-9007199254740991,"b":9007199254740991,"c":0}' },
    { about: 'empty containers', input: '{"a":{},"b":[],"c":""}' },
    { about: 'a fraction is refused', input: '{"a":1.5}', error: true },
    { about: 'an integer beyond 2^53 - 1 is refused', input: '{"a":9007199254740992}', error: true },
    { about: 'a non-ASCII key is refused', input: '{"caf\\u00e9":1}', error: true },
    { about: 'a lone surrogate is refused', input: '{"a":"\\ud800"}', error: true },
  ];
  const canonical = {
    about: 'Canonicalisation cases. Parse `input` with your JSON parser, canonicalise the result, and compare with `canonical`; where `error` is true, canonicalisation (or parsing) must fail.',
    cases: canonicalCases.map((c) => {
      if (c.error) return c;
      return { ...c, canonical: canonicalize(JSON.parse(c.input)) };
    }),
  };

  const frames = new Map<string, string>();
  for (const [name, f] of fixtures) frames.set(`frames/${name}.json`, serialize(f));
  return { keys: serialize(keys), canonical: serialize(canonical), frames };
}

// Fixture files are written ASCII-only: everything above U+007E is a \u escape. The parsed values are
// unchanged (that is what the escapes mean), the files stay readable in any editor, and the English-only guard,
// which scans tracked files for CJK, has nothing to object to.
export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

export function expectedFiles(): Map<string, string> {
  const { keys, canonical, frames } = buildFixtures();
  return new Map([['keys.json', keys], ['canonical.json', canonical], ...frames]);
}

function listFiles(dir: string, rel = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(join(dir, e.name), r));
    else out.push(r);
  }
  return out.sort();
}

// The differences between the generator and the files on disk, as human-readable lines. Empty = in sync.
export function drift(dir = FIXTURE_DIR): string[] {
  const want = expectedFiles();
  const have = listFiles(dir);
  const out: string[] = [];
  for (const f of have) if (!want.has(f)) out.push(`extra file: ${f}`);
  for (const [f, content] of want) {
    if (!have.includes(f)) out.push(`missing file: ${f}`);
    else if (readFileSync(join(dir, f), 'utf8') !== content) out.push(`differs: ${f}`);
  }
  return out;
}

function main(argv: string[]): number {
  if (argv.includes('--write')) {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    for (const [f, content] of expectedFiles()) {
      mkdirSync(dirname(join(FIXTURE_DIR, f)), { recursive: true });
      writeFileSync(join(FIXTURE_DIR, f), content);
    }
    process.stdout.write(`wrote ${expectedFiles().size} files to ${FIXTURE_DIR}\n`);
    return 0;
  }
  if (argv.includes('--check')) {
    const d = drift();
    for (const line of d) process.stderr.write(`${line}\n`);
    return d.length ? 1 : 0;
  }
  process.stderr.write('usage: node tools/wire-fixtures.ts --write | --check\n');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
