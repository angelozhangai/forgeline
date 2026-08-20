// 集成：operator 从 CLI 手动跑 golden eval 的真实入口。外部 Claude 用临时 fake binary 代替，避免测试花钱。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');

function evalRunCount(): number {
  const dir = resolve(repo, 'logs', 'eval');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
}

test('./forge eval --fixture 不存在：非 0 退出，且不打印付费调用提示', () => {
  const r = spawnSync(process.execPath, ['--no-warnings', 'src/index.ts', 'eval', '--fixture', 'definitely-not-a-fixture'], {
    cwd: repo,
    env: { ...process.env, FORGE_DB: resolve(tmpdir(), `forge-eval-cli-${process.pid}.db`) },
    encoding: 'utf8',
  });

  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /找不到 fixture：definitely-not-a-fixture/);
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /真实调用 claude|逐个真评审/);
});

test('./forge eval 真实 CLI 链路：跨仓 fixture 缺前端 issue 会红，judge 成本/调用数/首个失败样本可见', () => {
  const binDir = mkdtempSync(join(tmpdir(), 'forge-fake-claude-'));
  const state = join(binDir, 'count.txt');
  const fakeClaude = join(binDir, 'claude');
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require('node:fs');
const state = process.env.FAKE_CLAUDE_STATE;
const n = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0;
fs.writeFileSync(state, String(n + 1));
let input = '';
process.stdin.on('data', (d) => { input += d.toString(); });
process.stdin.on('end', () => {
  const isJudge = input.includes('Acceptance under judgment');
  const badGateB = {
    summary: '钱包充值技术方案',
    key_decisions: { repos: ['C', 'U'], release_order: '后端先行 -> 前端' },
    tech_design_markdown: '## 方案\\n余额账户、支付回调、流水、钱包入口、商店充值入口。'.padEnd(260, '细'),
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /api/v1/wallet/recharge {amount, idem_key} -> 200 {balance}' }],
      scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given 余额为0\\nWhen 充值100元成功\\nThen 余额为100且流水出现一条充值记录' }],
    },
    multi_repo: true,
    issue_specs: [{ repo: 'C', title: 'feat(wallet): 充值后端' }, { repo: 'C', title: 'feat(wallet): 流水后端' }],
    confidence: 0.8,
  };
  const goodGateB = {
    ...badGateB,
    issue_specs: [{ repo: 'C', title: 'feat(wallet): 充值后端' }, { repo: 'U', title: 'feat(wallet): 充值入口和钱包页' }],
  };
  const judge = { coverage: 80, testability: 75, declarative: true, issues: [], verdict: 'good' };
  const payload = isJudge ? judge : (n === 0 ? badGateB : goodGateB);
  const fence = String.fromCharCode(96, 96, 96);
  const result = fence + 'json\\n' + JSON.stringify(payload) + '\\n' + fence;
  process.stdout.write(JSON.stringify({ type: 'result', result, session_id: 'fake-' + (n + 1), total_cost_usd: isJudge ? 0.1 : 0.5, is_error: false }) + '\\n');
});
`,
  );
  chmodSync(fakeClaude, 0o755);

  const before = evalRunCount();
  const r = spawnSync(process.execPath, ['--no-warnings', 'src/index.ts', 'eval', '--fixture', 'recharge-gateb', '--runs', '2', '--no-save'], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_CLAUDE_STATE: state,
      FORGE_DB: resolve(tmpdir(), `forge-eval-cli-real-${process.pid}.db`),
    },
    encoding: 'utf8',
  });

  assert.equal(r.status, 1, r.stderr);
  assert.equal(Number(readFileSync(state, 'utf8')), 4, '1 个闸B fixture × 2 runs，且每次多 1 发 acceptance judge');
  assert.match(r.stdout, /1 个 fixture（含 1 个带 acceptance-judge，各多一发） × 2 次 = 4 发 claude/);
  assert.match(r.stdout, /✖ recharge-gateb/);
  assert.match(r.stdout, /\[1\/2 次通过\]/);
  assert.match(r.stdout, /✖ issue 覆盖仓 \{C,U\}（缺 U（实际 C））/);
  assert.match(r.stdout, /✔ issue_specs≥2（实际 2）/);
  assert.match(r.stdout, /✔ multi_repo=true（实际 true）/);
  assert.match(r.stdout, /总成本 \$1\.20/);
  assert.doesNotMatch(r.stdout, /已落盘：/);
  assert.equal(evalRunCount(), before, '--no-save 不应写 logs/eval');
});
