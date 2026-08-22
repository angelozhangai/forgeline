// 真二进制契约冒烟测试：真跑 codex/claude/gh/飞书，断言信封字段还在。
// 双重门控：① 二进制/配置缺 → skip（CI 的 ubuntu 没有这些二进制，自动跳过保持绿）；
//           ② 未设 FORGE_CONTRACT_LIVE=1 → skip（codex/claude 探针花真钱，本地普通 npm test 也不破费）。
// 真跑：本机/Mac mini `FORGE_CONTRACT_LIVE=1 npm test`，或定时 `forge contract-check`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandExists } from '../src/util/proc.ts';
import { probeCodex, probeClaude, probeGh, probeIm } from '../src/llm/probes.ts';

const LIVE = process.env.FORGE_CONTRACT_LIVE === '1';
const now = 1_700_000_000_000; // 固定注入时钟（避免 Date.now，且 schema 不依赖它）

test('契约·codex（真二进制）', { skip: !LIVE || !commandExists('codex') }, async () => {
  const r = await probeCodex(now);
  assert.ok(r.ok, `codex 契约漂移：${r.detail}`);
});

test('契约·claude（真二进制）', { skip: !LIVE || !commandExists('claude') }, async () => {
  const r = await probeClaude(now);
  assert.ok(r.ok, `claude 契约漂移：${r.detail}`);
});

test('契约·gh（真二进制·只读免费）', { skip: !LIVE || !commandExists('gh') }, async () => {
  const r = await probeGh(now);
  assert.ok(r.ok, `gh 契约漂移：${r.detail}`);
});

test('契约·飞书 API（金丝雀·只读免费）', { skip: !LIVE }, async () => {
  const r = await probeIm(now);
  if (!r.available) return; // 未配齐 → 不算失败
  assert.ok(r.ok, `飞书契约漂移：${r.detail}`);
});
