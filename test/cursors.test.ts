// Unit: the watermark semantics of the chat backfill cursor (monotonic advance, idempotent seeding). This is
// the correctness core of "no requirement is missed while offline".
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const cursors = await import('../src/store/cursors.ts');

test('seedCursor: seeds only when the cursor is missing, and never overwrites an existing watermark', () => {
  cursors.seedCursor('oc_a', 1000);
  assert.equal(cursors.getCursor('oc_a'), 1000);
  cursors.seedCursor('oc_a', 5000); // already present -> not overwritten (otherwise seeding with now on every start-up would wipe the real watermark and messages would be missed)
  assert.equal(cursors.getCursor('oc_a'), 1000);
});

test('advanceCursor: advances only, never rewinds (so an out-of-order message cannot pull the watermark back and cause duplicates or gaps)', () => {
  cursors.advanceCursor('oc_b', 2000);
  assert.equal(cursors.getCursor('oc_b'), 2000);
  cursors.advanceCursor('oc_b', 1500); // smaller -> no change
  assert.equal(cursors.getCursor('oc_b'), 2000);
  cursors.advanceCursor('oc_b', 3000); // larger -> it advances
  assert.equal(cursors.getCursor('oc_b'), 3000);
});

test('advanceCursor on an unknown chat registers it for the first time; getCursor on an unknown chat -> null', () => {
  assert.equal(cursors.getCursor('oc_new'), null);
  cursors.advanceCursor('oc_new', 42);
  assert.equal(cursors.getCursor('oc_new'), 42);
});

test('allChats: lists every registered chat (what the backfill walks)', () => {
  cursors.seedCursor('oc_x', 1);
  cursors.advanceCursor('oc_y', 1);
  const all = cursors.allChats();
  assert.ok(all.includes('oc_x') && all.includes('oc_y'));
});
