// Unit tests: the SessionStore seam (the store/port.ts interface + the store/index.ts selection point + the
// localSqlite adapter).
// It holds two lines:
//   1. the `store` at the selection point is exactly the bundle of localSqlite free functions (reference
//      equality, so there is zero behavioural drift), **with the only exceptions being the ones named
//      explicitly in WRAPPED** (the extension-hook decorator);
//   2. going through `store.*` against real sqlite, the create / get / patch / transition / event chain behaves
//      identically to calling the free functions directly.
// FORGE_DB must be set before the imports (real node:sqlite, isolated with :memory:).
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sessions = await import('../src/store/sessions.ts');
const { store } = await import('../src/store/index.ts');

// Every public operation on the seam. Missing one only blows up later, when a consumer migrates to store.*.
const SEAM_METHODS = [
  'create', 'findByIssueRef', 'isDuplicateDocRefError', 'isDuplicateIssueRefError',
  'get', 'getBySlug', 'findByPrdUrl', 'findByDocRef', 'resolve',
  'listByStates', 'listAll', 'distinctProjects', 'countByState', 'countByStates',
  'patch', 'transition', 'appendEvent', 'events', 'lastEventTs', 'leaseClaim',
] as const;

// The methods the selection point wraps in a decorator. **This is an allowlist, not an exemption**:
// transition is wrapped by withTransitionHook (the extension lifecycle hook; see src/store/index.ts).
// If anyone quietly wraps a second method without updating this set, the assertion below goes red immediately -
// which is stricter than the original "everything must be reference-equal", because it simultaneously holds the
// line that no method which should not be wrapped has been.
const WRAPPED = new Set<string>(['transition']);

// 1. The selection point is the bundle of localSqlite free functions (plus the explicitly named decorators).
test('the store selection point: every method not on the list is reference-equal to the sessions free function (zero drift)', () => {
  for (const m of SEAM_METHODS) {
    const free = (sessions as unknown as Record<string, unknown>)[m];
    if (typeof free !== 'function') continue; // this operation is not exported as a free function, so skip the reference comparison
    if (WRAPPED.has(m)) {
      assert.notEqual(store[m], free, `${m} is on the WRAPPED list but is not actually wrapped - the list is out of date`);
    } else {
      assert.equal(store[m], free, `${m} was quietly swapped for a different implementation (which will drift); if the wrapping is deliberate, add it to WRAPPED and state why`);
    }
  }
});

test('the store selection point: the decorator must neither add nor remove methods on the seam', () => {
  // Spreading `...inner` copies only own enumerable properties: if the adapter ever moves to a class with
  // prototype methods, methods would silently be dropped here, and the symptom would be a runtime
  // "store.xxx is not a function" far from the change that caused it. This catches it before the commit.
  assert.deepEqual(
    Object.keys(store).sort(),
    Object.keys(sessions.localSqliteStore).sort(),
    "the selection point's method set must match the adapter's exactly",
  );
});

test('the store seam is complete: it covers every public store operation in sessions', () => {
  for (const m of SEAM_METHODS) {
    assert.equal(typeof store[m], 'function', `store.${m} is missing`);
  }
});

// 2. The full chain through store.* against real sqlite (the same database and behaviour as calling sessions.*
//    directly).
test('store.create -> the get / patch / transition / event chain (real sqlite)', async () => {
  const s = await store.create({ id: 'p1', slug: 'p1', title: 'T', branch: 'dev', prd_url: 'https://x.feishu.cn/wiki/p1' });
  assert.equal(s.state, 'INTAKE');
  assert.equal((await store.get('p1'))!.slug, 'p1');

  await store.patch('p1', { title: 'T2' });
  assert.equal((await store.get('p1'))!.title, 'T2');

  await store.transition('p1', 'GATE_A_RUNNING');
  assert.equal((await store.get('p1'))!.state, 'GATE_A_RUNNING');
  await assert.rejects(() => store.transition('p1', 'DONE'), /illegal transition/);

  await store.appendEvent('p1', 'note', { k: 1 });
  const kinds = (await store.events('p1')).map((e) => e.kind);
  assert.ok(kinds.includes('intake') && kinds.includes('transition') && kinds.includes('note'));
});

// store and the sessions free functions share one database: what one writes the other reads, proving there are
// not two separate sets of state.
test('store and the sessions free functions share one database (the same view)', async () => {
  await sessions.create({ id: 'p2', slug: 'p2', title: 'T', branch: 'dev', prd_url: 'https://x.feishu.cn/wiki/p2' });
  assert.equal((await store.get('p2'))!.id, 'p2');
  await store.patch('p2', { size: 'L' });
  assert.equal((await sessions.get('p2'))!.size, 'L');
});
