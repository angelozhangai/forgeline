// golden eval 的**纯逻辑**回归（进 ci，不花钱）：fixtures 不腐 + 期望比对 + 报告汇总正确。
// 真 claude 调用（evalGateA/runEval）刻意不在此测——那花钱，只手动 `forge eval` 跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures, checkGateA, checkGateB, missingRawFields, missingGateBFields, REQUIRED_GATE_A_FIELDS, REQUIRED_GATE_B_FIELDS, EvalExpectSchema } from '../src/eval/expectations.ts';
import { GateASchema, GateBSchema } from '../src/gates/envelopes.ts';

// 用 schema 造一份合法闸A产出，再按需覆盖字段。
function env(over: Record<string, unknown>) {
  return GateASchema.parse(over);
}

test('loadFixtures：真实 fixtures/eval 全部存在、输入非空、expect 合 schema（守 fixtures 不腐）', () => {
  const fxs = loadFixtures();
  assert.ok(fxs.length >= 2, `应至少有 2 个 golden fixture，实际 ${fxs.length}`);
  for (const fx of fxs) {
    assert.ok(fx.inputText.trim().length > 50, `${fx.name} 的输入（prd.md/prd-truth.md）不应为空`);
    assert.ok(['a', 'b'].includes(fx.gate), `${fx.name} gate 应为 a/b`);
    // EvalExpectSchema 是 strict——多余字段会在 loadFixtures 解析时抛，这里再确认结构可用。
    assert.doesNotThrow(() => EvalExpectSchema.parse(fx.expect));
  }
  // 至少有一条闸B fixture（#2 落地的保护网）
  assert.ok(fxs.some((f) => f.gate === 'b'), '应至少有一条闸B fixture');
});

test('harness 加固：每条闸B fixture 至少声明一项闸B 专属期望（防退化成「啥也不查」的假绿）', () => {
  // 闸B fixture 若只写 gate:b 却不声明任何 issue/acceptance/技术方案下限，eval 会「全过」却什么都没守。
  // 这条 ci 守门：gate:b 必须至少有一个闸B 专属断言（纯结构校验，不花钱）。
  const GATE_B_KEYS = ['issue_specs_min', 'issue_repos_include', 'acceptance_contracts_min', 'acceptance_scenarios_min', 'tech_design_min_chars', 'multi_repo', 'acceptance_judge'] as const;
  for (const fx of loadFixtures().filter((f) => f.gate === 'b')) {
    const has = GATE_B_KEYS.some((k) => (fx.expect as Record<string, unknown>)[k] !== undefined);
    assert.ok(has, `闸B fixture ${fx.name} 至少要声明一项闸B 专属期望（${GATE_B_KEYS.join('/')}）之一`);
  }
});

test('新增 data-export fixture：gate:a，size_in 排除 S + risks_min（扩 golden 到数据/隐私域）', () => {
  const fx = loadFixtures(undefined, 'data-export');
  assert.equal(fx.length, 1);
  assert.equal(fx[0].gate, 'a');
  const sizeIn = fx[0].expect.size_in ?? [];
  assert.ok(sizeIn.length > 0 && !sizeIn.includes('S'), '数据导出不应允许判 trivial S');
  assert.equal(fx[0].expect.risks_min, 1);
});

test('loadFixtures --only：只取指定 fixture', () => {
  const all = loadFixtures();
  const one = loadFixtures(undefined, all[0].name);
  assert.equal(one.length, 1);
  assert.equal(one[0].name, all[0].name);
  assert.equal(loadFixtures(undefined, '不存在的fixture').length, 0);
});

test('checkGateA：open_questions min/max + 主题命中', () => {
  const e = env({ open_questions: [{ q: '余额会过期吗？', suggestion: '建议不过期' }, { q: '退款怎么处理？' }] });
  const r = checkGateA(e, EvalExpectSchema.parse({ open_questions: { min: 2, max: 3, topics: ['过期', '退款'] } }));
  assert.equal(r.every((c) => c.pass), true, JSON.stringify(r));

  // min 不满足 → 失败
  const r2 = checkGateA(env({ open_questions: [{ q: '只有一个' }] }), EvalExpectSchema.parse({ open_questions: { min: 2 } }));
  assert.equal(r2.find((c) => c.name.includes('≥2'))?.pass, false);

  // 主题没命中 → 失败（命中查 q + suggestion 拼接）
  const r3 = checkGateA(env({ open_questions: [{ q: '无关问题' }] }), EvalExpectSchema.parse({ open_questions: { topics: ['过期'] } }));
  assert.equal(r3[0].pass, false);
  assert.match(r3[0].detail, /无 open_question 提及/);
});

test('checkGateA：size_in / risks_min / 区间', () => {
  const e = env({ size: 'L', risks: [{ area: '资金' }, { area: '并发' }], confidence: 0.6, prd_score: 72 });
  const x = EvalExpectSchema.parse({ size_in: ['M', 'L'], risks_min: 1, confidence_range: [0, 1], prd_score_range: [0, 100] });
  assert.equal(checkGateA(e, x).every((c) => c.pass), true);

  // size 不在集合 → 失败
  const rS = checkGateA(env({ size: 'XL' }), EvalExpectSchema.parse({ size_in: ['S', 'M'] }));
  assert.equal(rS[0].pass, false);
  assert.match(rS[0].detail, /实际 XL/);

  // 区间越界 → 失败
  const rR = checkGateA(env({ confidence: 1.5 }), EvalExpectSchema.parse({ confidence_range: [0, 1] }));
  assert.equal(rR[0].pass, false);
});

test('checkGateA：未声明的期望项不产生检查（只查写了的）', () => {
  const r = checkGateA(env({ open_questions: [{ q: 'x' }] }), EvalExpectSchema.parse({})); // 空期望
  assert.equal(r.length, 0);
});

test('missingRawFields：原始形状合约挡住「退化产出」（在 zod 注入默认值之前）', () => {
  // {} → 全缺（最重回归：模型啥维度都没产出，但生产 schema 会默认补全）
  assert.deepEqual(missingRawFields({}).sort(), [...REQUIRED_GATE_A_FIELDS].sort());
  // 完整形状基线：顶层 11 字段 + prd_score_dims 四维都显式产出 → 不缺。
  const full = {
    summary: 's', repos_touched: ['C'], size: 'M', size_reason: 'r', open_questions: [], risks: [],
    confidence: 0.5, needs_lead: false, prd_score: 70,
    prd_score_dims: { clarity: 18, completeness: 16, feasibility: 19, testability: 17 }, prd_score_reason: 'x',
  };
  assert.deepEqual(missingRawFields(full), []);
  // 漏 prd_score / confidence → 精确点名（codex 关注的「不再打分」）
  const { prd_score, confidence, ...lack } = full;
  assert.deepEqual(missingRawFields(lack).sort(), ['confidence', 'prd_score']);
  // 漏 needs_lead / repos_touched → 点名（喂 triage 升级路由，不能少）
  const { needs_lead, ...noLead } = full;
  assert.deepEqual(missingRawFields(noLead), ['needs_lead']);
  const { repos_touched, ...noRepos } = full;
  assert.deepEqual(missingRawFields(noRepos), ['repos_touched']);
  // prd_score_dims 只给空对象 → 顶层在、但四维全缺，精确点名四个子维度（「光有壳不算打分」）
  assert.deepEqual(missingRawFields({ ...full, prd_score_dims: {} }).sort(), ['prd_score_dims.clarity', 'prd_score_dims.completeness', 'prd_score_dims.feasibility', 'prd_score_dims.testability'].sort());
  // prd_score_dims 缺一维 → 只点名那一维
  assert.deepEqual(missingRawFields({ ...full, prd_score_dims: { clarity: 1, completeness: 1, feasibility: 1 } }), ['prd_score_dims.testability']);
  // prd_score_dims 存在但非对象（坏形状）→ 四维都点名
  assert.deepEqual(missingRawFields({ ...full, prd_score_dims: [] }).sort(), ['prd_score_dims.clarity', 'prd_score_dims.completeness', 'prd_score_dims.feasibility', 'prd_score_dims.testability'].sort());
  // 显式 null 也算缺（present 但没真打分）
  assert.deepEqual(missingRawFields({ ...full, prd_score: null }), ['prd_score']);
  // 空数组 / 0 分是合法值（维度产出了，只是为空/低）——不算缺
  assert.deepEqual(missingRawFields({ ...full, open_questions: [], repos_touched: [], prd_score: 0 }), []);
  // {} → 顶层 11 全缺（prd_score_dims 缺则不重复点名子维度）
  assert.deepEqual(missingRawFields({}).sort(), [...REQUIRED_GATE_A_FIELDS].sort());
  // 非对象（数组 / null / 字符串）→ 全缺（顶层）
  assert.equal(missingRawFields([]).length, REQUIRED_GATE_A_FIELDS.length);
  assert.equal(missingRawFields(null).length, REQUIRED_GATE_A_FIELDS.length);
  assert.equal(missingRawFields('{}').length, REQUIRED_GATE_A_FIELDS.length);
});

// ── 闸B（#2）──
function envB(over: Record<string, unknown>) {
  return GateBSchema.parse(over);
}

test('missingGateBFields：闸B 形状合约 + acceptance 下钻 contracts/scenarios', () => {
  assert.deepEqual(missingGateBFields({}).sort(), [...REQUIRED_GATE_B_FIELDS].sort());
  const full = {
    summary: 's', key_decisions: { x: 1 }, tech_design_markdown: '## 设计…', acceptance: { contracts: [{ repo: 'C', surface: 'POST /x' }], scenarios: [{ id: 'AC1', gherkin: 'Given…' }] },
    multi_repo: true, issue_specs: [{ repo: 'C', title: 't' }], confidence: 0.7,
  };
  assert.deepEqual(missingGateBFields(full), []);
  // 漏 acceptance / issue_specs → 点名
  const { acceptance, ...noAcc } = full;
  assert.ok(missingGateBFields(noAcc).includes('acceptance'));
  // acceptance 空壳（缺 contracts/scenarios）→ 下钻点名（drift 对账基准不能空）
  assert.deepEqual(missingGateBFields({ ...full, acceptance: {} }).sort(), ['acceptance.contracts', 'acceptance.scenarios'].sort());
  // acceptance 非对象 → 两个子键都点名
  assert.deepEqual(missingGateBFields({ ...full, acceptance: [] }).sort(), ['acceptance.contracts', 'acceptance.scenarios'].sort());
});

test('checkGateB：issue/contracts/scenarios 下限 + multi_repo + 正文长度', () => {
  const e = envB({
    tech_design_markdown: 'x'.repeat(300),
    acceptance: { contracts: [{ repo: 'C', surface: 's' }], scenarios: [{ id: 'AC1' }, { id: 'AC2' }] },
    multi_repo: true, issue_specs: [{ repo: 'C', title: 't' }, { repo: 'U', title: 't2' }], confidence: 0.6,
  });
  const x = EvalExpectSchema.parse({ gate: 'b', issue_specs_min: 1, acceptance_contracts_min: 1, acceptance_scenarios_min: 2, tech_design_min_chars: 200, multi_repo: true, confidence_range: [0, 1] });
  assert.equal(checkGateB(e, x).every((c) => c.pass), true, JSON.stringify(checkGateB(e, x)));

  // 退化：0 issue / 空 acceptance / 短正文 / 单仓误判 → 各自失败
  const weak = envB({ tech_design_markdown: '短', acceptance: { contracts: [], scenarios: [] }, multi_repo: false, issue_specs: [] });
  const r = checkGateB(weak, x);
  assert.equal(r.find((c) => c.name.includes('issue_specs'))?.pass, false);
  assert.equal(r.find((c) => c.name.includes('contracts'))?.pass, false);
  assert.equal(r.find((c) => c.name.includes('scenarios'))?.pass, false);
  assert.equal(r.find((c) => c.name.includes('tech_design'))?.pass, false);
  assert.equal(r.find((c) => c.name.includes('multi_repo'))?.pass, false);
});

test('checkGateB：issue_repos_include 守真覆盖——两个 issue 都堆后端(C) 仍挡（multi_repo:true 也不行）', () => {
  const xr = EvalExpectSchema.parse({ gate: 'b', issue_specs_min: 2, multi_repo: true, issue_repos_include: ['C', 'U'] });
  // 退化：multi_repo=true + 2 个 issue，但都在 demo（前端 example-web 的活被丢了）
  const backendOnly = envB({ multi_repo: true, issue_specs: [{ repo: 'C', title: 'a' }, { repo: 'C', title: 'b' }] });
  const r1 = checkGateB(backendOnly, xr);
  assert.equal(r1.find((c) => c.name.includes('覆盖仓'))?.pass, false);
  assert.match(r1.find((c) => c.name.includes('覆盖仓'))!.detail, /缺 U/);
  // 数量 + multi_repo 这两条仍绿——正是它们挡不住的退化，靠 repo 覆盖兜住
  assert.equal(r1.find((c) => c.name.includes('issue_specs'))?.pass, true);
  assert.equal(r1.find((c) => c.name.includes('multi_repo'))?.pass, true);
  // 真覆盖 C+U → 过
  const both = envB({ multi_repo: true, issue_specs: [{ repo: 'C', title: 'a' }, { repo: 'U', title: 'b' }] });
  assert.equal(checkGateB(both, xr).every((c) => c.pass), true);
});

// summarize/formatReport/aggregate/diffRuns/store 的测试见 test/eval-aggregate.test.ts（多样本/趋势/落盘）。
