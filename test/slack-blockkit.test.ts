// Block Kit 的**结构闸**：把「只有真工作区点一次才会现形」的那一类坑搬进 CI。
//
// 这类坑的形态是统一的：Slack 回 `ok:false / invalid_blocks`，**不说是哪一块哪个字段**，
// 于是人看到的只是「卡片没出现」或「按钮点了没反应」，日志里只有一行 warn。issue #14 的验收清单
// 之所以要一个真工作区，一半就是为了照出这一类——而它们其实全是**结构**问题，本地可判。
//
// 于是这里做两件事：
//  ① 校验器自身逐条钉死（每条规则都能真的抓到对应的违规——否则它只是一个永远返回空数组的摆设）；
//  ② 对着「Forge 能发出的每一种卡片 / 每一种模态」跑一遍，包括**恶意内容**（边界上的 emoji、
//     空串、超长文本）——这才是真正的验收：不是"我们写对了一次"，而是"任何一张卡都出不了这个错"。
process.env.FORGE_DB = ':memory:';
process.env.FORGE_FUN = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BK_LIMIT, explain, validateAttachments, validateBlocks, validateView } from '../src/slack/blockkit.ts';
import { buildDecisionModal, buildGoModal } from '../src/slack/modal.ts';
import { renderSlackMessage } from '../src/messaging/slack.ts';
import { buildCard, buildStatusCard, type NotifyKind } from '../src/notify.ts';
import { STATES } from '../src/statemachine/states.ts';
import type { CardBlock, CardModel } from '../src/messaging/model.ts';
import type { DecisionItem } from '../src/gates/envelopes.ts';
import type { Session } from '../src/types.ts';

// ── ① 校验器自己 ────────────────────────────────────────────────────
// 每条规则都配一个"确实违规"的载荷。少了这一层，校验器有可能永远返回空数组而没人发现。

const okSection = { type: 'section', text: { type: 'mrkdwn', text: 'hi' } };

test('校验器：合法载荷返回空数组（不能是个只会说 OK 的摆设——下面每条都真的抓得到）', () => {
  assert.deepEqual(validateBlocks([{ type: 'header', text: { type: 'plain_text', text: 't' } }, okSection, { type: 'divider' }]), []);
});

test('校验器：空文本 —— Slack 不接受空 plain_text/mrkdwn，整条载荷会被拒', () => {
  const p = validateBlocks([{ type: 'section', text: { type: 'mrkdwn', text: '' } }]);
  assert.equal(p.length, 1);
  assert.match(p[0], /text 为空/);
});

test('校验器：超上限 —— 上限按字段分（header 150 / section 3000 / 按钮 75）', () => {
  assert.match(validateBlocks([{ type: 'header', text: { type: 'plain_text', text: 'x'.repeat(151) } }])[0], /超上限（151 > 150）/);
  assert.match(validateBlocks([{ type: 'section', text: { type: 'mrkdwn', text: 'x'.repeat(3001) } }])[0], /超上限（3001 > 3000）/);
});

test('校验器：落单的代理对 —— emoji 被从中间截断，Slack 收到非法 UTF-16 直接拒整条', () => {
  const half = `${'x'.repeat(4)}🚀`.slice(0, 5); // 只留代理对的前一半
  assert.match(validateBlocks([{ type: 'section', text: { type: 'mrkdwn', text: half } }])[0], /落单的代理对/);
});

test('校验器：空的 actions.elements —— 这是"少一个按钮"想不到的后果：整条消息被拒', () => {
  assert.match(validateBlocks([{ type: 'actions', elements: [] }])[0], /至少一个元素/);
});

test('校验器：空的 section.fields / 空 context.elements 同样非法', () => {
  assert.match(validateBlocks([{ type: 'section', fields: [] }])[0], /为空数组/);
  assert.match(validateBlocks([{ type: 'context', elements: [] }])[0], /elements：为空/);
});

test('校验器：按钮 value 超 2000、action_id 重复、style 不是 primary/danger —— 三种都会整条被拒', () => {
  const btn = (extra: Record<string, unknown>) => ({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'b' }, action_id: 'a1', ...extra }] });
  assert.match(validateBlocks([btn({ value: 'v'.repeat(2001) })])[0], /value：超上限/);
  assert.match(validateBlocks([btn({ style: 'default' })])[0], /只允许 primary\/danger/);
  assert.match(validateBlocks([btn({}), btn({})]).join(''), /action_id 重复「a1」/);
});

test('校验器：块数上限 —— 消息 50、模态 100（超了不是"尾巴没了"，是整条被拒）', () => {
  const many = Array.from({ length: 51 }, () => okSection);
  assert.match(validateBlocks(many)[0], /块数超上限（51 > 50）/);
  assert.deepEqual(validateBlocks(many, { max: BK_LIMIT.blocksPerView }), []);
});

test('校验器：空块列表 / 非数组 —— 认不出就如实说，绝不当成合法', () => {
  assert.match(validateBlocks([])[0], /为空/);
  assert.match(validateBlocks(null)[0], /不是数组/);
});

test('校验器：模态三件套（title/submit/close）封顶 24；private_metadata 封顶 3000', () => {
  const view = (extra: Record<string, unknown>) => ({ type: 'modal', title: { type: 'plain_text', text: 't' }, blocks: [okSection], ...extra });
  assert.match(validateView(view({ submit: { type: 'plain_text', text: 'x'.repeat(25) } }))[0], /view.submit：text 超上限/);
  assert.match(validateView(view({ private_metadata: 'x'.repeat(3001) }))[0], /private_metadata：超上限/);
  assert.deepEqual(validateView(view({})), []);
});

test('校验器：attachments 的色条必须是 #rrggbb（Slack 不认模板色名）', () => {
  assert.match(validateAttachments([{ color: 'red', blocks: [okSection] }])[0], /应为 #rrggbb/);
  assert.deepEqual(validateAttachments([{ color: '#2eb886', blocks: [okSection] }]), []);
});

test('explain：结构没问题时明说"多半是权限/频道/凭据"——不要让人对着载荷白找', () => {
  assert.match(explain([]), /多半是权限\/频道\/凭据/);
  assert.match(explain(['a', 'b']), /结构自检：a；b/);
});

// ── ② 对着 Forge 真能发出的每一种卡片跑一遍 ──────────────────────────

function sess(p: Partial<Session> = {}): Session {
  return {
    id: 'id1',
    slug: 'finance-report',
    title: '月度财务报表自动化',
    state: 'AWAITING_GO',
    branch: 'dev',
    gate_a_output_path: null,
    routing: null,
    adversarial_residual: null,
    gate_a_cost_usd: 1,
    gate_b_cost_usd: 2,
    confirmed_by: null,
    confirmed_notes: null,
    error: null,
    prd_url: null,
    ...p,
  } as unknown as Session;
}

const KINDS: NotifyKind[] = [
  'needs_confirm',
  'needs_arbitration',
  'needs_gateb',
  'needs_gateb_input',
  'needs_gateb_arbitration',
  'needs_go',
  'needs_review_pr',
  'needs_gatec_input',
  'needs_gatec_arbitration',
  'needs_gated_input',
  'needs_gated_arbitration',
  'needs_merge',
  'failed',
  'done',
  'recovered',
];

const bad = (card: CardModel): string[] => validateAttachments(renderSlackMessage(card).attachments);

test('全部私聊卡（每一种 NotifyKind）渲染出的 Block Kit 都结构合法', () => {
  const offenders: string[] = [];
  for (const kind of KINDS) {
    const problems = bad(buildCard(kind, sess({ error: 'something broke' }), { stage: '闸B', error: 'boom', issues: [{ repo: 'api', number: 7, url: 'https://x/7' }], from: 'A', to: 'B' }));
    if (problems.length) offenders.push(`${kind}: ${problems.join('；')}`);
  }
  assert.deepEqual(offenders, []);
});

test('全部群状态卡（每一个 State）渲染出的 Block Kit 都结构合法', () => {
  const offenders: string[] = [];
  for (const state of STATES) {
    const problems = bad(buildStatusCard(sess({ state }), { stage: '闸C', error: 'boom' }));
    if (problems.length) offenders.push(`${state}: ${problems.join('；')}`);
  }
  assert.deepEqual(offenders, []);
});

// 恶意内容：每一处封顶的边界上都放一个 emoji（截断点正好劈开代理对），外加空串与超长文本。
const EDGE = (n: number): string => `${'字'.repeat(n - 1)}🚀${'尾'.repeat(50)}`;
const items = (n: number): DecisionItem[] =>
  Array.from({ length: n }, (_, i) => ({
    prompt: EDGE(BK_LIMIT.inputLabel),
    severity: 'high',
    hint: EDGE(BK_LIMIT.inputLabel),
    options: [{ label: EDGE(BK_LIMIT.optionText), recommended: i === 0, impact: '大' }],
  })) as unknown as DecisionItem[];

test('恶意内容：截断点正好落在 emoji 上 / 空串 / 超长——一整张卡照样结构合法', () => {
  const blocks: CardBlock[] = [
    { kind: 'text', md: EDGE(BK_LIMIT.sectionText) },
    { kind: 'text', md: '' },
    { kind: 'note', md: '' },
    { kind: 'footnote', md: EDGE(BK_LIMIT.contextText) },
    { kind: 'quote', text: '  \n  ' },
    { kind: 'callout', tone: 'danger', md: '' },
    { kind: 'divider' },
    { kind: 'stats', fields: [] },
    { kind: 'stats', fields: [EDGE(BK_LIMIT.fieldText), '', 'ok'] },
    { kind: 'buttonRow', buttons: [] },
    { kind: 'button', button: { text: EDGE(BK_LIMIT.buttonText), style: 'default', action: 'go', slug: 's', value: { blob: 'x'.repeat(3000) } } },
    { kind: 'decisionList', items: items(3) },
    { kind: 'findingList', findings: [{ severity: 'high', lead: EDGE(BK_LIMIT.sectionText), notes: [{ label: '位置', text: '' }] }] },
    { kind: 'petRow', asset: 'a', voice: '' },
    { kind: 'goForm', slug: 's', pool: [], picked: null },
  ];
  assert.deepEqual(bad({ color: 'red', title: EDGE(BK_LIMIT.headerText), subtitle: '', blocks }), []);
});

test('空标题也发得出去：header 与通知栏 text 都不能为空（空 = 整条被拒，卡片就此消失）', () => {
  const out = renderSlackMessage({ color: 'grey', title: '   ', blocks: [] });
  assert.equal(out.text, 'Forge');
  assert.deepEqual(validateAttachments(out.attachments), []);
  assert.notEqual(((out.attachments[0].blocks as Record<string, unknown>[])[0] as { text: { text: string } }).text.text, '');
});

test('按钮 value 超 2000 时只保留 {action,slug}——绝不截出一个 parse 不回来的 JSON', () => {
  const card: CardModel = { color: 'blue', title: 't', blocks: [{ kind: 'button', button: { text: 'go', style: 'primary', action: 'go', slug: 'finance-report', value: { blob: 'x'.repeat(3000) } } }] };
  const el = ((card && renderSlackMessage(card).attachments[0].blocks) as Record<string, unknown>[])[1] as { elements: { value: string }[] };
  assert.deepEqual(JSON.parse(el.elements[0].value), { action: 'go', slug: 'finance-report' });
  assert.deepEqual(bad(card), []);
});

// ── 模态 ────────────────────────────────────────────────────────────

test('全部模态形态（有/无待决项、有/无整体结论、有/无 DRI 池）都是合法 view', () => {
  const ctx = { action: 'confirm_submit', slug: 'finance-report', round: 2, kind: 'decision' as const };
  const o = { submitText: EDGE(BK_LIMIT.viewChip), notesLabel: EDGE(BK_LIMIT.inputLabel), notesPlaceholder: EDGE(BK_LIMIT.placeholder), title: '' };
  assert.deepEqual(validateView(buildDecisionModal(ctx, { items: items(12), verdict: true, ...o })), []);
  assert.deepEqual(validateView(buildDecisionModal(ctx, { items: [], verdict: false, ...o })), []);
  const go = { action: 'go', slug: 'finance-report', kind: 'go' as const };
  assert.deepEqual(validateView(buildGoModal(go, ['M', 'EO', EDGE(BK_LIMIT.optionValue)], 'EO')), []);
  assert.deepEqual(validateView(buildGoModal(go, [], null)), []);
});
