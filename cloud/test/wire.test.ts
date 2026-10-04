// The Worker's implementation of wire protocol v1 against the golden fixtures (fixtures/wire/v1/).
//
// The fixtures are the contract between the reference (tools/wire-fixtures.ts), this Worker and the Rust agent.
// Every case in them runs here, inside workerd, on WebCrypto -- the same runtime and the same crypto the
// deployed Worker uses. A case that is added to the fixtures runs here automatically (import.meta.glob), and
// the coverage test below fails if the glob ever comes back thinner than the protocol.
import { describe, expect, test } from 'vitest';
import * as b64 from '../src/wire/base64url.ts';
import { canonicalize } from '../src/wire/canonical.ts';
import { type Envelope, importPublicKey, kidOf, REJECT_CODES, seal, signerFromSeed, type TrustedKey, verifyFrame } from '../src/wire/frame.ts';
import canonicalFile from '../../fixtures/wire/v1/canonical.json';
import keyFile from '../../fixtures/wire/v1/keys.json';

interface Fixture {
  about: string;
  receiver: string;
  now: number;
  trust: string[];
  frames: string[];
  expect: string[];
}
interface KeyEntry {
  name: string;
  owner: string | null;
  seed_hex: string;
  public: string;
  kid: string;
}

// Resolved by Vite when the test is bundled: workerd has no filesystem to read them from at run time.
const fixtures = Object.entries(import.meta.glob<Fixture>('../../fixtures/wire/v1/frames/*.json', { eager: true, import: 'default' }))
  .map(([path, f]) => ({ name: path.split('/').pop()!.replace(/\.json$/, ''), f }))
  .sort((a, b) => a.name.localeCompare(b.name));
const keys = keyFile.keys as KeyEntry[];

async function keyring(trust: string[]): Promise<Map<string, TrustedKey>> {
  const ring = new Map<string, TrustedKey>();
  for (const kid of trust) {
    const k = keys.find((x) => x.kid === kid);
    if (!k?.owner) throw new Error(`fixture trusts ${kid}, which keys.json does not give an owner`);
    ring.set(kid, { owner: k.owner, key: await importPublicKey(b64.decode(k.public)) });
  }
  return ring;
}

describe('fixtures/wire/v1/frames', () => {
  test('the glob found the fixtures, and they cover every message type and every rejection code', () => {
    expect(fixtures.length).toBeGreaterThan(0);
    const verdicts = new Set(fixtures.flatMap(({ f }) => f.expect));
    for (const code of REJECT_CODES) expect(verdicts, `no fixture is rejected with ${code}`).toContain(code);
    const types = new Set<string>();
    for (const { f } of fixtures) {
      f.frames.forEach((raw, i) => {
        if (f.expect[i] === 'ok') types.add((JSON.parse(raw) as Envelope).type);
      });
    }
    expect([...types].sort()).toEqual(['ack', 'auth', 'challenge', 'error', 'event', 'job', 'result', 'welcome']);
  });

  // One test per fixture file, so a failure names the case.
  for (const { name, f } of fixtures) {
    test(`${name} verifies exactly as stated`, async () => {
      expect(f.frames.length).toBe(f.expect.length);
      const ctx = { self: f.receiver, now: f.now, keys: await keyring(f.trust), seen: new Set<string>() };
      const got: string[] = [];
      for (const raw of f.frames) {
        const v = await verifyFrame(raw, ctx);
        got.push(v.ok ? 'ok' : v.code);
      }
      expect(got, f.about).toEqual(f.expect);
    });
  }
});

describe('signing reproduces the fixtures byte for byte', () => {
  // Ed25519 is deterministic: the same key and the same bytes give the same signature. So re-signing an
  // accepted fixture frame must give back exactly the same text -- which pins the canonical form, the signing
  // input (domain prefix included) and the signature in one comparison.
  const accepted = fixtures.flatMap(({ name, f }) => f.frames.filter((_, i) => f.expect[i] === 'ok').map((raw) => ({ name, raw })));

  test('every accepted frame signed by the cloud test key', async () => {
    const cloud = keys.find((k) => k.name === 'cloud')!;
    const signer = await signerFromSeed(b64.fromHex(cloud.seed_hex), 'cloud');
    expect(signer.kid).toBe(cloud.kid);
    const fromCloud = accepted.filter(({ raw }) => (JSON.parse(raw) as Envelope).from === 'cloud');
    expect(new Set(fromCloud.map(({ raw }) => (JSON.parse(raw) as Envelope).type))).toEqual(new Set(['ack', 'challenge', 'error', 'job', 'welcome']));
    for (const { name, raw } of fromCloud) {
      const { sig: _sig, ...unsigned } = JSON.parse(raw) as Envelope;
      expect(await seal(unsigned, signer), name).toBe(raw);
    }
  });

  test('every accepted frame signed by the device test key (the signing input is the same in both directions)', async () => {
    const device = keys.find((k) => k.name === 'device')!;
    const signer = await signerFromSeed(b64.fromHex(device.seed_hex), device.owner!);
    expect(signer.kid).toBe(device.kid);
    const fromDevice = accepted.filter(({ raw }) => (JSON.parse(raw) as Envelope).from === device.owner);
    expect(new Set(fromDevice.map(({ raw }) => (JSON.parse(raw) as Envelope).type))).toEqual(new Set(['ack', 'auth', 'event', 'result']));
    for (const { name, raw } of fromDevice) {
      const { sig: _sig, ...unsigned } = JSON.parse(raw) as Envelope;
      expect(await seal(unsigned, signer), name).toBe(raw);
    }
  });

  test('seal refuses to sign what could only be rejected: a kid or sender that is not the signer, a malformed envelope', async () => {
    const cloud = keys.find((k) => k.name === 'cloud')!;
    const signer = await signerFromSeed(b64.fromHex(cloud.seed_hex), 'cloud');
    const { sig: _sig, ...unsigned } = JSON.parse(accepted.find(({ raw }) => (JSON.parse(raw) as Envelope).from === 'cloud')!.raw) as Envelope;
    await expect(seal({ ...unsigned, kid: keys.find((k) => k.name === 'attacker')!.kid }, signer)).rejects.toThrow(/not the signer/);
    await expect(seal({ ...unsigned, from: keys.find((k) => k.name === 'device')!.owner! }, signer)).rejects.toThrow(/signs for cloud/);
    await expect(seal({ ...unsigned, id: 'not-a-ulid' }, signer)).rejects.toThrow(/malformed envelope: id/);
    await expect(seal({ ...unsigned, re: undefined }, signer)).rejects.toThrow();
  });
});

describe('keys.json', () => {
  test('each kid is derived from its public key, and each seed yields its public key', async () => {
    for (const k of keys) {
      expect(await kidOf(b64.decode(k.public)), k.name).toBe(k.kid);
      const signer = await signerFromSeed(b64.fromHex(k.seed_hex), k.owner ?? 'cloud');
      expect(signer.kid, k.name).toBe(k.kid);
    }
  });
});

describe('fixtures/wire/v1/canonical.json', () => {
  for (const c of canonicalFile.cases as { about: string; input: string; canonical?: string; error?: boolean }[]) {
    test(c.about, () => {
      if (c.error) {
        expect(() => canonicalize(JSON.parse(c.input))).toThrow();
        return;
      }
      expect(canonicalize(JSON.parse(c.input))).toBe(c.canonical);
      // A canonical form is a fixed point.
      expect(canonicalize(JSON.parse(c.canonical!))).toBe(c.canonical);
    });
  }
});

describe('the verifier is not a rubber stamp', () => {
  const reply = fixtures.find(({ name }) => name === 'job-session-reply')!.f;

  test('flipping one bit of a valid signature is caught', async () => {
    const env = JSON.parse(reply.frames[0]) as Envelope;
    const sig = b64.decode(env.sig);
    sig[0] ^= 1;
    const flipped = canonicalize({ ...env, sig: b64.encode(sig) });
    const v = await verifyFrame(flipped, { self: reply.receiver, now: reply.now, keys: await keyring(reply.trust), seen: new Set() });
    expect(v.ok ? 'ok' : v.code).toBe('bad_signature');
  });

  test('the same valid frame is refused once the receiver trusts nobody', async () => {
    const v = await verifyFrame(reply.frames[0], { self: reply.receiver, now: reply.now, keys: new Map(), seen: new Set() });
    expect(v.ok ? 'ok' : v.code).toBe('unknown_key');
  });
});

describe('the order of the checks (section 5.4)', () => {
  // A frame that is wrong in two ways must get the earlier code. The golden fixtures pin every code but
  // (as of v1) no frame that is wrong in two ways, so the order is pinned here, one adjacent pair at a time.
  const reply = fixtures.find(({ name }) => name === 'job-session-reply')!.f;
  const base = JSON.parse(reply.frames[0]) as Envelope;
  const { sig: _sig, ...unsigned } = base;
  const otherDevice = 'dev_01M3ZGYZ00ZZZZZZZZZZZZZZZZ';
  const signer = (name: string) => {
    const k = keys.find((x) => x.name === name)!;
    return signerFromSeed(b64.fromHex(k.seed_hex), 'cloud');
  };
  const verdict = async (raw: string) => {
    const v = await verifyFrame(raw, { self: reply.receiver, now: reply.now, keys: await keyring(reply.trust), seen: new Set() });
    return v.ok ? 'ok' : v.code;
  };

  test('unsupported_version before malformed: v=2 with an unknown field', async () => {
    expect(await verdict(canonicalize({ ...base, v: 2, x: 1 }))).toBe('unsupported_version');
  });

  test('malformed before non_canonical: a fraction in a pretty-printed frame', async () => {
    expect(await verdict(JSON.stringify({ ...base, body: { ...base.body, attempt: 1.5 } }, null, 1))).toBe('malformed');
  });

  test('non_canonical before unknown_key: a frame from an untrusted key, pretty-printed', async () => {
    const attacker = keys.find((k) => k.name === 'attacker')!;
    const frame = JSON.parse(await seal({ ...unsigned, kid: attacker.kid }, await signer('attacker'))) as Envelope;
    expect(await verdict(JSON.stringify(frame, null, 1))).toBe('non_canonical');
  });

  test('unknown_key before bad_signature: an untrusted kid with a garbage signature', async () => {
    const attacker = keys.find((k) => k.name === 'attacker')!;
    expect(await verdict(canonicalize({ ...base, kid: attacker.kid, sig: 'A'.repeat(86) }))).toBe('unknown_key');
  });

  test('bad_signature before wrong_recipient: a genuine frame re-addressed in transit', async () => {
    expect(await verdict(canonicalize({ ...base, to: otherDevice }))).toBe('bad_signature');
  });

  test('wrong_recipient before stale: a validly signed frame for another device, outside the window', async () => {
    const frame = await seal({ ...unsigned, to: otherDevice, ts: reply.now - 10 * 60 * 1000 }, await signer('cloud'));
    expect(await verdict(frame)).toBe('wrong_recipient');
  });

  test('stale before replay, and a stale frame is not remembered as seen', async () => {
    const frame = await seal({ ...unsigned, ts: reply.now - 10 * 60 * 1000 }, await signer('cloud'));
    const seen = new Set<string>();
    const ctx = { self: reply.receiver, now: reply.now, keys: await keyring(reply.trust), seen };
    expect((await verifyFrame(frame, ctx)).ok).toBe(false);
    const again = await verifyFrame(frame, ctx);
    expect(again.ok ? 'ok' : again.code).toBe('stale');
    expect(seen.size).toBe(0);
  });
});

describe('base64url', () => {
  test('round-trips every length around the padding boundaries, with no padding and no + or /', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 101) & 0xff);
      const s = b64.encode(bytes);
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
      expect([...b64.decode(s)]).toEqual([...bytes]);
    }
  });
});
