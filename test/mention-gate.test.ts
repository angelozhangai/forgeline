// Unit tests for the **sole criterion** of the channel-message intake gate (messaging/gate.ts). A pure
// function, with no IO at all.
//
// This gate exists to stop money being spent: a document casually shared in a channel should not trigger a
// gate A run. It deserves its own file because its **third state** is the actual design point. Collapse
// "confirmed nobody mentioned the bot" and "cannot tell" into one boolean and it necessarily breaks one way
// or the other: treat it as not mentioned, and a provider that cannot supply mentions gets nothing through at
// all, so offline backfill silently stops working;
// treat it as mentioned, and the whole channel entry point quietly swings open, which is the same as having
// no gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionGate } from '../src/messaging/gate.ts';

test('a direct message is directed by nature -> let through, with no mention required', () => {
  assert.equal(mentionGate({ isGroup: false, mentionedBot: false }), 'admit');
});

test('isGroup omitted (an older provider, or an older test that never set it) is treated as not a group -> let through, keeping the existing meaning', () => {
  assert.equal(mentionGate({}), 'admit');
});

test('a channel message that confirmably mentions this bot -> let through', () => {
  assert.equal(mentionGate({ isGroup: true, mentionedBot: true }), 'admit');
});

test('a channel message that confirmably mentions nobody -> blocked (this is the one that stops a wasted gate A run)', () => {
  assert.equal(mentionGate({ isGroup: true, mentionedBot: false }), 'ignore');
});

test('a channel message with no way to tell (the envelope carries no mentions) -> the third state, never folded into either of the other two', () => {
  assert.equal(mentionGate({ isGroup: true, mentionedBot: null }), 'unconfirmable');
  assert.equal(mentionGate({ isGroup: true }), 'unconfirmable');
});
