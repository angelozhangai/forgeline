// probeIm 必须把 adapter（port.probe）的 kind（auth/drift）透传到 ProbeResult。
// 回归点：之前 probeIm 丢了 kind → 飞书 token 过期/群未加 bot 等鉴权失败会落到 health/contract
// 的 drift 缺省文案（误导去改 src/llm/contract.ts），漏掉 #1 要直击的「登录/凭据失效」场景。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// 仅替 port.probe()——probeIm 只用到它；避免真打飞书 API。
let fake: { available: boolean; ok: boolean; detail: string; kind?: 'auth' | 'drift'; raw?: string };
mock.module('../src/messaging/index.ts', { namedExports: { port: { probe: async () => fake } } });
const { probeIm } = await import('../src/llm/probes.ts');

const now = 1_700_000_000_000; // 固定注入时钟（不依赖 Date.now）

test('probeIm：鉴权/权限失败 kind=auth 透传（不退化成 drift）', async () => {
  fake = { available: true, ok: false, kind: 'auth', detail: 'im/v1/messages code=99991663（权限/群未加 bot）' };
  const r = await probeIm(now);
  assert.equal(r.dep, 'im');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'auth'); // 关键：透传，否则告警走「改 contract.ts」缺省文案
});

test('probeIm：信封字段缺失 kind=drift 透传', async () => {
  fake = { available: true, ok: false, kind: 'drift', detail: '缺分页信封字段', raw: '{}' };
  const r = await probeIm(now);
  assert.equal(r.kind, 'drift');
  assert.equal(r.raw, '{}'); // raw 也一并透传供告警附原文
});

test('probeIm：未配齐 available=false → 透传、无 kind（不告警）', async () => {
  fake = { available: false, ok: false, detail: '飞书 bot/观察群未配齐（跳过）' };
  const r = await probeIm(now);
  assert.equal(r.available, false);
  assert.equal(r.kind, undefined);
});

test('probeIm：信封完好 ok=true → 无 kind', async () => {
  fake = { available: true, ok: true, detail: '飞书 im/v1/messages 分页信封完好' };
  const r = await probeIm(now);
  assert.equal(r.ok, true);
  assert.equal(r.kind, undefined);
});
