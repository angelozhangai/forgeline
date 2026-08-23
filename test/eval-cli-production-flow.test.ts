// Integration: the real entry point an operator uses to run the golden eval by hand from the CLI. The
// external claude is replaced by a temporary fake binary, so the tests cost nothing.
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

test('./forge eval --fixture with a name that does not exist: a non-zero exit, and no message suggesting a paid call', () => {
  const r = spawnSync(process.execPath, ['--no-warnings', 'src/index.ts', 'eval', '--fixture', 'definitely-not-a-fixture'], {
    cwd: repo,
    env: { ...process.env, FORGE_DB: resolve(tmpdir(), `forge-eval-cli-${process.pid}.db`) },
    encoding: 'utf8',
  });

  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /no such fixture: definitely-not-a-fixture/);
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /calling claude for real|reviewing each one for real/);
});

test('./forge eval through the real CLI: a cross-repo fixture missing its front-end issue turns red, and the judge cost, the call count and the first failing sample are all visible', () => {
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
    summary: 'the technical plan for topping up a wallet',
    key_decisions: { repos: ['C', 'U'], release_order: 'the back end first, then the front end' },
    tech_design_markdown: '## Design\\nthe balance account, the payment callback, the ledger, the wallet entry point and the top-up entry point in the shop.'.padEnd(260, '.'),
    acceptance: {
      contracts: [{ repo: 'C', surface: 'POST /api/v1/wallet/recharge {amount, idem_key} -> 200 {balance}' }],
      scenarios: [{ id: 'AC1', repo: 'C', gherkin: 'Given a balance of 0\\nWhen a top-up of 100 succeeds\\nThen the balance is 100 and a top-up entry appears in the ledger' }],
    },
    multi_repo: true,
    issue_specs: [{ repo: 'C', title: 'feat(wallet): the top-up back end' }, { repo: 'C', title: 'feat(wallet): the ledger back end' }],
    confidence: 0.8,
  };
  const goodGateB = {
    ...badGateB,
    issue_specs: [{ repo: 'C', title: 'feat(wallet): the top-up back end' }, { repo: 'U', title: 'feat(wallet): the top-up entry point and the wallet page' }],
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
  assert.equal(Number(readFileSync(state, 'utf8')), 4, 'one gate B fixture across two runs, each of which adds one acceptance-judge call');
  assert.match(r.stdout, /1 fixture\(s\) \(1 of them with an acceptance-judge, each costing one extra call\) x 2 run\(s\) = 4 claude calls/);
  assert.match(r.stdout, /✖ recharge-gateb/);
  assert.match(r.stdout, /\[1\/2 runs passed\]/);
  assert.match(r.stdout, /✖ the issues cover the repos \{C,U\} \(missing U \(actual C\)\)/);
  assert.match(r.stdout, /✔ issue_specs >= 2 \(actual 2\)/);
  assert.match(r.stdout, /✔ multi_repo=true \(actual true\)/);
  assert.match(r.stdout, /total cost \$1\.20/);
  assert.doesNotMatch(r.stdout, /written to disk:/);
  assert.equal(evalRunCount(), before, '--no-save should write nothing into logs/eval');
});
