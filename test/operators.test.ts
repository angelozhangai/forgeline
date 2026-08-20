// resolveActor：入站 open_id → 短码，权限闸按真实点击人裁决。守两条安全/兼容铁律。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveActor } from '../src/messaging/operators.ts';

test('未配 operators（单人）→ 一律回退 M（沿用旧行为，零变化）', () => {
  assert.equal(resolveActor('ou_anything', {}), 'M');
  assert.equal(resolveActor(undefined, {}), 'M');
});

test('配了 operators：已知 open_id → 映射短码', () => {
  const ops = { ou_m: 'M', ou_jt: 'BD' };
  assert.equal(resolveActor('ou_m', ops), 'M');
  assert.equal(resolveActor('ou_jt', ops), 'BD');
});

test('配了 operators 但 open_id 陌生 → 返回原值（落不进允许名单 → 权限拒绝，绝不冒充 M）', () => {
  const ops = { ou_m: 'M' };
  assert.equal(resolveActor('ou_stranger', ops), 'ou_stranger');
  assert.equal(resolveActor(undefined, ops), 'unknown'); // 配了却无 open_id → 不提权
});
