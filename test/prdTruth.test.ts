// 单测：PRD 真源机械合成纯函数 buildPrdTruth（原文 + 闸A 评审定稿 + PM 确认 → 单一 markdown）。
// 纯函数、无 IO、无时间量——快照式断言结构 + 插值 + 边界（空原文/空备注/收口后空 open_questions）。
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
    summary: '给退款加余额通道',
    repos_touched: ['demo', 'example-web'],
    size: 'M',
    size_reason: '跨两仓但无 DB 迁移',
    open_questions: [],
    risks: [{ area: '计费', detail: '余额与原路并存需对账', evidence: 'demo src/pay.ts:42' }],
    confidence: 0.8,
    ...over,
  });
}

test('buildPrdTruth：三段齐全 + 关键内容插值 + 收口后 open_questions 标已澄清', () => {
  const md = buildPrdTruth('用户要能退到余额', env(), 'H1：退到余额\nM 批注：本期只做余额');
  // 三段结构
  assert.match(md, /# PRD 真源（已多轮评审）/);
  assert.match(md, /## 一、PRD 原文/);
  assert.match(md, /## 二、闸A 评审定稿/);
  assert.match(md, /## 三、PM 确认定稿/);
  // 插值
  assert.match(md, /用户要能退到余额/); // PRD 原文
  assert.match(md, /给退款加余额通道/); // summary
  assert.match(md, /demo \/ example-web/); // repos_touched
  assert.match(md, /跨两仓但无 DB 迁移/); // size_reason
  assert.match(md, /\[计费\] 余额与原路并存需对账（证据：demo src\/pay\.ts:42）/); // risk 带证据
  assert.match(md, /H1：退到余额/); // confirmed_notes
  assert.match(md, /M 批注：本期只做余额/);
  // 收口后无开放问题
  assert.match(md, /已全部澄清/);
});

test('buildPrdTruth：残留 open_questions（M 强制放行）逐条列出，带严重度与倾向', () => {
  const md = buildPrdTruth(
    'prd',
    env({ open_questions: [{ q: '退款时限多久？', suggestion: '7 天', severity: 'high', options: [] }] }),
    'M 强制放行',
  );
  assert.match(md, /1\. \[high\] 退款时限多久？/);
  assert.match(md, /倾向：7 天/);
  assert.doesNotMatch(md, /已全部澄清/); // 有残留 → 不应显示已澄清
});

test('buildPrdTruth：空原文 / 空备注 → 占位文案，不漏段', () => {
  const md = buildPrdTruth('   ', env({ risks: [] }), '');
  assert.match(md, /（未提供 PRD 正文）/);
  assert.match(md, /（无额外备注）/);
  assert.match(md, /### 风险 \/ 冲突\n- （无）/); // 空 risks → （无）
});

test('buildPrdTruth：确定性可复现（同输入两次完全一致，无时间量/随机量）', () => {
  const a = buildPrdTruth('prd', env(), 'notes');
  const b = buildPrdTruth('prd', env(), 'notes');
  assert.equal(a, b);
});

test('loadPrdTruth：封口文档缺 → 从 session 三源即时合成兜底（闸B 永不拿空需求）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-prdtruth-'));
  const gaPath = join(dir, 'gate-a.json');
  const prdPath = join(dir, 'prd.txt');
  writeFileSync(gaPath, JSON.stringify(GateASchema.parse({ summary: '加余额退款', repos_touched: ['demo'], size: 'S' })));
  writeFileSync(prdPath, '退款要能退到余额');
  // 唯一 slug → 交付目录 <deliveryDir>/<slug> 不存在 → loadPrdTruth 不写盘，但仍返回即时合成内容。
  const s = {
    slug: `prdtruth-unit-${process.pid}-${gaPath.length}`,
    prd_text_path: prdPath,
    gate_a_output_path: gaPath,
    confirmed_notes: 'H1：退到余额',
  } as unknown as Session;
  const md = loadPrdTruth(s);
  assert.match(md, /退款要能退到余额/); // PRD 原文（读自 prd_text_path）
  assert.match(md, /加余额退款/); // summary（读自 gate-a.json）
  assert.match(md, /H1：退到余额/); // confirmed_notes
});

test('loadPrdTruth：闸A 信封路径在但 JSON 坏（截断/写坏）→ 显性抛错，绝不静默降级成空壳', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-prdtruth-bad-'));
  const gaPath = join(dir, 'gate-a.json');
  writeFileSync(gaPath, '{"summary": "x", "repos_'); // 截断的坏 JSON
  const s = {
    slug: `prdtruth-bad-${process.pid}-${gaPath.length}`,
    gate_a_output_path: gaPath,
    confirmed_notes: '',
  } as unknown as Session;
  assert.throws(() => loadPrdTruth(s), /闸A 信封.*(JSON 解析失败|读不出|不合约)/);
});

test('loadPrdTruth：闸A 信封不合约（迁移后类型漂移）→ 显性抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-prdtruth-schema-'));
  const gaPath = join(dir, 'gate-a.json');
  writeFileSync(gaPath, JSON.stringify({ summary: 'x', repos_touched: 'demo' })); // repos_touched 应是数组
  const s = {
    slug: `prdtruth-schema-${process.pid}-${gaPath.length}`,
    gate_a_output_path: gaPath,
    confirmed_notes: '',
  } as unknown as Session;
  assert.throws(() => loadPrdTruth(s), /不合约/);
});

test('loadPrdTruth：老 session 无 gate_a_output_path → legacy 兜底（PRD原文/PM确认仍承载，不抛）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-prdtruth-legacy-'));
  const prdPath = join(dir, 'prd.txt');
  writeFileSync(prdPath, '老需求原文');
  const s = {
    slug: `prdtruth-legacy-${process.pid}-${prdPath.length}`,
    prd_text_path: prdPath,
    gate_a_output_path: null,
    confirmed_notes: 'PM：就这么做',
  } as unknown as Session;
  const md = loadPrdTruth(s); // 不抛
  assert.match(md, /老需求原文/);
  assert.match(md, /PM：就这么做/);
});
