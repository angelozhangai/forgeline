// readModel: parsing the read model out of a session's JSON text columns. What it mainly guards is that broken
// or missing JSON never throws and returns an empty skeleton or null - these are the display layer's read paths
// (the cards and the CLI), and one bad row must never take down notify or show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routingOf, parseDims, readResidual, readGateBResidual, residualCount } from '../src/store/readModel.ts';
import type { Session } from '../src/types.ts';

const sess = (p: Partial<Session>): Session => ({ routing: null, ...p } as unknown as Session);

test('routingOf: valid JSON parses; missing or broken -> null (it never throws)', () => {
  assert.deepEqual(routingOf(sess({ routing: '{"toLead":true,"reviewer":"M"}' })), { toLead: true, reviewer: 'M' });
  assert.equal(routingOf(sess({ routing: null })), null);
  assert.equal(routingOf(sess({ routing: 'broken JSON {{{' })), null);
});

test('parseDims: valid parses; missing or broken -> null', () => {
  assert.deepEqual(parseDims('{"clarity":20,"completeness":15,"feasibility":10,"testability":5}'), {
    clarity: 20, completeness: 15, feasibility: 10, testability: 5,
  });
  assert.equal(parseDims(null), null);
  assert.equal(parseDims('nope'), null);
});

test('readResidual: parses round / source / open_questions / findings, defaults the missing fields, and falls back to an empty skeleton when broken', () => {
  const r = readResidual('{"round":3,"source":"codex","findings":[{"issue":"the boundary case is not covered"}]}');
  assert.equal(r.round, 3);
  assert.equal(r.source, 'codex');
  assert.deepEqual(r.open_questions, []); // missing -> []
  assert.equal(r.findings.length, 1);
  // broken or missing -> a fully empty skeleton
  assert.deepEqual(readResidual(null), { round: 0, open_questions: [], findings: [] });
  assert.deepEqual(readResidual('{{{broken'), { round: 0, open_questions: [], findings: [] });
  // findings that is not an array -> falls back to []
  assert.deepEqual(readResidual('{"round":1,"findings":"x"}').findings, []);
});

test('readGateBResidual + residualCount: parsing and counting; broken or missing -> 0', () => {
  const json = '{"round":2,"used":"codex","findings":[{"issue":"a"},{"issue":"b","evidence":"repo:1"}]}';
  const r = readGateBResidual(json);
  assert.equal(r.round, 2);
  assert.equal(r.used, 'codex');
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[1].evidence, 'repo:1');
  assert.equal(residualCount(json), 2);
  assert.equal(residualCount(null), 0);
  assert.equal(residualCount('broken JSON'), 0);
  assert.deepEqual(readGateBResidual(null), { round: 0, used: '', findings: [] });
});
