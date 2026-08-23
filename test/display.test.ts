// Unit: the presentation layer (the requirement number and the state in plain language). It holds the line
// that "a card never leaks the Gate A / Gate B / GATE_ jargon".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reqRef, stateLabel, refTitle } from '../src/util/display.ts';
import { STATES } from '../src/statemachine/states.ts';

test('reqRef: with a ref_num -> REQ-n; without -> fall back to the slug', () => {
  assert.equal(reqRef({ ref_num: 7, slug: 'x' }), 'REQ-7');
  assert.equal(reqRef({ ref_num: null, slug: 'finance-report' }), 'finance-report');
});

test('stateLabel: every internal state has a plain-language label, and none leaks jargon (Gate A / Gate B / GATE_)', () => {
  for (const s of STATES) {
    const label = stateLabel(s as never);
    assert.ok(label && label !== s, `state ${s} has no plain-language label`);
    assert.doesNotMatch(label, /Gate [ABCD]|GATE_|ADVERSARIAL|INTAKE/, `state ${s}'s label leaks jargon: ${label}`);
  }
});

// The title is carried through verbatim (source is English, input is not): the requirement's own words reach
// the card unchanged, in whatever language they were written. The fixture is built from code points rather
// than written as literal characters (see test/english-only.test.ts).
test('refTitle: number · title (a long title truncated), optionally with a leading emoji', () => {
  const title = String.fromCodePoint(0x8d22, 0x52a1, 0x79ef, 0x5206, 0x62a5, 0x8868); // "finance points report"
  assert.equal(refTitle({ ref_num: 3, slug: 'x', title }, '🔴 '), `🔴 REQ-3 · ${title}`);
  const long = refTitle({ ref_num: 1, slug: 'x', title: 'a'.repeat(100) });
  assert.ok(long.length < 60, `a long title should be truncated, but it was ${long.length}`);
});
