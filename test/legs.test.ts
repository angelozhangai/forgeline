// Unit tests: the helpers behind the multi-repo "one leg per repo" model (src/gates/legs.ts). The pure
// functions (mkLeg / getLegs / buildLegs) plus setLegs / patchLeg persisting to the store.
// It uses a real sessions store (:memory:) - patchLeg re-reads the legs from the DB (so that writing several
// legs in a row from one stale reference does not have them overwrite each other), and only a real store can
// verify that invariant.
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sessions = await import('../src/store/sessions.ts');
const { mkLeg, getLegs, buildLegs, setLegs, patchLeg, planLegAdvance, planGateDAdvance } = await import('../src/gates/legs.ts');

let n = 0;
async function mk(): Promise<string> {
  const id = `leg${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  return id;
}

test('mkLeg: anchors the repo name only, leaving every other field empty (pending); fields can override', () => {
  const l = mkLeg('demo');
  assert.equal(l.repo, 'demo');
  assert.equal(l.worktree_path, null);
  assert.equal(l.ci_ok, null);
  assert.equal(l.merged, null);
  const built = mkLeg('demo', { worktree_path: '/wt', base_sha: 'abc' });
  assert.equal(built.worktree_path, '/wt');
  assert.equal(built.base_sha, 'abc');
});

test('getLegs: broken, empty or non-array JSON -> []; valid JSON parses normally', () => {
  assert.deepEqual(getLegs({ legs: null }), []);
  assert.deepEqual(getLegs({ legs: '{broken json' }), []);
  assert.deepEqual(getLegs({ legs: '"not an array"' }), []);
  assert.equal(getLegs({ legs: JSON.stringify([mkLeg('demo')]) }).length, 1);
});

test('buildLegs: preserves order, and the builder fills the fields (the primary gets a worktree, the rest stay pending)', () => {
  const legs = buildLegs(['demo', 'example-web'], (_r, i) => (i === 0 ? { worktree_path: '/wt/demo' } : {}));
  assert.deepEqual(
    legs.map((l) => l.repo),
    ['demo', 'example-web'],
  );
  assert.equal(legs[0].worktree_path, '/wt/demo');
  assert.equal(legs[1].worktree_path, null);
});

test('setLegs: persists the whole set', async () => {
  const id = await mk();
  await setLegs({ id }, [mkLeg('demo')]);
  assert.deepEqual(
    getLegs((await sessions.get(id))!).map((l) => l.repo),
    ['demo'],
  );
});

test('patchLeg: updates one leg by repo; an unknown repo changes nothing (it never speculatively adds one)', async () => {
  const id = await mk();
  await setLegs({ id }, [mkLeg('demo'), mkLeg('example-web')]);
  await patchLeg({ id }, 'example-web', { ci_ok: true });
  const legs = getLegs((await sessions.get(id))!);
  assert.equal(legs.find((l) => l.repo === 'example-web')!.ci_ok, true);
  assert.equal(legs.find((l) => l.repo === 'demo')!.ci_ok, null); // only the targeted leg changes
  await patchLeg({ id }, 'nope-repo', { ci_ok: true });
  assert.equal(getLegs((await sessions.get(id))!).length, 2); // a repo that does not exist is not added
});

test('planLegAdvance: once the current leg is marked green, return the next repo that is not green and already has a worktree; all green -> null', () => {
  const legs = [
    mkLeg('demo', { worktree_path: '/wt/c' }),
    mkLeg('example-web', { worktree_path: '/wt/u' }),
    mkLeg('example-admin', { worktree_path: '/wt/a' }),
  ];
  assert.equal(planLegAdvance(legs, 'demo').nextRepo, 'example-web'); // demo went green -> move to the next
  const after1 = legs.map((l) => (['demo', 'example-web'].includes(l.repo) ? { ...l, ci_ok: true } : l));
  assert.equal(planLegAdvance(after1, 'example-admin').nextRepo, null); // the last one went green -> all green
  assert.equal(planLegAdvance([mkLeg('demo', { worktree_path: '/wt/c' })], 'demo').nextRepo, null); // a single repo going green -> null
  // A leg with no worktree is never the next step (setup creates one for every leg; this is a defensive guard)
  assert.equal(planLegAdvance([mkLeg('demo', { worktree_path: '/wt/c' }), mkLeg('example-web')], 'demo').nextRepo, null);
});

test('planGateDAdvance: once the current leg is marked through Gate D, return the next repo that has a PR open, has a worktree and has not been through Gate D; all through -> null', () => {
  const legs = [
    mkLeg('demo', { worktree_path: '/wt/c', pr_url: 'PC' }),
    mkLeg('example-web', { worktree_path: '/wt/u', pr_url: 'PU' }),
    mkLeg('example-admin', { worktree_path: '/wt/a', pr_url: 'PA' }),
  ];
  assert.equal(planGateDAdvance(legs, 'demo').nextRepo, 'example-web'); // demo finished hardening -> move to the next
  // demo and example-web are both through Gate D (they have a verified sha) -> admin is next
  const after2 = legs.map((l) => (['demo', 'example-web'].includes(l.repo) ? { ...l, gate_d_harden_verified_sha: 'V' } : l));
  assert.equal(planGateDAdvance(after2, 'example-admin').nextRepo, null); // the last one finished hardening -> all through
  assert.equal(planGateDAdvance([mkLeg('demo', { worktree_path: '/wt/c', pr_url: 'PC' })], 'demo').nextRepo, null); // a single repo -> null
});

test('planGateDAdvance: a leg with no PR or no worktree is never the next step (a defensive guard - in practice Gate C and openReviewPr create and open them all)', () => {
  // The next leg has no pr_url -> do not advance (there is no PR to review)
  assert.equal(
    planGateDAdvance([mkLeg('demo', { worktree_path: '/wt/c', pr_url: 'PC' }), mkLeg('example-web', { worktree_path: '/wt/u' })], 'demo').nextRepo,
    null,
  );
  // The next leg has no worktree -> do not advance
  assert.equal(
    planGateDAdvance([mkLeg('demo', { worktree_path: '/wt/c', pr_url: 'PC' }), mkLeg('example-web', { pr_url: 'PU' })], 'demo').nextRepo,
    null,
  );
});

test('patchLeg: re-reads from the DB - writing several legs in a row from one stale reference does not have them overwrite each other (the openReviewPr per-leg case)', async () => {
  const id = await mk();
  await setLegs({ id }, [mkLeg('demo'), mkLeg('example-web')]);
  const stale = (await sessions.get(id))!; // a stale snapshot: neither leg has a pr_url yet
  await patchLeg(stale, 'demo', { pr_url: 'A' });
  await patchLeg(stale, 'example-web', { pr_url: 'B' }); // still the stale snapshot, but patchLeg re-reads the latest from the DB
  const legs = getLegs((await sessions.get(id))!);
  assert.equal(legs.find((l) => l.repo === 'demo')!.pr_url, 'A'); // not overwritten by the second patch (the old implementation turned this into null)
  assert.equal(legs.find((l) => l.repo === 'example-web')!.pr_url, 'B');
});
