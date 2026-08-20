// 单测：gateA 文档幂等去重锚点（retry/孤儿复位重跑不重复追加机器评审段/同轮复评段）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { docHasSection, machineComment } from '../src/gates/gateA.ts';

const DIR = mkdtempSync(resolve(tmpdir(), 'forge-gatea-'));

test('machineComment：标题+严重度+建议+风险+路由；无问题→已澄清；复评带轮次', () => {
  const env = {
    summary: '财务后台退款',
    open_questions: [
      { q: '退款是否走原路', suggestion: '原路退回', severity: 'high' },
      { q: '是否支持部分退', suggestion: '', severity: 'med' },
    ],
    risks: [{ area: 'pay', detail: '幂等键缺失', evidence: '' }],
  };
  const routing = { reviewer: 'M', reviewerLogin: 'alice-lead', toLead: true, reasons: ['敏感域 pay'], confidence: 0.6 };
  const c = machineComment(env as never, routing as never, 1);
  assert.match(c, /【Forge 闸A 评审】/);
  assert.match(c, /〔高〕退款是否走原路/);
  assert.match(c, /建议：原路退回/);
  assert.match(c, /风险（1）/);
  assert.match(c, /需 M 把关/);
  const c2 = machineComment({ summary: '', open_questions: [], risks: [] } as never, routing as never, 3);
  assert.match(c2, /复评第 3 轮/);
  assert.match(c2, /已澄清/);
});

test('docHasSection：不存在文件 → false', () => {
  assert.equal(docHasSection(resolve(DIR, 'nope.md'), '🤖 机器评审产出'), false);
});

test('docHasSection：含/不含锚点正确判定', () => {
  const p = resolve(DIR, 'req-review.md');
  writeFileSync(p, '# 评审\n\n## 🤖 机器评审产出（待人工核对）\n内容\n');
  assert.equal(docHasSection(p, '🤖 机器评审产出'), true); // 机器段已存在 → 跳过追加
  assert.equal(docHasSection(p, '第 2 轮复评'), false); // 第 2 轮还没写 → 可追加
  writeFileSync(p, '## 🔁 第 2 轮复评（仍有 1 条待 PM 拍板）\n');
  assert.equal(docHasSection(p, '第 2 轮复评'), true);
});
