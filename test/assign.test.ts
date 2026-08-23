// Unit: the automatic-assignment recommendation (least-loaded plus a WIP limit, a pure function).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, wipLimitOf, inPool, type LoadRow } from '../src/util/assign.ts';

// The test configuration: M has a limit of 2 (a lead has less capacity), everyone else the default of 3.
const cfg = { pool: ['M', 'EO', 'CC', 'DE'], wip_limit: { default: 3, M: 2 }, in_progress_statuses: [4, 5, 6] };

const L = (code: string, wip: number, loadPoints: number): LoadRow => ({ code, wip, loadPoints });

test('wipLimitOf: an override wins, otherwise the default', () => {
  assert.equal(wipLimitOf(cfg, 'M'), 2);
  assert.equal(wipLimitOf(cfg, 'EO'), 3);
});

test('inPool: normalised case-insensitively; not in the pool -> null', () => {
  assert.equal(inPool(cfg, 'de'), 'DE');
  assert.equal(inPool(cfg, ' m '), 'M');
  assert.equal(inPool(cfg, 'BD'), null);
});

test('it picks whoever has the lowest projected load', () => {
  const r = recommend('M', [L('M', 0, 8), L('EO', 0, 3), L('CC', 0, 0), L('DE', 0, 20)], cfg);
  assert.equal(r.pick, 'CC'); // 0 + 3 = 3, the lowest
  assert.equal(r.points, 3);
  assert.equal(r.allOverWip, false);
});

test('someone over their WIP limit is excluded, even with the lowest load', () => {
  const r = recommend('S', [L('M', 0, 8), L('EO', 0, 3), L('CC', 3, 0), L('DE', 0, 20)], cfg);
  assert.equal(r.pick, 'EO'); // CC has 0 load but 3 in progress >= the limit of 3 -> out; EO's 3+1=4 is next lowest
  const lx = r.table.find((x) => x.code === 'CC')!;
  assert.equal(lx.eligible, false);
  assert.equal(r.allOverWip, false);
});

test('everyone over their WIP limit -> fall back to the whole pool, pick the best, and flag it', () => {
  const r = recommend('M', [L('M', 2, 5), L('EO', 3, 1), L('CC', 3, 0), L('DE', 3, 10)], cfg);
  assert.equal(r.allOverWip, true);
  assert.equal(r.pick, 'CC'); // after falling back it still takes the lowest projection, 0+3
});

test('a tie: equal projections -> whoever has fewer requirements in progress wins', () => {
  // M and DE are lifted out of contention by their load; EO and CC both project to 8, and CC has fewer in progress.
  const r = recommend('M', [L('M', 0, 100), L('EO', 2, 5), L('CC', 1, 5), L('DE', 0, 100)], cfg);
  assert.equal(r.pick, 'CC');
});

test('the size points show up in points and in the projection', () => {
  assert.equal(recommend('XL', [], cfg).points, 20);
  assert.equal(recommend(null, [], cfg).points, 0);
});

test('a member whose probe failed (ok=false) takes no part in the automatic pick — an unknown load is never treated as 0 and handed the work', () => {
  // EO's probe failed: even though they look like zero load they must not be picked; the best of the known loads wins.
  const r = recommend(
    'M',
    [
      { code: 'M', wip: 0, loadPoints: 8, ok: true },
      { code: 'EO', wip: 0, loadPoints: 0, ok: false }, // the probe failed -> excluded
      { code: 'CC', wip: 0, loadPoints: 3, ok: true },
      { code: 'DE', wip: 0, loadPoints: 20, ok: true },
    ],
    cfg,
  );
  assert.equal(r.pick, 'CC'); // the lowest projection among the known; EO is unknown and excluded
  assert.equal(r.probeIncomplete, true);
});

test('a pool member with no row counts as unknown (ok:false) and is not recommended', () => {
  // Only M has data; EO/CC/DE have no row -> they default to ok:false and unknown -> out of the automatic pick, leaving M.
  const r = recommend('M', [{ code: 'M', wip: 1, loadPoints: 5, ok: true }], cfg);
  assert.equal(r.pick, 'M');
  assert.equal(r.probeIncomplete, true);
  assert.equal(r.table.length, 4); // the table still lays out the whole pool (for display)
});

test('every probe failed or is unknown -> pick=null (a human has to assign it)', () => {
  const r = recommend(
    'M',
    [
      { code: 'M', wip: 0, loadPoints: 0, ok: false },
      { code: 'EO', wip: 0, loadPoints: 0, ok: false },
    ],
    cfg,
  );
  assert.equal(r.pick, null);
  assert.equal(r.probeIncomplete, true);
});
