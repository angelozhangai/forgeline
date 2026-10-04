// The golden fixtures of wire protocol v1 (fixtures/wire/v1/) are the contract between forgeline Cloud and
// forgeline-agent: both implementations are tested against these files, not against themselves. This test keeps
// the files honest from the reference side (tools/wire-fixtures.ts):
//  * the files on disk are exactly what the generator produces -- a hand-edited fixture, or a generator change
//    nobody regenerated for, turns CI red instead of silently moving the contract;
//  * every frame verifies (or is rejected with exactly the stated code) under the reference verifier;
//  * the test keys are the published RFC 8032 vectors, so a real key can never be slipped in as a "test" key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DIR, REJECT_CODES, canonicalize, drift, verifyFrame, type Fixture, type TrustedKey } from '../tools/wire-fixtures.ts';

interface KeyFile {
  keys: { name: string; owner: string | null; seed_hex: string; public: string; kid: string }[];
}
const keyFile = JSON.parse(readFileSync(join(FIXTURE_DIR, 'keys.json'), 'utf8')) as KeyFile;

function publicKey(b64: string) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64 }, format: 'jwk' });
}

test('the fixture files are exactly what tools/wire-fixtures.ts generates', () => {
  assert.deepEqual(drift(), [], 'run `node tools/wire-fixtures.ts --write` after a deliberate protocol change, and say so in the PR');
});

test('the test keys are the published RFC 8032 section 7.1 vectors, and nothing else', () => {
  const rfc: Record<string, string> = {
    cloud: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    device: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    attacker: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
  };
  assert.deepEqual(keyFile.keys.map((k) => k.name).sort(), Object.keys(rfc).sort());
  for (const k of keyFile.keys) assert.equal(Buffer.from(k.public, 'base64url').toString('hex'), rfc[k.name], k.name);
});

const frameFiles = readdirSync(join(FIXTURE_DIR, 'frames')).filter((f) => f.endsWith('.json'));

test('there are frames for every message type and every rejection code', () => {
  const fixtures = frameFiles.map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, 'frames', f), 'utf8')) as Fixture);
  const expected = new Set(fixtures.flatMap((f) => f.expect));
  for (const code of REJECT_CODES) assert.ok(expected.has(code), `no fixture is rejected with ${code}`);
  const types = new Set<string>();
  for (const f of fixtures) {
    f.frames.forEach((raw, i) => {
      if (f.expect[i] === 'ok') types.add((JSON.parse(raw) as { type: string }).type);
    });
  }
  assert.deepEqual([...types].sort(), ['ack', 'auth', 'challenge', 'error', 'event', 'job', 'result', 'welcome']);
});

test('the order of the checks is pinned: a two-fault frame exists for every adjacent pair of checks', () => {
  // Single-fault frames pin each code but not the order: swapping two adjacent checks passes all of them. Each
  // order-* frame is wrong in exactly the two ways named by its file, and expects the earlier check's code.
  const order = ['version', 'fields', 'canonical', 'key', 'signature', 'recipient', 'stale', 'replay'];
  const have = new Set(frameFiles.filter((f) => f.startsWith('order-')).map((f) => f.replace(/^order-|\.json$/g, '')));
  for (let i = 0; i + 1 < order.length - 1; i++) assert.ok(have.has(`${order[i]}-before-${order[i + 1]}`), `missing order-${order[i]}-before-${order[i + 1]}`);
  assert.ok(have.has('stale-before-replay'));
  // Step 1's own pre-parse limits come before even the version.
  assert.ok(have.has('depth-before-version'));
});

for (const file of frameFiles) {
  test(`frames/${file} verifies exactly as stated`, () => {
    const f = JSON.parse(readFileSync(join(FIXTURE_DIR, 'frames', file), 'utf8')) as Fixture;
    assert.equal(f.frames.length, f.expect.length);
    const keys = new Map<string, TrustedKey>();
    for (const kid of f.trust) {
      const k = keyFile.keys.find((x) => x.kid === kid);
      assert.ok(k?.owner, `trusted kid ${kid} must exist and have an owner`);
      keys.set(kid, { owner: k.owner, publicKey: publicKey(k.public) });
    }
    const ctx = { self: f.receiver, now: f.now, keys, seen: new Set<string>() };
    const got = f.frames.map((raw) => {
      const v = verifyFrame(raw, ctx);
      return v.ok ? 'ok' : v.code;
    });
    assert.deepEqual(got, f.expect);
  });
}

test('canonical.json: every case canonicalises as stated, or is refused', () => {
  const c = JSON.parse(readFileSync(join(FIXTURE_DIR, 'canonical.json'), 'utf8')) as { cases: { about: string; input: string; canonical?: string; error?: boolean }[] };
  assert.ok(c.cases.length >= 10);
  for (const k of c.cases) {
    if (k.error) {
      assert.throws(() => canonicalize(JSON.parse(k.input)), k.about);
    } else {
      assert.equal(canonicalize(JSON.parse(k.input)), k.canonical, k.about);
      // A canonical form is a fixed point: canonicalising it again changes nothing.
      assert.equal(canonicalize(JSON.parse(k.canonical!)), k.canonical, `${k.about} (fixed point)`);
    }
  }
});

test('the verifier is not a rubber stamp: flipping one signature bit of a valid frame is caught', () => {
  const f = JSON.parse(readFileSync(join(FIXTURE_DIR, 'frames', 'job-session-reply.json'), 'utf8')) as Fixture;
  const raw = f.frames[0];
  const env = JSON.parse(raw) as { sig: string };
  const sig = Buffer.from(env.sig, 'base64url');
  sig[0] ^= 1;
  const flipped = canonicalize({ ...env, sig: sig.toString('base64url') });
  const k = keyFile.keys.find((x) => x.kid === f.trust[0])!;
  const keys = new Map<string, TrustedKey>([[k.kid, { owner: k.owner!, publicKey: publicKey(k.public) }]]);
  const ctx = { self: f.receiver, now: f.now, keys, seen: new Set<string>() };
  const v = verifyFrame(flipped, ctx);
  assert.equal(v.ok ? 'ok' : v.code, 'bad_signature');
});
