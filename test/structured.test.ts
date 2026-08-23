// The self-healing parse kernel: a parse failure -> feed back for a re-emit -> parse again; throw once
// exhausted; a failed feedback call (null) backs off and retries a bounded number of times inside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseStructured, strictParse, formatZodError } from '../src/llm/structured.ts';

const Schema = z.object({ ok: z.boolean(), n: z.number() });

test('strictParse: extract + validate, returning the output type on success', () => {
  assert.deepEqual(strictParse(Schema, '```json\n{"ok":true,"n":3}\n```'), { ok: true, n: 3 });
});

test('strictParse: not matching the contract -> throws a readable error', () => {
  assert.throws(() => strictParse(Schema, '{"ok":"yes"}'), /contract/);
});

test('parseStructured: good on the first try -> no feedback round', async () => {
  let reEmits = 0;
  const out = await parseStructured<{ ok: boolean; n: number }>({
    text: '{"ok":true,"n":1}',
    parse: (t) => strictParse(Schema, t),
    reEmit: async () => { reEmits++; return null; },
    buildRepairInstruction: () => 'fix it',
    maxRetries: 2,
  });
  assert.deepEqual(out, { ok: true, n: 1 });
  assert.equal(reEmits, 0);
});

test('parseStructured: bad once -> feed back for a re-emit -> good (self-healing works, and an event is recorded)', async () => {
  const events: string[] = [];
  let calls = 0;
  const out = await parseStructured<{ ok: boolean; n: number }>({
    text: 'bad json {{{',
    parse: (t) => strictParse(Schema, t),
    reEmit: async (instr) => {
      calls++;
      assert.match(instr, /fix:/); // the repair instruction came through
      return '{"ok":true,"n":7}';
    },
    buildRepairInstruction: (err) => `fix: ${err}`,
    maxRetries: 2,
    note: (k) => events.push(k),
  });
  assert.deepEqual(out, { ok: true, n: 7 });
  assert.equal(calls, 1);
  assert.ok(events.includes('parse_repair_attempt'));
});

test('parseStructured: still bad once exhausted -> throws, records an exhausted event, and dumps every feedback round', async () => {
  const events: string[] = [];
  const dumps: string[] = [];
  await assert.rejects(
    () => parseStructured({
      text: 'bad0',
      parse: (t) => strictParse(Schema, t),
      reEmit: async () => 'still bad',
      buildRepairInstruction: () => 'fix',
      maxRetries: 2,
      note: (k) => events.push(k),
      dump: (raw) => dumps.push(raw),
    }),
  );
  assert.equal(events.filter((k) => k === 'parse_repair_attempt').length, 2);
  assert.ok(events.includes('parse_repair_exhausted'));
  assert.equal(dumps.length, 2); // both feedback rounds were dumped
});

test('parseStructured: reEmit failing continuously (null) -> throws after the bounded inner retries (it does not push forever)', async () => {
  const events: string[] = [];
  let calls = 0;
  await assert.rejects(
    () => parseStructured({
      text: 'bad',
      parse: (t) => strictParse(Schema, t),
      reEmit: async () => { calls++; return null; },
      buildRepairInstruction: () => 'fix',
      maxRetries: 3,
      reEmitCallRetries: 2,
      sleep: async () => {}, // do not really sleep
      note: (k) => events.push(k),
    }),
  );
  // Within a single parse attempt, callRetries+1 = 3 feedback calls all returned null -> no_reemit throws,
  // without consuming maxRetries.
  assert.equal(calls, 3);
  assert.equal(events.filter((k) => k === 'parse_repair_reemit_failed').length, 3);
  assert.ok(events.includes('parse_repair_no_reemit'));
  assert.equal(events.filter((k) => k === 'parse_repair_attempt').length, 1);
});

test('parseStructured: a feedback call that fails transiently (null) and then succeeds -> the self-healing is not ended by one blip (P1-1)', async () => {
  const events: string[] = [];
  let calls = 0;
  const out = await parseStructured<{ ok: boolean; n: number }>({
    text: 'bad json {{{',
    parse: (t) => strictParse(Schema, t),
    reEmit: async () => {
      calls++;
      if (calls === 1) return null; // the first feedback call fails transiently (timeout / rate limit)
      return '{"ok":true,"n":9}'; // the retry after the backoff succeeds
    },
    buildRepairInstruction: () => 'fix',
    maxRetries: 2,
    reEmitCallRetries: 2,
    sleep: async () => {},
    note: (k) => events.push(k),
  });
  assert.deepEqual(out, { ok: true, n: 9 });
  assert.equal(calls, 2); // one failure plus one success
  assert.ok(events.includes('parse_repair_reemit_failed'));
});

test('formatZodError: flattens the issues into one line', () => {
  const r = Schema.safeParse({ ok: 1 });
  assert.equal(r.success, false);
  if (!r.success) assert.match(formatZodError(r.error), /ok|n/);
});
