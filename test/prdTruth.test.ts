// Unit tests: buildPrdTruth, the pure function that synthesises the PRD source of truth mechanically
// (source text + the Gate A review final draft + the PM confirmations -> a single markdown document).
// It is pure, does no IO and reads no clock, so the assertions are snapshot-shaped: structure + interpolation
// + the edge cases (empty source text, empty notes, and open_questions being empty after the review closed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrdTruth, loadPrdTruth } from '../src/gates/prdTruth.ts';
import { GateASchema } from '../src/gates/envelopes.ts';
import type { GateAEnvelope } from '../src/gates/envelopes.ts';
import type { Session } from '../src/types.ts';

function env(over: Partial<GateAEnvelope> = {}): GateAEnvelope {
  return GateASchema.parse({
    summary: 'add a store-credit channel to refunds',
    repos_touched: ['demo', 'example-web'],
    size: 'M',
    size_reason: 'spans two repos but needs no DB migration',
    open_questions: [],
    risks: [{ area: 'billing', detail: 'store credit and the original route coexist, so they must reconcile', evidence: 'demo src/pay.ts:42' }],
    confidence: 0.8,
    ...over,
  });
}

test('buildPrdTruth: all three sections present + the key content interpolated + open_questions marked clarified once closed', () => {
  const md = buildPrdTruth('users must be able to get a refund as store credit', env(), 'H1: refund as store credit\nM note: only store credit this cycle');
  // The three-section structure
  assert.match(md, /# PRD source of truth \(reviewed over several rounds\)/);
  assert.match(md, /## 1\. PRD source text/);
  assert.match(md, /## 2\. Gate A review, final draft/);
  assert.match(md, /## 3\. PM confirmations/);
  // Interpolation
  assert.match(md, /users must be able to get a refund as store credit/); // the PRD source text
  assert.match(md, /add a store-credit channel to refunds/); // summary
  assert.match(md, /demo \/ example-web/); // repos_touched
  assert.match(md, /spans two repos but needs no DB migration/); // size_reason
  assert.match(md, /\[billing\] store credit and the original route coexist, so they must reconcile \(evidence: demo src\/pay\.ts:42\)/); // a risk carrying its evidence
  assert.match(md, /H1: refund as store credit/); // confirmed_notes
  assert.match(md, /M note: only store credit this cycle/);
  // No open questions once the review closed
  assert.match(md, /everything is clarified/);
});

test('buildPrdTruth: residual open_questions (an M forced the gate open) are listed one by one, with severity and leaning', () => {
  const md = buildPrdTruth(
    'prd',
    env({ open_questions: [{ q: 'how long is the refund window?', suggestion: '7 days', severity: 'high', options: [] }] }),
    'M forced it open',
  );
  assert.match(md, /1\. \[high\] how long is the refund window\?/);
  assert.match(md, /Leaning: 7 days/);
  assert.doesNotMatch(md, /everything is clarified/); // there is residue -> it must not claim everything is clarified
});

test('buildPrdTruth: empty source text / empty notes -> placeholder copy, and no section is dropped', () => {
  const md = buildPrdTruth('   ', env({ risks: [] }), '');
  assert.match(md, /\(no PRD body was provided\)/);
  assert.match(md, /\(no additional notes\)/);
  assert.match(md, /### Risks \/ conflicts\n- \(none\)/); // no risks -> (none)
});

test('buildPrdTruth: deterministic and reproducible (the same input twice is byte-identical; no clock, no randomness)', () => {
  const a = buildPrdTruth('prd', env(), 'notes');
  const b = buildPrdTruth('prd', env(), 'notes');
  assert.equal(a, b);
});

// The source of this repository is English, but the requirement documents it processes are data and may be
// written in any language. This pins that: non-English PRD text, summaries, risks and PM notes must survive
// synthesis byte-for-byte. The fixtures are built from code points rather than written as literal characters
// so that this file itself stays within the English-only rule (see test/english-only.test.ts).
test('buildPrdTruth: non-English requirement input passes through untouched (source is English, input is not)', () => {
  const prd = String.fromCodePoint(0x9000, 0x6b3e, 0x8981, 0x80fd, 0x9000, 0x5230, 0x4f59, 0x989d); // a Chinese requirement sentence
  const summary = String.fromCodePoint(0x4f59, 0x989d, 0x9000, 0x6b3e);
  const notes = String.fromCodePoint(0x53ea, 0x505a, 0x4f59, 0x989d);
  const md = buildPrdTruth(prd, env({ summary, risks: [] }), notes);
  assert.ok(md.includes(prd), 'the PRD source text must be carried through verbatim');
  assert.ok(md.includes(summary), 'the Gate A summary must be carried through verbatim');
  assert.ok(md.includes(notes), 'the PM confirmations must be carried through verbatim');
});

test('loadPrdTruth: the sealed document is missing -> synthesise from the session\'s three sources on the spot (Gate B never gets an empty requirement)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-prdtruth-'));
  const gaPath = join(dir, 'gate-a.json');
  const prdPath = join(dir, 'prd.txt');
  writeFileSync(gaPath, JSON.stringify(GateASchema.parse({ summary: 'refund as store credit', repos_touched: ['demo'], size: 'S' })));
  writeFileSync(prdPath, 'refunds must be payable as store credit');
  // A unique slug -> <deliveryDir>/<slug> does not exist -> loadPrdTruth writes nothing but still returns the
  // freshly synthesised content.
  const s = {
    slug: `prdtruth-unit-${process.pid}-${gaPath.length}`,
    prd_text_path: prdPath,
    gate_a_output_path: gaPath,
    confirmed_notes: 'H1: refund as store credit',
  } as unknown as Session;
  const md = loadPrdTruth(s);
  assert.match(md, /refunds must be payable as store credit/); // the PRD source text (read from prd_text_path)
  assert.match(md, /refund as store credit/); // summary (read from gate-a.json)
  assert.match(md, /H1: refund as store credit/); // confirmed_notes
});

test('loadPrdTruth: the Gate A envelope path exists but the JSON is broken (truncated or written badly) -> throw explicitly, never silently degrade to an empty shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-prdtruth-bad-'));
  const gaPath = join(dir, 'gate-a.json');
  writeFileSync(gaPath, '{"summary": "x", "repos_'); // truncated, broken JSON
  const s = {
    slug: `prdtruth-bad-${process.pid}-${gaPath.length}`,
    gate_a_output_path: gaPath,
    confirmed_notes: '',
  } as unknown as Session;
  assert.throws(() => loadPrdTruth(s), /Gate A envelope.*(failed to parse as JSON|could not be read|off-contract)/);
});

test('loadPrdTruth: the Gate A envelope is off-contract (type drift after a migration) -> throw explicitly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-prdtruth-schema-'));
  const gaPath = join(dir, 'gate-a.json');
  writeFileSync(gaPath, JSON.stringify({ summary: 'x', repos_touched: 'demo' })); // repos_touched should be an array
  const s = {
    slug: `prdtruth-schema-${process.pid}-${gaPath.length}`,
    gate_a_output_path: gaPath,
    confirmed_notes: '',
  } as unknown as Session;
  assert.throws(() => loadPrdTruth(s), /off-contract/);
});

test('loadPrdTruth: an old session with no gate_a_output_path -> legacy fallback (the PRD text and PM confirmations still carry it; no throw)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-prdtruth-legacy-'));
  const prdPath = join(dir, 'prd.txt');
  writeFileSync(prdPath, 'the old requirement text');
  const s = {
    slug: `prdtruth-legacy-${process.pid}-${prdPath.length}`,
    prd_text_path: prdPath,
    gate_a_output_path: null,
    confirmed_notes: 'PM: do it this way',
  } as unknown as Session;
  const md = loadPrdTruth(s); // does not throw
  assert.match(md, /the old requirement text/);
  assert.match(md, /PM: do it this way/);
});
