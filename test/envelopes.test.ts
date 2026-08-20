import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GateASchema,
  GateBSchema,
  VerdictSchema,
  askId,
  parseHumanAsks,
  parseOpenQuestions,
  humanAsksToDecisions,
  answerableDecisions,
  composeDecisionAnswer,
} from '../src/gates/envelopes.ts';

// LLM 输出契约：缺字段要有安全默认（绝不因模型少给字段而崩），必填缺失要报错。
test('GateASchema：空对象 → 安全默认', () => {
  const e = GateASchema.parse({});
  assert.deepEqual(e.repos_touched, []);
  assert.deepEqual(e.open_questions, []);
  assert.equal(e.confidence, 0);
  assert.equal(e.needs_lead, false);
});

test('GateASchema：PRD 评分缺省 → 0 分 + 维度全 0 + 空理由', () => {
  const e = GateASchema.parse({});
  assert.equal(e.prd_score, 0);
  assert.deepEqual(e.prd_score_dims, { clarity: 0, completeness: 0, feasibility: 0, testability: 0 });
  assert.equal(e.prd_score_reason, '');
});

test('GateASchema：PRD 评分透传（宽松，不卡边界，收敛留给 normScore）', () => {
  const e = GateASchema.parse({
    prd_score: 72,
    prd_score_dims: { clarity: 18, completeness: 15, feasibility: 22, testability: 17 },
    prd_score_reason: '验收标准缺失',
  });
  assert.equal(e.prd_score, 72);
  assert.equal(e.prd_score_dims.completeness, 15);
  assert.equal(e.prd_score_reason, '验收标准缺失');
});

test('GateASchema：open_question 缺 severity → 默认 med', () => {
  const e = GateASchema.parse({ open_questions: [{ q: '问题' }] });
  assert.equal(e.open_questions[0].severity, 'med');
  assert.equal(e.open_questions[0].suggestion, '');
});

test('GateBSchema：默认 multi_repo=false、issue_specs=[]、acceptance 空', () => {
  const e = GateBSchema.parse({ summary: 'x' });
  assert.equal(e.multi_repo, false);
  assert.deepEqual(e.issue_specs, []);
  assert.deepEqual(e.key_decisions, {});
  assert.deepEqual(e.acceptance, { contracts: [], scenarios: [] });
});

test('GateBSchema：acceptance 透传 + 场景缺 id/repo 有默认', () => {
  const e = GateBSchema.parse({
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /api/v1/pay/refund → 200|409' }],
      scenarios: [{ gherkin: 'Given a\nWhen b\nThen c' }],
    },
  });
  assert.equal(e.acceptance.contracts[0].surface.includes('refund'), true);
  assert.equal(e.acceptance.scenarios[0].gherkin.includes('Given'), true);
  assert.equal(e.acceptance.scenarios[0].id, ''); // 缺 id → 默认空
  assert.equal(e.acceptance.scenarios[0].repo, ''); // 缺 repo → 默认空（通用）
});

test('GateBSchema：issue_spec 必须有 repo+title，缺则报错', () => {
  assert.throws(() => GateBSchema.parse({ issue_specs: [{ title: '无 repo' }] }));
  const ok = GateBSchema.parse({ issue_specs: [{ repo: 'A', title: 't' }] });
  assert.equal(ok.issue_specs[0].type, 'feat'); // 默认
  assert.equal(ok.issue_specs[0].prio, 'P2');
});

test('VerdictSchema：LGTM/CHANGES_REQUESTED + 兼容旧值归一 + verdict 必填', () => {
  // 缺 verdict → 不再默认放行，报错（交自愈重问）。
  assert.throws(() => VerdictSchema.parse({}));
  // 正：LGTM（findings 空）/ CHANGES_REQUESTED（findings 非空）。
  assert.equal(VerdictSchema.parse({ verdict: 'LGTM' }).verdict, 'LGTM');
  assert.equal(VerdictSchema.parse({ verdict: 'LGTM', findings: [] }).verdict, 'LGTM');
  // 兼容旧值自动归一（大小写不敏感）。
  assert.equal(VerdictSchema.parse({ verdict: 'clean' }).verdict, 'LGTM');
  assert.equal(VerdictSchema.parse({ verdict: 'Clean' }).verdict, 'LGTM');
  assert.equal(VerdictSchema.parse({ verdict: 'needs_revision', findings: [{ issue: 'x' }] }).verdict, 'CHANGES_REQUESTED');
  // 未知值 → 报错（让自愈重问，绝不猜）。
  assert.throws(() => VerdictSchema.parse({ verdict: 'maybe' }));
});

test('VerdictSchema：verdict↔findings 一致性强制（矛盾→报错）', () => {
  assert.throws(() => VerdictSchema.parse({ verdict: 'LGTM', findings: [{ issue: 'x' }] }), /LGTM/);
  assert.throws(() => VerdictSchema.parse({ verdict: 'CHANGES_REQUESTED', findings: [] }));
  const v = VerdictSchema.parse({ verdict: 'CHANGES_REQUESTED', findings: [{ issue: 'x' }] });
  assert.equal(v.verdict, 'CHANGES_REQUESTED');
});

test('VerdictSchema：finding 缺 issue 报错，其余有默认', () => {
  assert.throws(() => VerdictSchema.parse({ verdict: 'CHANGES_REQUESTED', findings: [{ fix: 'x' }] }));
  const v = VerdictSchema.parse({ verdict: 'CHANGES_REQUESTED', findings: [{ issue: 'bug' }] });
  assert.equal(v.findings[0].severity, 'med');
});

test('askId：纯按位置 H{n}，不信 LLM 的 id（杜绝重复 id 串题）', () => {
  assert.equal(askId(0), 'H1');
  assert.equal(askId(2), 'H3');
});

// ── 决策卡原语（向后兼容 + render/compose 对齐）──
test('DecisionOption：旧 string[] 选项 → 归一为 {label,recommended,impact}（护住飞行中 session）', () => {
  const asks = parseHumanAsks(JSON.stringify([{ id: 'H1', question: 'Q', options: ['原路', '余额'] }]));
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0].options[0], { label: '原路', recommended: false, impact: '' });
  assert.equal(asks[0].options[1].label, '余额');
});

test('open_questions.options：缺省 → []；parseOpenQuestions 归一旧稿（无 options 不崩）', () => {
  const e = GateASchema.parse({ open_questions: [{ q: 'x' }] });
  assert.deepEqual(e.open_questions[0].options, []);
  const oq = parseOpenQuestions(JSON.stringify({ open_questions: [{ q: 'y', options: ['A'] }] }));
  assert.equal(oq[0].options[0].label, 'A');
  assert.deepEqual(parseOpenQuestions('不是 json'), []); // 坏数据 → 空，不抛
});

test('answerableDecisions：跳过无选项项，但 id 仍按位置 H{n}（render/compose 同源 → 永不串题）', () => {
  const items = [
    { prompt: 'Q1', options: [{ label: 'a', recommended: false, impact: '' }], severity: 'med', hint: '' },
    { prompt: 'Q2-无选项', options: [], severity: 'med', hint: '' },
    { prompt: 'Q3', options: [{ label: 'b', recommended: true, impact: '' }], severity: 'med', hint: '' },
  ];
  const ans = answerableDecisions(items);
  assert.deepEqual(ans.map((a) => a.id), ['H1', 'H3']); // Q2 跳过，但不顶掉 Q3 的位置 id
  assert.equal(ans[1].item.prompt, 'Q3');
});

test('DECISION_CAP：第 6-8 条同样可作答（cap 与卡片展示一致，绝不「显示了却没下拉」）', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    prompt: `Q${i + 1}`,
    options: [{ label: 'a', recommended: false, impact: '' }],
    severity: 'med',
    hint: '',
  }));
  const ans = answerableDecisions(items);
  assert.equal(ans.length, 8); // 8 条全可作答（不是只前 5 条）
  assert.equal(ans[5].id, 'H6');
  assert.equal(ans[7].id, 'H8');
});

test('composeDecisionAnswer：逐条选中 + verdict=partial 前缀 + 全局补充；选「其他」/未选跳过', () => {
  const items = humanAsksToDecisions(
    parseHumanAsks(
      JSON.stringify([
        { id: 'H1', question: '退款去向？', options: ['原路', '余额'] },
        { id: 'H2', question: '接受风险？', options: ['接受', '不接受'] },
      ]),
    ),
  );
  const out = composeDecisionAnswer(items, { ask_H1: '余额', ask_H2: '__other__', notes: '加幂等单测' }, 'partial');
  assert.match(out, /部分采纳/);
  assert.match(out, /H1（退款去向？）：余额/);
  assert.doesNotMatch(out, /H2/); // 选「其他」→ 不当选项答复，靠补充
  assert.match(out, /补充：加幂等单测/);
  assert.equal(composeDecisionAnswer(items, {}), ''); // 全空 → 空串（交 submit 兜「再修一轮」）
});
