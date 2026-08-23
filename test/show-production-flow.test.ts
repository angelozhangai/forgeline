// 集成：operator 用真实 CLI 查看待拍板项时，新旧选项形态都必须是可读业务语言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

process.env.FORGE_DB = resolve(tmpdir(), `forge-show-${process.pid}.db`);

const sessions = await import('../src/store/sessions.ts');

test('./forge show：闸B 待拍板项兼容旧 string[] 与新推荐/影响选项，不出现对象串', () => {
  const id = 'show-human-asks';
  sessions.create({ id, slug: id, title: '退款去向', branch: 'main' });
  sessions.patch(id, {
    gate_b_round: 2,
    gate_b_human_asks: JSON.stringify([
      { id: 'x', question: '退款退到哪里？', options: ['原路退回', '退到余额'], severity: 'high' },
      {
        id: 'dup',
        question: '是否接受到账延迟？',
        options: [
          { label: '接受延迟', recommended: true, impact: '对账最清晰' },
          { label: '加急到账', recommended: false, impact: '实现成本更高' },
        ],
        severity: 'med',
      },
    ]),
  });

  const text = execFileSync(process.execPath, ['--no-warnings', 'src/index.ts', 'show', id], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, FORGE_DB: process.env.FORGE_DB },
    encoding: 'utf8',
  });

  assert.match(text, /Gate B's revision escalated, waiting on the maintainer/);
  assert.match(text, /\u9000\u6b3e\u9000\u5230\u54ea\u91cc\uff1f \(options: \u539f\u8def\u9000\u56de \/ \u9000\u5230\u4f59\u989d\)/);
  assert.match(text, /\u662f\u5426\u63a5\u53d7\u5230\u8d26\u5ef6\u8fdf\uff1f \(options: \u2605\u63a5\u53d7\u5ef6\u8fdf \/ \u52a0\u6025\u5230\u8d26\)/);
  assert.doesNotMatch(text, /\[object Object\]/);
  assert.match(text, /forge gateb-answer show-human-asks/);
});

test('./forge show：operator 查看单条需求时，下游闸C/闸D成本必须进入可见总成本', () => {
  const id = 'show-downstream-cost';
  sessions.create({ id, slug: id, title: '下游实现成本可见', branch: 'main' });
  sessions.patch(id, {
    gate_a_cost_usd: 0,
    gate_b_cost_usd: 0,
    gate_c_cost_usd: 8.25,
    gate_d_cost_usd: 2.75,
  });

  const text = execFileSync(process.execPath, ['--no-warnings', 'src/index.ts', 'show', id], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, FORGE_DB: process.env.FORGE_DB },
    encoding: 'utf8',
  });

  assert.match(text, /state:\s+INTAKE/);
  assert.match(text, /cost:\s+\$11\.0000/);
  assert.doesNotMatch(text, /cost:\s+\$0\.0000/);
});

test('./forge cost：管理看板从真实库读取并展示闸C/闸D分项，避免下游烧钱被藏起来', () => {
  const id = 'cost-dashboard-downstream';
  sessions.create({ id, slug: id, title: '下游成本看板', branch: 'main' });
  sessions.patch(id, {
    gate_a_cost_usd: 1,
    gate_b_cost_usd: 2,
    gate_c_cost_usd: 8,
    gate_d_cost_usd: 4,
  });

  const text = execFileSync(process.execPath, ['--no-warnings', 'src/index.ts', 'cost'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, FORGE_DB: process.env.FORGE_DB },
    encoding: 'utf8',
  });

  assert.match(text, /REQ\s+STATE\s+GATE A\s+GATE B\s+GATE C\s+GATE D\s+TOTAL\s+SLUG/);
  assert.match(text, /cost-dashboard-downstream/);
  assert.match(text, /\$1\.0000\s+\$2\.0000\s+\$8\.0000\s+\$4\.0000\s+\$15\.0000/);
  assert.match(text, /Total .*Gate A .*Gate B .*Gate C .*Gate D /);
  assert.match(text, /private, management-facing/);
});
