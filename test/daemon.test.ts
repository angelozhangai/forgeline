import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formValue } from '../src/messaging/feishu.ts'; // 表单解析随入站迁到 adapter

// 注：「从一句话里捞文档链接」在 Phase 1 随文档源迁走了——listen 现在只调 claimDocs，
// 认链接是 docs/feishu.ts 的事，用例见 docs-feishu.test.ts / docs-registry.test.ts。

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
