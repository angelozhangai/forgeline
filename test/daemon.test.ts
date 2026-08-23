import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formValue } from '../src/messaging/feishu.ts'; // parsing the form moved into the adapter along with the inbound side

// Note: pulling a document link out of a sentence moved away with the document sources in Phase 1. listen now
// only calls claimDocs, recognising the link is docs/feishu.ts's job, and the tests for it live in
// docs-feishu.test.ts and docs-registry.test.ts.

// The card's form callback: digging verdict and notes out of the raw event, handling both raw.event.action
// and raw.action.
test('formValue: raw.event.action.form_value', () => {
  const evt = { raw: { event: { action: { form_value: { verdict: 'accept', notes: 'ok' } } } } };
  assert.deepEqual(formValue(evt), { verdict: 'accept', notes: 'ok' });
});

test('formValue: raw.action.form_value, with no event wrapper', () => {
  const evt = { raw: { action: { form_value: { verdict: 'deny' } } } };
  assert.deepEqual(formValue(evt), { verdict: 'deny' });
});

test('formValue: no form value gives an empty object rather than crashing', () => {
  assert.deepEqual(formValue({}), {});
  assert.deepEqual(formValue({ raw: {} }), {});
});
