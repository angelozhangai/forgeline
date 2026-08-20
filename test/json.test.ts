// LLM 输出 JSON 抽取的鲁棒性：多围栏取最后、尾随逗号容错、平衡括号兜底、找不到则抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonBlock, safeParse } from '../src/util/json.ts';

test('extractJsonBlock：```json 围栏', () => {
  assert.deepEqual(extractJsonBlock('前言\n```json\n{"a":1}\n```\n后记'), { a: 1 });
});

test('extractJsonBlock：多个围栏 → 取最后一个（最终答案常在末尾）', () => {
  const text = '示例：\n```json\n{"a":0}\n```\n最终：\n```json\n{"a":9}\n```';
  assert.deepEqual(extractJsonBlock(text), { a: 9 });
});

test('extractJsonBlock：无语言标签的 ``` 围栏也认', () => {
  assert.deepEqual(extractJsonBlock('```\n{"b":2}\n```'), { b: 2 });
});

test('extractJsonBlock：无围栏 → 平衡 {} 兜底（多个取最后）', () => {
  assert.deepEqual(extractJsonBlock('好的：{"a":1} 再来 {"a":2} 完'), { a: 2 });
});

test('extractJsonBlock：尾随逗号容错', () => {
  assert.deepEqual(extractJsonBlock('```json\n{"a":1,"b":[1,2,],}\n```'), { a: 1, b: [1, 2] });
});

test('extractJsonBlock：字符串里的花括号不影响平衡扫描', () => {
  assert.deepEqual(extractJsonBlock('{"s":"有个 } 在字符串里","n":1}'), { s: '有个 } 在字符串里', n: 1 });
});

test('extractJsonBlock：找不到 JSON → 抛', () => {
  assert.throws(() => extractJsonBlock('完全没有 JSON 的一段话'), /找不到 JSON/);
});

test('extractJsonBlock：彻底坏的 JSON → 抛（交自愈）', () => {
  assert.throws(() => extractJsonBlock('```json\n{不是合法 json\n```'));
});

test('safeParse：脏值降级到 fallback，绝不抛', () => {
  assert.deepEqual(safeParse('{"a":1}', { a: 0 }), { a: 1 });
  assert.deepEqual(safeParse('坏 json', { a: 0 }), { a: 0 });
  assert.deepEqual(safeParse(null, []), []);
  assert.deepEqual(safeParse(undefined, []), []);
});
