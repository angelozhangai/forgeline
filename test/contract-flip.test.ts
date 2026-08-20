// Layer-3 翻转去抖 + 持久化 + contractCheck 聚合，确定性证明（无二进制、不花钱）。
process.env.FORGE_DB = ':memory:';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ProbeResult } from '../src/llm/probes.ts';

let alerts: { severity: string; title: string }[] = [];
mock.module('../src/health/alert.ts', {
  namedExports: { sendHealthAlert: async (severity: string, title: string) => { alerts.push({ severity, title }); } },
});

const { maybeAlertContractDrift, contractCheck } = await import('../src/health/contract.ts');
const { getProbe } = await import('../src/store/contract.ts');

const pr = (dep: ProbeResult['dep'], ok: boolean, at = 1000): ProbeResult => ({ dep, available: true, ok, detail: ok ? '完好' : 'drift', raw: ok ? undefined : 'renamed-jsonl…', at });

// 顺序共享 :memory: 库，按真实时间线推进。
test('首次漂移 → 告警一次 degraded + 落库 ok=0 + contractCheck degraded', async () => {
  alerts = [];
  await maybeAlertContractDrift([pr('codex', false, 1000)]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'degraded');
  assert.match(alerts[0].title, /codex/);
  assert.equal(getProbe('codex')?.ok, false);
  const c = contractCheck(2000);
  assert.equal(c.status, 'degraded');
  assert.match(c.detail, /codex/);
});

test('持久漂移 → 不再重复告警（翻转去抖）', async () => {
  alerts = [];
  await maybeAlertContractDrift([pr('codex', false, 3000)]);
  assert.equal(alerts.length, 0, '同一依赖持续漂移不该每日刷屏');
});

test('恢复 → 发 recovered 一次 + contractCheck healthy', async () => {
  alerts = [];
  await maybeAlertContractDrift([pr('codex', true, 5000)]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'recovered');
  assert.equal(getProbe('codex')?.ok, true);
  assert.equal(contractCheck(6000).status, 'healthy');
});

test('available=false（探针跳过）→ 不告警、不落库', async () => {
  alerts = [];
  await maybeAlertContractDrift([{ dep: 'claude', available: false, ok: false, detail: 'skip', at: 7000 }]);
  assert.equal(alerts.length, 0);
  assert.equal(getProbe('claude'), null);
});
