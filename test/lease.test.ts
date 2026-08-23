// Unit tests: the atomic claim semantics of store.leaseClaim() (the lease that stops several runners claiming
// the same job).
// It holds four lines: (1) two runners never claim the same job; (2) an expired lease may be re-claimed by
// another runner (the holder is presumed dead); (3) a runner renews its own lease (claiming again returns its
// own jobs with a later expiry); (4) a claim **never bumps updated_at** (which would wipe out remindStuck's
// idle check).
// FORGE_DB must be set before the imports (real node:sqlite, :memory:). The implementation is imported directly
// - this is an implementation unit test, and the seam guardrail only governs consumers under src/.
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { localSqliteStore: store } = await import('../src/store/sessions.ts');

function mk(id: string, state: string): Promise<unknown> {
  return store.create({ id, slug: id, title: `T ${id}`, branch: 'dev', state: state as never });
}

// Each test claims from **its own poller state**, which keeps it clear of sessions other tests have created or
// leased in the shared :memory: database (otherwise the state filter would pick them up across tests). Every one
// of these states is POLLER_DRIVEN.

test('lease 1: two runners never claim the same job - once A has claimed, B claiming at the same moment gets nothing', async () => {
  await mk('L1', 'INTAKE');
  await mk('L2', 'GATE_C_LOOP');
  await mk('Lh', 'AWAITING_GO'); // not in the state set -> never claimed (it is waiting on a human)

  const states = ['INTAKE', 'GATE_C_LOOP'] as never;
  const a = await store.leaseClaim(states, 'runnerA', 60_000, 100);
  assert.deepEqual(a.map((s) => s.id).sort(), ['L1', 'L2']);
  // B claims at the same moment: L1 and L2 are leased to A (unexpired, and not held by B) -> nothing, and
  // certainly no double claim.
  const b = await store.leaseClaim(states, 'runnerB', 60_000, 100);
  assert.deepEqual(b, []);
  // The persisted owner really is A.
  assert.equal((await store.get('L1'))!.lease_owner, 'runnerA');
  assert.equal((await store.get('Lh'))!.lease_owner, null); // a state waiting on a human is never claimed
});

test('lease 2: an expired lease is re-claimed by another runner (the holder is presumed dead)', async () => {
  await mk('E1', 'GATE_B_REQUESTED'); // a state private to this test, clear of lease 1's INTAKE
  // A claims it with an **already expired** lease (a negative ttl puts the expiry in the past).
  const a = await store.leaseClaim(['GATE_B_REQUESTED'] as never, 'runnerA', -1000, 100);
  assert.deepEqual(a.map((s) => s.id), ['E1']);
  // B claims: A's lease has expired (expires < now), so B gets it.
  const b = await store.leaseClaim(['GATE_B_REQUESTED'] as never, 'runnerB', 60_000, 100);
  assert.deepEqual(b.map((s) => s.id), ['E1']);
  assert.equal((await store.get('E1'))!.lease_owner, 'runnerB');
});

test('lease 3: self-renewal - the same runner claiming again gets its own jobs back with a later expiry', async () => {
  await mk('R1', 'GATE_D_LOOP'); // a state private to this test
  const first = await store.leaseClaim(['GATE_D_LOOP'] as never, 'runnerA', 60_000, 100);
  const exp1 = first[0]!.lease_expires_at!;
  const again = await store.leaseClaim(['GATE_D_LOOP'] as never, 'runnerA', 120_000, 100);
  assert.deepEqual(again.map((s) => s.id), ['R1']); // the self-held branch -> it gets it back
  assert.ok((again[0]!.lease_expires_at ?? 0) >= exp1, 'renewing should push the expiry later');
});

test('lease 4: a claim never bumps updated_at (so remindStuck\'s idle check is not wiped out)', async () => {
  await mk('U1', 'GATE_C_REQUESTED'); // a state private to this test
  const before = (await store.get('U1'))!.updated_at;
  await store.leaseClaim(['GATE_C_REQUESTED'] as never, 'runnerA', 60_000, 100);
  const after = (await store.get('U1'))!.updated_at;
  assert.equal(after, before, 'leaseClaim writes the lease columns and must never touch updated_at');
});

test('lease 5: empty states or limit < 1 -> nothing (it never accidentally claims the whole table)', async () => {
  assert.deepEqual(await store.leaseClaim([] as never, 'runnerA', 60_000, 100), []);
  await mk('Z1', 'GATE_A_ADVERSARIAL');
  assert.deepEqual(await store.leaseClaim(['GATE_A_ADVERSARIAL'] as never, 'runnerA', 60_000, 0), []);
});

test('lease 6: limit bounds how much is claimed per round, with no double claim (A takes 2, B takes the remaining 1, three in total with no overlap - the whole backlog is never leased at once)', async () => {
  await mk('F1', 'GATE_D_REQUESTED'); // a state private to this test
  await mk('F2', 'GATE_D_REQUESTED');
  await mk('F3', 'GATE_D_REQUESTED');
  const a = await store.leaseClaim(['GATE_D_REQUESTED'] as never, 'runnerA', 60_000, 2);
  assert.equal(a.length, 2, 'A claims only limit=2 this round (never the whole batch at once)');
  const b = await store.leaseClaim(['GATE_D_REQUESTED'] as never, 'runnerB', 60_000, 2);
  assert.equal(b.length, 1, 'B claims the single job A left (the backlog spreads across runners)');
  assert.deepEqual([...a, ...b].map((s) => s.id).sort(), ['F1', 'F2', 'F3'], 'all three were claimed with no overlap (no double claim)');
});
