import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeishuLinks } from '../src/daemon/listen.ts';
import { formValue } from '../src/messaging/feishu.ts'; // 表单解析随入站迁到 adapter

// 群消息入口：从一句话里捞飞书文档链接(wiki/docx/docs)，去重。
test('extractFeishuLinks：捞出 wiki/docx 链接', () => {
  const t = '帮我评审下 https://example.feishu.cn/wiki/KRKfwhzDbiwncHk1QDvc2yFSnMd 谢谢';
  assert.deepEqual(extractFeishuLinks(t), ['https://example.feishu.cn/wiki/KRKfwhzDbiwncHk1QDvc2yFSnMd']);
});

test('extractFeishuLinks：多链接 + 去重', () => {
  const t = 'a https://x.feishu.cn/docx/AAA b https://x.feishu.cn/docx/AAA c https://x.feishu.cn/wiki/BBB';
  const r = extractFeishuLinks(t);
  assert.equal(r.length, 2);
  assert.ok(r.includes('https://x.feishu.cn/docx/AAA'));
  assert.ok(r.includes('https://x.feishu.cn/wiki/BBB'));
});

test('extractFeishuLinks：无链接 → 空', () => {
  assert.deepEqual(extractFeishuLinks('今天天气不错'), []);
  assert.deepEqual(extractFeishuLinks('https://github.com/x/y'), []); // 非飞书不抓
});

// 卡片表单回调：从原始事件挖 verdict/notes（兼容 raw.event.action 与 raw.action）。
test('formValue：raw.event.action.form_value', () => {
  const evt = { raw: { event: { action: { form_value: { verdict: 'accept', notes: 'ok' } } } } };
  assert.deepEqual(formValue(evt), { verdict: 'accept', notes: 'ok' });
});

test('formValue：raw.action.form_value（无 event 包裹）', () => {
  const evt = { raw: { action: { form_value: { verdict: 'deny' } } } };
  assert.deepEqual(formValue(evt), { verdict: 'deny' });
});

test('formValue：无表单值 → 空对象（不崩）', () => {
  assert.deepEqual(formValue({}), {});
  assert.deepEqual(formValue({ raw: {} }), {});
});
