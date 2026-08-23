import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage } from '../src/gates/triage.ts';
import type { GateAEnvelope } from '../src/gates/envelopes.ts';

// Routing is Gate A's core business rule (routing.yaml: min_confidence=0.7, lead=M, sensitive_areas
// including pay / risk control / migration).
function env(p: Partial<GateAEnvelope>): GateAEnvelope {
  return { summary: '', repos_touched: ['A'], open_questions: [], risks: [], confidence: 0.9, needs_lead: false, ...p };
}

test('single repo + high confidence + nothing sensitive + no lead needed -> DRI self-review', () => {
  const r = triage(env({}));
  assert.equal(r.toLead, false);
  assert.equal(r.reviewer, 'engineer');
  assert.equal(r.reviewerLogin, null);
});

test('spans repos -> escalate to M', () => {
  const r = triage(env({ repos_touched: ['C', 'U'] }));
  assert.equal(r.toLead, true);
  assert.equal(r.reviewer, 'M');
  assert.equal(r.reviewerLogin, 'alice-lead');
  assert.ok(r.reasons.some((x) => x.includes('spans repos')));
});

test('hits a sensitive area (pay) -> escalate to M', () => {
  const r = triage(env({ risks: [{ area: 'pay', detail: 'x', evidence: 'a:1' }] }));
  assert.equal(r.toLead, true);
  assert.ok(r.reasons.some((x) => x.includes('sensitive area')));
});

test('sensitive area matching is case-insensitive and substring-based (DB-Migration)', () => {
  const r = triage(env({ risks: [{ area: 'DB-Migration', detail: 'x', evidence: 'a:1' }] }));
  assert.equal(r.toLead, true);
});

test('low confidence (<0.7) -> escalate to M', () => {
  const r = triage(env({ confidence: 0.5 }));
  assert.equal(r.toLead, true);
  assert.ok(r.reasons.some((x) => x.includes('low confidence')));
});

test('confidence exactly at the 0.7 threshold does not count as low', () => {
  const r = triage(env({ confidence: 0.7 }));
  assert.equal(r.toLead, false);
});

test('needs_lead=true -> escalate to M', () => {
  const r = triage(env({ needs_lead: true }));
  assert.equal(r.toLead, true);
  assert.ok(r.reasons.some((x) => x.includes('the model recommended escalation')));
});

test('several reasons stack up', () => {
  const r = triage(env({ repos_touched: ['C', 'U'], confidence: 0.3, needs_lead: true }));
  assert.equal(r.toLead, true);
  assert.ok(r.reasons.length >= 3);
});
