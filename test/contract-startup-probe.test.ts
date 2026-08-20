// 启动契约探测节流（防 daemon 崩溃重启循环每次启动都付费探一次）。纯函数，确定性、不花钱、不碰 DB。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupProbeDue } from '../src/store/contract.ts';
import type { ProbeRow } from '../src/store/contract.ts';

const row = (checkedAt: number): ProbeRow => ({ dep: 'claude', ok: true, detail: '', raw: null, checkedAt });
const HOUR = 3600_000;
const now = 1_700_000_000_000;

test('startupProbeDue：从没探过 → 该跑', () => {
  assert.equal(startupProbeDue([], now, 24 * HOUR), true);
});

test('startupProbeDue：全部都在间隔内 → 跳过（崩溃重启不重复付费）', () => {
  assert.equal(startupProbeDue([row(now - 1 * HOUR)], now, 24 * HOUR), false);
  // 多条全新 → 取最旧仍在间隔内 → 跳过
  assert.equal(startupProbeDue([row(now - 3 * HOUR), row(now - 2 * HOUR)], now, 24 * HOUR), false);
});

test('startupProbeDue：取最旧那条判定——任一依赖陈旧即重探（新探针不遮旧探针）', () => {
  // codex 50h 前探过、claude 2h 前探过（某轮 codex unavailable 被跳过致其行滞后）：
  // 取最旧（50h）→ 该跑，否则 codex 行永远陈旧（取最新会误判「都新」而跳过）。
  assert.equal(startupProbeDue([row(now - 50 * HOUR), row(now - 2 * HOUR)], now, 24 * HOUR), true);
});

test('startupProbeDue：最近一次已超间隔 → 该跑（边界=间隔 视为到期）', () => {
  assert.equal(startupProbeDue([row(now - 25 * HOUR)], now, 24 * HOUR), true);
  assert.equal(startupProbeDue([row(now - 24 * HOUR)], now, 24 * HOUR), true); // 恰好到期
});
