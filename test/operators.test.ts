// resolveActor: an inbound open_id becomes a short code, so the permission gate rules on whoever really
// pressed the button. This guards two hard rules, one about safety and one about compatibility.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveActor } from '../src/messaging/operators.ts';

test('with no operators configured (a single-person setup) everything falls back to M, exactly as before', () => {
  assert.equal(resolveActor('ou_anything', {}), 'M');
  assert.equal(resolveActor(undefined, {}), 'M');
});

test('with operators configured, a known open_id maps to its short code', () => {
  const ops = { ou_m: 'M', ou_jt: 'BD' };
  assert.equal(resolveActor('ou_m', ops), 'M');
  assert.equal(resolveActor('ou_jt', ops), 'BD');
});

test('with operators configured but an unknown open_id, the value comes back unchanged -- it lands on no allow list, so the permission is refused and it never impersonates M', () => {
  const ops = { ou_m: 'M' };
  assert.equal(resolveActor('ou_stranger', ops), 'ou_stranger');
  assert.equal(resolveActor(undefined, ops), 'unknown'); // configured but with no open_id -> no privilege is granted
});
