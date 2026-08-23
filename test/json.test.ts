// How robustly JSON is extracted from an LLM's output: several fences take the last, a trailing comma is
// tolerated, balanced braces are the fallback, and finding nothing throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonBlock, safeParse } from '../src/util/json.ts';

test('extractJsonBlock: a ```json fence', () => {
  assert.deepEqual(extractJsonBlock('Preamble\n```json\n{"a":1}\n```\nPostscript'), { a: 1 });
});

test('extractJsonBlock: several fences -> take the last (the final answer is usually at the end)', () => {
  const text = 'For example:\n```json\n{"a":0}\n```\nFinally:\n```json\n{"a":9}\n```';
  assert.deepEqual(extractJsonBlock(text), { a: 9 });
});

test('extractJsonBlock: a ``` fence with no language tag counts too', () => {
  assert.deepEqual(extractJsonBlock('```\n{"b":2}\n```'), { b: 2 });
});

test('extractJsonBlock: no fence -> fall back to balanced {} (several -> take the last)', () => {
  assert.deepEqual(extractJsonBlock('Sure: {"a":1} and another {"a":2} done'), { a: 2 });
});

test('extractJsonBlock: a trailing comma is tolerated', () => {
  assert.deepEqual(extractJsonBlock('```json\n{"a":1,"b":[1,2,],}\n```'), { a: 1, b: [1, 2] });
});

test('extractJsonBlock: a brace inside a string does not throw off the balance scan', () => {
  assert.deepEqual(extractJsonBlock('{"s":"there is a } inside this string","n":1}'), { s: 'there is a } inside this string', n: 1 });
});

// Source is English, input is not: an envelope's values carry the requirement's own words, so extraction must
// stay byte-exact for text in any script. The fixture is built from code points rather than written as
// literal characters, the same rule the guard holds itself to (see test/english-only.test.ts).
test('extractJsonBlock: non-English values survive extraction byte for byte', () => {
  const value = String.fromCodePoint(0x9000, 0x6b3e, 0x8981, 0x80fd, 0x9000, 0x5230, 0x4f59, 0x989d);
  const text = `\`\`\`json\n${JSON.stringify({ summary: value, n: 1 })}\n\`\`\``;
  assert.deepEqual(extractJsonBlock(text), { summary: value, n: 1 });
});

test('extractJsonBlock: no JSON at all -> throws', () => {
  assert.throws(() => extractJsonBlock('a sentence with no JSON in it whatsoever'), /no JSON block found/);
});

test('extractJsonBlock: thoroughly broken JSON -> throws (self-healing takes over)', () => {
  assert.throws(() => extractJsonBlock('```json\n{not valid json\n```'));
});

test('safeParse: a dirty value degrades to the fallback and never throws', () => {
  assert.deepEqual(safeParse('{"a":1}', { a: 0 }), { a: 1 });
  assert.deepEqual(safeParse('broken json', { a: 0 }), { a: 0 });
  assert.deepEqual(safeParse(null, []), []);
  assert.deepEqual(safeParse(undefined, []), []);
});
