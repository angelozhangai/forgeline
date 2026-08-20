import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage } from '../src/gates/triage.ts';
import type { GateAEnvelope } from '../src/gates/envelopes.ts';

// 路由是闸A 的核心业务规则（routing.yaml: min_confidence=0.7, lead=M, sensitive_areas 含 pay/风控/migration）。
function env(p: Partial<GateAEnvelope>): GateAEnvelope {
  return { summary: '', repos_touched: ['A'], open_questions: [], risks: [], confidence: 0.9, needs_lead: false, ...p };
}

test('单仓 + 高置信 + 无敏感 + 不需lead → DRI 自评', () => {
  const r = triage(env({}));
  assert.equal(r.toLead, false);
  assert.equal(r.reviewer, 'engineer');
  assert.equal(r.reviewerLogin, null);
});

test('跨仓 → 升级 M', () => {
  const r = triage(env({ repos_touched: ['C', 'U'] }));
  assert.equal(r.toLead, true);
  assert.equal(r.reviewer, 'M');
  assert.equal(r.reviewerLogin, 'alice-lead');
  assert.ok(r.reasons.some((x) => x.includes('跨仓')));
});

test('命中敏感域(pay) → 升级 M', () => {
  const r = triage(env({ risks: [{ area: 'pay', detail: 'x', evidence: 'a:1' }] }));
  assert.equal(r.toLead, true);
  assert.ok(r.reasons.some((x) => x.includes('敏感域')));
});

test('敏感域大小写/子串匹配(DB-Migration)', () => {
  const r = triage(env({ risks: [{ area: 'DB-Migration', detail: 'x', evidence: 'a:1' }] }));
  assert.equal(r.toLead, true);
});

test('低置信(<0.7) → 升级 M', () => {
  const r = triage(env({ confidence: 0.5 }));
  assert.equal(r.toLead, true);
  assert.ok(r.reasons.some((x) => x.includes('低置信')));
});

test('置信恰好阈值 0.7 → 不算低置信', () => {
  const r = triage(env({ confidence: 0.7 }));
  assert.equal(r.toLead, false);
});

test('needs_lead=true → 升级 M', () => {
  const r = triage(env({ needs_lead: true }));
  assert.equal(r.toLead, true);
  assert.ok(r.reasons.some((x) => x.includes('模型建议升级')));
});

test('多条理由叠加', () => {
  const r = triage(env({ repos_touched: ['C', 'U'], confidence: 0.3, needs_lead: true }));
  assert.equal(r.toLead, true);
  assert.ok(r.reasons.length >= 3);
});
