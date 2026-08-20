// 自愈解析内核：解析失败 → 回喂重出 → 重解析；耗尽抛；回喂调用失败(null)退避后内层有限重试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseStructured, strictParse, formatZodError } from '../src/llm/structured.ts';

const Schema = z.object({ ok: z.boolean(), n: z.number() });

test('strictParse：抽取 + 校验，成功返回输出类型', () => {
  assert.deepEqual(strictParse(Schema, '```json\n{"ok":true,"n":3}\n```'), { ok: true, n: 3 });
});

test('strictParse：不符契约 → 抛可读错', () => {
  assert.throws(() => strictParse(Schema, '{"ok":"yes"}'), /契约/);
});

test('parseStructured：首次即好 → 不回喂', async () => {
  let reEmits = 0;
  const out = await parseStructured<{ ok: boolean; n: number }>({
    text: '{"ok":true,"n":1}',
    parse: (t) => strictParse(Schema, t),
    reEmit: async () => { reEmits++; return null; },
    buildRepairInstruction: () => 'fix it',
    maxRetries: 2,
  });
  assert.deepEqual(out, { ok: true, n: 1 });
  assert.equal(reEmits, 0);
});

test('parseStructured：坏一次 → 回喂重出 → 好（自愈成功 + 落事件）', async () => {
  const events: string[] = [];
  let calls = 0;
  const out = await parseStructured<{ ok: boolean; n: number }>({
    text: '坏 json {{{',
    parse: (t) => strictParse(Schema, t),
    reEmit: async (instr) => {
      calls++;
      assert.match(instr, /fix:/); // 修复指令带进来了
      return '{"ok":true,"n":7}';
    },
    buildRepairInstruction: (err) => `fix: ${err}`,
    maxRetries: 2,
    note: (k) => events.push(k),
  });
  assert.deepEqual(out, { ok: true, n: 7 });
  assert.equal(calls, 1);
  assert.ok(events.includes('parse_repair_attempt'));
});

test('parseStructured：耗尽仍坏 → 抛 + 落 exhausted 事件 + dump 每次回喂', async () => {
  const events: string[] = [];
  const dumps: string[] = [];
  await assert.rejects(
    () => parseStructured({
      text: '坏0',
      parse: (t) => strictParse(Schema, t),
      reEmit: async () => '还是坏',
      buildRepairInstruction: () => 'fix',
      maxRetries: 2,
      note: (k) => events.push(k),
      dump: (raw) => dumps.push(raw),
    }),
  );
  assert.equal(events.filter((k) => k === 'parse_repair_attempt').length, 2);
  assert.ok(events.includes('parse_repair_exhausted'));
  assert.equal(dumps.length, 2); // 两次回喂都落盘
});

test('parseStructured：reEmit 持续失败(null) → 内层有限重试后抛（不无限硬撑）', async () => {
  const events: string[] = [];
  let calls = 0;
  await assert.rejects(
    () => parseStructured({
      text: '坏',
      parse: (t) => strictParse(Schema, t),
      reEmit: async () => { calls++; return null; },
      buildRepairInstruction: () => 'fix',
      maxRetries: 3,
      reEmitCallRetries: 2,
      sleep: async () => {}, // 免真睡
      note: (k) => events.push(k),
    }),
  );
  // 单个 parse-attempt 内回喂 callRetries+1=3 次仍 null → no_reemit 抛；不耗到 maxRetries。
  assert.equal(calls, 3);
  assert.equal(events.filter((k) => k === 'parse_repair_reemit_failed').length, 3);
  assert.ok(events.includes('parse_repair_no_reemit'));
  assert.equal(events.filter((k) => k === 'parse_repair_attempt').length, 1);
});

test('parseStructured：回喂调用先瞬时失败(null)后成功 → 自愈不被一抖终结（P1-1）', async () => {
  const events: string[] = [];
  let calls = 0;
  const out = await parseStructured<{ ok: boolean; n: number }>({
    text: '坏 json {{{',
    parse: (t) => strictParse(Schema, t),
    reEmit: async () => {
      calls++;
      if (calls === 1) return null; // 第一次回喂瞬时失败（超时/限流）
      return '{"ok":true,"n":9}'; // 退避后重试成功
    },
    buildRepairInstruction: () => 'fix',
    maxRetries: 2,
    reEmitCallRetries: 2,
    sleep: async () => {},
    note: (k) => events.push(k),
  });
  assert.deepEqual(out, { ok: true, n: 9 });
  assert.equal(calls, 2); // 失败一次 + 成功一次
  assert.ok(events.includes('parse_repair_reemit_failed'));
});

test('formatZodError：把 issues 拍成一行', () => {
  const r = Schema.safeParse({ ok: 1 });
  assert.equal(r.success, false);
  if (!r.success) assert.match(formatZodError(r.error), /ok|n/);
});
