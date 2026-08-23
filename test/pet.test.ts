// Unit: the requirement pet and how it evolves (the easter-egg layer). It guards two lines: (1) it is purely
// deterministic (the same requirement renders the same way every time, so it can be asserted on); (2) the
// lines never leak jargon (the same discipline as display).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { petStage, treeLine, finalForm, feedLine, easterEgg, PET_TREE } from '../src/util/pet.ts';
import { STATES } from '../src/statemachine/states.ts';

test('petStage: every state has a pet (sprite / tier 1-5 / line), and no line leaks jargon', () => {
  for (const s of STATES) {
    const p = petStage(s as never);
    assert.ok(p.sprite && p.stage && p.voice, `state ${s} has no pet definition`);
    assert.ok(p.tier >= 1 && p.tier <= PET_TREE.length, `state ${s} has a tier out of range: ${p.tier}`);
    assert.doesNotMatch(p.voice, /Gate [ABCD]|GATE_|ADVERSARIAL|AWAITING|CONFIRM/, `state ${s} leaks jargon in its line: ${p.voice}`);
  }
});

test('treeLine: highlights the current stage and carries all 5', () => {
  const line = treeLine('AWAITING_PM_CONFIRM'); // tier 2
  assert.match(line, /\[🐣\]/); // the second stage is highlighted
  for (const e of PET_TREE) assert.ok(line.includes(e), `the evolution tree is missing ${e}`);
});

test('finalForm: deterministic (constant for the same id) and drawn from the known set', () => {
  const a = finalForm({ id: 'abc', slug: 'x' });
  const b = finalForm({ id: 'abc', slug: 'x' });
  assert.equal(a, b, "the same requirement's final form must be stable");
  const known = ['🦄', '🐉', '🦅', '🦚', '🦖', '🦢', '🦩', '✨🦄✨'];
  assert.ok(known.includes(a), `the final form ${a} is not in the known set`);
});

test('feedLine: the group card hides the dollar figure (bites only), a direct message carries the real one', () => {
  const group = feedLine(0.19, { showDollar: false });
  assert.doesNotMatch(group, /\$/, 'the group card must not reveal the amount');
  assert.match(group, /Fed .* bites/);
  const dm = feedLine(0.19, { showDollar: true });
  assert.match(dm, /\$0\.19/, 'a direct message must carry the real dollar figure');
});

test('easterEgg: the milestone (every tenth) always fires; an ordinary requirement is deterministic (and may be null)', () => {
  assert.match(easterEgg({ id: 'x', ref_num: 10, created_at: 0 }) ?? '', /Milestone/);
  assert.match(easterEgg({ id: 'x', ref_num: 20, created_at: 0 }) ?? '', /Milestone/);
  // Calling it repeatedly with the same input gives the same answer (determinism)
  const once = easterEgg({ id: 'plain-7', ref_num: 7, created_at: 0 });
  const twice = easterEgg({ id: 'plain-7', ref_num: 7, created_at: 0 });
  assert.equal(once, twice);
});
