import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, deriveSlug } from '../src/util/slug.ts';

// 业务约定：标题转 kebab；中文/无 ASCII → 空（交由上层回退）；override 优先。
test('slugify：ASCII 标题 → kebab、截断 40', () => {
  assert.equal(slugify('Finance Points Report'), 'finance-points-report');
  assert.equal(slugify('  Pay/Refund  Edge!! '), 'pay-refund-edge');
  assert.equal(slugify('a'.repeat(60)).length, 40);
});

test('slugify：纯中文 → 空字符串（不是乱码）', () => {
  assert.equal(slugify('财务后台需求文档'), '');
});

test('deriveSlug：override 优先于标题', () => {
  assert.equal(deriveSlug('财务后台报表', 'finance-report'), 'finance-report');
  // override 本身是中文 → slugify 空 → 回退到 override 原文 trim
  assert.equal(deriveSlug('x', '  中文  '), '中文');
});

test('deriveSlug：中文标题无 override → req-<id> 回退', () => {
  const s = deriveSlug('财务后台需求文档');
  assert.match(s, /^req-[a-z0-9]+$/);
});

test('deriveSlug：ASCII 标题无 override → 用标题', () => {
  assert.equal(deriveSlug('Admin Dashboard'), 'admin-dashboard');
});
