import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocRef, extractDocToken } from '../src/feishu/doc.ts';

// 业务契约：/docx/ 与 /wiki/ 必须分流 —— docx 直链不能当 wiki 节点解析（这是修复的核心 bug）。
test('parseDocRef：/wiki/ → kind=wiki', () => {
  const r = parseDocRef('https://example.feishu.cn/wiki/KRKfwhzDbiwncHk1QDvc2yFSnMd');
  assert.equal(r.kind, 'wiki');
  assert.equal(r.token, 'KRKfwhzDbiwncHk1QDvc2yFSnMd');
});

test('parseDocRef：/docx/ → kind=docx（关键：不能误判 wiki）', () => {
  const r = parseDocRef('https://x.feishu.cn/docx/Tm9TdabcOEFxyz1234567890');
  assert.equal(r.kind, 'docx');
  assert.equal(r.token, 'Tm9TdabcOEFxyz1234567890');
});

test('parseDocRef：/docs/ 旧链 → 归 docx 读法', () => {
  assert.equal(parseDocRef('https://x.feishu.cn/docs/abcDEF123').kind, 'docx');
});

test('parseDocRef：带 query/锚点也能取对 token', () => {
  const r = parseDocRef('https://x.feishu.cn/wiki/ABC123?from=share#heading');
  assert.equal(r.token, 'ABC123');
  assert.equal(r.kind, 'wiki');
});

test('parseDocRef：裸 token → unknown，原样返回', () => {
  const r = parseDocRef('KRKfwhzDbiwncHk1QDvc2yFSnMd');
  assert.equal(r.kind, 'unknown');
  assert.equal(r.token, 'KRKfwhzDbiwncHk1QDvc2yFSnMd');
});

test('extractDocToken：向后兼容仍只回 token', () => {
  assert.equal(extractDocToken('https://x.feishu.cn/docx/Z9'), 'Z9');
});
