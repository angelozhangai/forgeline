// Unit tests: gateA's idempotent document anchors (a retry or orphan recovery re-running must not append the
// machine review section, or the same round's re-review section, twice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { docHasSection, machineComment } from '../src/gates/gateA.ts';

const DIR = mkdtempSync(resolve(tmpdir(), 'forge-gatea-'));

test('machineComment: title + severity + suggestion + risks + routing; no questions -> "everything is clarified"; a re-review carries its round', () => {
  const env = {
    summary: 'Finance back-office refunds',
    open_questions: [
      { q: 'Does the refund go back the original route', suggestion: 'refund via the original route', severity: 'high' },
      { q: 'Are partial refunds supported', suggestion: '', severity: 'med' },
    ],
    risks: [{ area: 'pay', detail: 'no idempotency key', evidence: '' }],
  };
  const routing = { reviewer: 'M', reviewerLogin: 'alice-lead', toLead: true, reasons: ['sensitive area pay'], confidence: 0.6 };
  const c = machineComment(env as never, routing as never, 1);
  assert.match(c, /\[Forge Gate A review\]/);
  assert.match(c, /\[high\] Does the refund go back the original route/);
  assert.match(c, /Suggestion: refund via the original route/);
  assert.match(c, /Risks \(1\)/);
  assert.match(c, /needs sign-off from M/);
  const c2 = machineComment({ summary: '', open_questions: [], risks: [] } as never, routing as never, 3);
  assert.match(c2, /re-review round 3/);
  assert.match(c2, /everything is clarified/);
});

test('docHasSection: a file that does not exist -> false', () => {
  assert.equal(docHasSection(resolve(DIR, 'nope.md'), '🤖 Machine review output'), false);
});

test('docHasSection: correctly decides whether the anchor is present', () => {
  const p = resolve(DIR, 'req-review.md');
  writeFileSync(p, '# Review\n\n## 🤖 Machine review output (pending human check)\ncontent\n');
  assert.equal(docHasSection(p, '🤖 Machine review output'), true); // the machine section already exists -> skip appending
  assert.equal(docHasSection(p, 'Re-review round 2'), false); // round 2 has not been written yet -> it can be appended
  writeFileSync(p, '## 🔁 Re-review round 2 (1 still awaiting the PM)\n');
  assert.equal(docHasSection(p, 'Re-review round 2'), true);
});
