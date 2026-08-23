import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, deriveSlug } from '../src/util/slug.ts';

// Source is English, input is not: a requirement title arrives in whatever language it was written in, and
// slugify has to cope. These fixtures are built from code points rather than written as literal characters,
// the same rule the guard holds itself to (see test/english-only.test.ts).
const TITLE = String.fromCodePoint(0x8d22, 0x52a1, 0x540e, 0x53f0, 0x9700, 0x6c42, 0x6587, 0x6863); // "finance back-office requirement document"
const REPORT = String.fromCodePoint(0x8d22, 0x52a1, 0x540e, 0x53f0, 0x62a5, 0x8868); // "finance back-office report"
const TWO_CHARS = String.fromCodePoint(0x4e2d, 0x6587);

// The convention: a title becomes kebab-case; a title with no ASCII in it becomes empty (the layer above
// decides the fallback); an override wins.
test('slugify: an ASCII title -> kebab-case, truncated at 40', () => {
  assert.equal(slugify('Finance Points Report'), 'finance-points-report');
  assert.equal(slugify('  Pay/Refund  Edge!! '), 'pay-refund-edge');
  assert.equal(slugify('a'.repeat(60)).length, 40);
});

test('slugify: a title with no Latin characters -> an empty string (not mojibake)', () => {
  assert.equal(slugify(TITLE), '');
});

test('deriveSlug: an override wins over the title', () => {
  assert.equal(deriveSlug(REPORT, 'finance-report'), 'finance-report');
  // The override itself has no Latin characters -> slugify is empty -> fall back to the trimmed override
  assert.equal(deriveSlug('x', `  ${TWO_CHARS}  `), TWO_CHARS);
});

test('deriveSlug: a non-Latin title with no override -> the req-<id> fallback', () => {
  const s = deriveSlug(TITLE);
  assert.match(s, /^req-[a-z0-9]+$/);
});

test('deriveSlug: an ASCII title with no override -> use the title', () => {
  assert.equal(deriveSlug('Admin Dashboard'), 'admin-dashboard');
});
