// readModel：Session JSON 文本列的读模型解析。重点守「坏/缺 JSON 不抛、返回空骨架/null」——
// 这些是展示层（卡片/CLI）读取路径，绝不能因一条脏数据让 notify/show 崩掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routingOf, parseDims, readResidual, readGateBResidual, residualCount } from '../src/store/readModel.ts';
import type { Session } from '../src/types.ts';

const sess = (p: Partial<Session>): Session => ({ routing: null, ...p } as unknown as Session);

test('routingOf：合法 JSON → 解析；缺/坏 → null（不抛）', () => {
  assert.deepEqual(routingOf(sess({ routing: '{"toLead":true,"reviewer":"M"}' })), { toLead: true, reviewer: 'M' });
  assert.equal(routingOf(sess({ routing: null })), null);
  assert.equal(routingOf(sess({ routing: '坏 JSON {{{' })), null);
});

test('parseDims：合法 → 解析；缺/坏 → null', () => {
  assert.deepEqual(parseDims('{"clarity":20,"completeness":15,"feasibility":10,"testability":5}'), {
    clarity: 20, completeness: 15, feasibility: 10, testability: 5,
  });
  assert.equal(parseDims(null), null);
  assert.equal(parseDims('nope'), null);
});

test('readResidual：解析 round/source/open_questions/findings；缺字段补默认；坏 → 空骨架', () => {
  const r = readResidual('{"round":3,"source":"codex","findings":[{"issue":"漏边界"}]}');
  assert.equal(r.round, 3);
  assert.equal(r.source, 'codex');
  assert.deepEqual(r.open_questions, []); // 缺 → []
  assert.equal(r.findings.length, 1);
  // 坏/缺 → 全空骨架
  assert.deepEqual(readResidual(null), { round: 0, open_questions: [], findings: [] });
  assert.deepEqual(readResidual('{{{坏'), { round: 0, open_questions: [], findings: [] });
  // findings 非数组 → 兜成 []
  assert.deepEqual(readResidual('{"round":1,"findings":"x"}').findings, []);
});

test('readGateBResidual + residualCount：解析 + 计数；坏/缺 → 0', () => {
  const json = '{"round":2,"used":"codex","findings":[{"issue":"a"},{"issue":"b","evidence":"repo:1"}]}';
  const r = readGateBResidual(json);
  assert.equal(r.round, 2);
  assert.equal(r.used, 'codex');
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[1].evidence, 'repo:1');
  assert.equal(residualCount(json), 2);
  assert.equal(residualCount(null), 0);
  assert.equal(residualCount('坏 JSON'), 0);
  assert.deepEqual(readGateBResidual(null), { round: 0, used: '', findings: [] });
});
