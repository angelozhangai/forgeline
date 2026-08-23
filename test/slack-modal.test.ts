// 模态往返（src/slack/modal.ts）——Slack 与飞书唯一一处真正的交互差异。
// 赌的就是一件事：**上下文能靠 private_metadata 活着回来**，而字段能靠 state.values 一次全拿到。
// 这里把往返的两端拼起来跑一遍（build → 模拟提交 → parse），载荷形状取自 Slack 官方文档。
//
// ⚠️ 钉的是我们的处理，不是 Slack 的真实行为——真工作区联调仍是 PR 里列的未验项。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionModal, buildGoModal, flattenStateValues, parseViewSubmission, type ModalContext } from '../src/slack/modal.ts';
import type { DecisionItem } from '../src/gates/envelopes.ts';

const ITEMS: DecisionItem[] = [
  { id: 'H1', prompt: '要不要限额？', severity: 'high', options: [{ label: '要', recommended: true }, { label: '不要' }], hint: '按风控口径' },
  { id: 'H2', prompt: '什么时候上？', options: [{ label: '本周' }, { label: '下周' }] },
];
const CTX: ModalContext = { action: 'confirm_submit', slug: 'refund', round: 3, kind: 'decision' };

// 模拟 Slack 提交：把每个 input 块按用户填的内容装成 state.values 的两层结构。
function submit(view: Record<string, unknown>, filled: Record<string, string>): Record<string, unknown> {
  const values: Record<string, Record<string, unknown>> = {};
  for (const b of view.blocks as { type: string; block_id?: string; element?: { type: string; action_id: string } }[]) {
    if (b.type !== 'input' || !b.block_id || !b.element) continue;
    const v = filled[b.block_id];
    const el = b.element.type === 'plain_text_input' ? { type: 'plain_text_input', value: v ?? null } : { type: 'static_select', selected_option: v === undefined ? null : { value: v } };
    values[b.block_id] = { [b.element.action_id]: el };
  }
  return { type: 'view_submission', user: { id: 'U42' }, view: { private_metadata: view.private_metadata, state: { values } } };
}

test('决策模态：每条待决项一个 input 块，block_id/action_id 都是 ask_<id>（与回拼同序对齐，绝不串题）', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, verdict: true, submitText: '提交答复', notesLabel: '补充说明', notesPlaceholder: '写点什么' });
  const ids = (v.blocks as { block_id?: string }[]).map((b) => b.block_id);
  assert.deepEqual(ids, ['ask_H1', 'ask_H2', 'verdict', 'notes']);
  assert.equal(v.type, 'modal');
  assert.equal((v.submit as { text: string }).text, '提交答复');
});

test('决策模态：选项带 ★推荐 + 「其他」兜底；hint 落 hint 字段', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  const first = (v.blocks as Record<string, unknown>[])[0] as { element: { options: { text: { text: string }; value: string }[] }; hint?: { text: string } };
  assert.deepEqual(first.element.options.map((o) => o.text.text), ['★ 要', '不要', '其他（在下方补充说明里填）']);
  assert.equal(first.element.options[2].value, '__other__');
  assert.match(first.hint?.text ?? '', /按风控口径/);
});

test('决策模态：每一项都是 optional——PM 可以只答一部分，剩下写补充框（与飞书语义一致）', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, verdict: true, submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  for (const b of v.blocks as { type: string; optional?: boolean }[]) {
    if (b.type === 'input') assert.equal(b.optional, true);
  }
});

test('往返：{action,slug,round} 经 private_metadata 原样回来，字段一次全到（这就是本阶段赌的那件事）', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, verdict: true, submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  const payload = submit(v, { ask_H1: '要', ask_H2: '下周', verdict: 'accept', notes: '按风控口径来' });
  const parsed = parseViewSubmission(payload);
  assert.deepEqual(parsed, {
    action: 'confirm_submit',
    slug: 'refund',
    round: 3,
    formValues: { ask_H1: '要', ask_H2: '下周', verdict: 'accept', notes: '按风控口径来' },
  });
});

test('往返：没选的项**不出现**在 formValues 里（填空串会把「没答」写成「答了空」）', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, verdict: true, submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  const parsed = parseViewSubmission(submit(v, { ask_H1: '要' }));
  assert.deepEqual(parsed?.formValues, { ask_H1: '要' });
});

test('立项模态：DRI 下拉 + 预选推荐人；提交回来是 assignee', () => {
  const ctx: ModalContext = { action: 'go', slug: 'refund', kind: 'go' };
  const v = buildGoModal(ctx, ['M', 'CC'], 'CC');
  const el = (v.blocks as Record<string, unknown>[])[0] as { element: { type: string; initial_option?: { value: string } } };
  assert.equal(el.element.type, 'static_select');
  assert.equal(el.element.initial_option?.value, 'CC');
  assert.deepEqual(parseViewSubmission(submit(v, { assignee: 'M' })), { action: 'go', slug: 'refund', round: 0, formValues: { assignee: 'M' } });
});

test('立项模态：拿不到 DRI 池（守护重启的降级路径）→ 退成自由文本，绝不让按钮点了没反应', () => {
  const v = buildGoModal({ action: 'go', slug: 's', kind: 'go' }, [], null);
  const el = (v.blocks as Record<string, unknown>[])[0] as { element: { type: string } };
  assert.equal(el.element.type, 'plain_text_input');
});

test('parseViewSubmission：private_metadata 坏/缺/无 slug → null（认不出就是认不出，绝不猜一个 slug）', () => {
  assert.equal(parseViewSubmission({ view: { private_metadata: '不是json' } }), null);
  assert.equal(parseViewSubmission({ view: { private_metadata: '{}' } }), null);
  assert.equal(parseViewSubmission({ view: { private_metadata: '{"action":"go"}' } }), null);
  assert.equal(parseViewSubmission({}), null);
});

test('flattenStateValues：两层嵌套拍平；下拉取 selected_option.value，文本取 value', () => {
  assert.deepEqual(
    flattenStateValues({
      values: {
        a: { ask_H1: { type: 'static_select', selected_option: { value: 'x' } } },
        b: { notes: { type: 'plain_text_input', value: 'y' } },
        c: { empty: { type: 'plain_text_input', value: '' } },
        d: { unset: { type: 'static_select', selected_option: null } },
      },
    }),
    { ask_H1: 'x', notes: 'y' },
  );
  assert.deepEqual(flattenStateValues(undefined), {});
});

test('决策模态：没有待决项也给得出合法 view（Slack 不接受空 blocks，会整个报错）', () => {
  const v = buildDecisionModal(CTX, { items: [], submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  assert.ok((v.blocks as unknown[]).length >= 1);
});

// ── plain_text 的上限是按字段分的，超了不是截断而是**整发失败** ───────────
// view.title/submit/close = 24；option.text/value = 75；placeholder = 150；input.label/hint = 2000。
// 违反哪一条，views.open 都只回一个 ok:false —— 用户侧的症状是「按钮点了没反应」，
// 日志里也只有一行 invalid_arguments。这类错只有真工作区点一次才会出现，所以在这里钉死。
const lenOf = (t: string): number => Array.from(t).length;
const textOf = (o: unknown): string => (o as { text: string }).text;

test('模态标题/提交/取消封顶 24 字符——超了 views.open 直接 ok:false，人看到的是「按钮点了没反应」', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, submitText: '提交决议'.repeat(10), notesLabel: 'n', notesPlaceholder: 'p', title: '这是一个非常非常非常长的模态标题'.repeat(3) });
  assert.ok(lenOf(textOf(v.title)) <= 24, `title 超限：${textOf(v.title)}`);
  assert.ok(lenOf(textOf(v.submit)) <= 24, `submit 超限：${textOf(v.submit)}`);
  assert.ok(lenOf(textOf(v.close)) <= 24);
  assert.match(textOf(v.submit), /…$/, '截断要看得出来是截断');
});

test('提交文案为空同样是 ok:false（空 plain_text 不合法）→ 退到兜底文案，绝不发一个开不出来的模态', () => {
  const v = buildDecisionModal(CTX, { items: ITEMS, submitText: '   ', notesLabel: 'n', notesPlaceholder: 'p', title: '' });
  assert.equal(textOf(v.submit), '提交');
  assert.equal(textOf(v.title), '需求评审');
});

test('截断按码点走：绝不把 emoji 的代理对劈成两半（非法 UTF-16 会让整个 view 被拒）', () => {
  const v = buildDecisionModal(CTX, { items: [], submitText: '🔴'.repeat(40), notesLabel: 'n', notesPlaceholder: 'p' });
  const t = textOf(v.submit);
  assert.ok(lenOf(t) <= 24);
  assert.doesNotMatch(t, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, '不该出现落单的代理项');
});

test('待决项 label 按 2000 封顶而不是 150——PM 不该在模态里只看见半句问题', () => {
  const long = '为'.repeat(600);
  const v = buildDecisionModal(CTX, { items: [{ id: 'H1', prompt: long, options: [{ label: 'a' }] }], submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  const label = textOf((v.blocks as { label: unknown }[])[0].label);
  assert.ok(lenOf(label) > 150, '150 是 placeholder 的上限，不是 label 的');
  assert.ok(lenOf(label) <= 2000);
});

test('下拉选项 text/value 封顶 75；value 不带省略号（它要原样回喂给核心，不是给人看的）', () => {
  const long = 'x'.repeat(200);
  const v = buildDecisionModal(CTX, { items: [{ id: 'H1', prompt: 'p', options: [{ label: long }] }], submitText: 's', notesLabel: 'n', notesPlaceholder: 'p' });
  const opt = (v.blocks as { element: { options: { text: unknown; value: string }[] } }[])[0].element.options[0];
  assert.ok(lenOf(textOf(opt.text)) <= 75);
  assert.equal(opt.value, 'x'.repeat(75));
});
