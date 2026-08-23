// Slack provider 层——**模态框往返**。这是 Slack 与飞书唯一一处真正的交互差异。
//
// 飞书的卡片里可以直接放 form + 提交按钮；Slack **不行**：input 块只在 modal / Home tab 里合法，
// 而 decisionForm 需要一个自由文本的补充框。于是：卡片上放一个按钮 → views.open 开模态 →
// 用户一次填完 → 一条 view_submission 带回全部字段。
//
// 关键在于**上下文怎么活着回来**：点按钮时我们知道 {action, slug, round}，但 view_submission 里
// 不会再有那张卡片。Slack 给了 private_metadata 这个随 view 往返的不透明字符串 —— 把上下文塞进去，
// 提交时原样取回。核心那侧 InboundCardAction 的形状**一点没变**（action/slug/value/formValues）。
import type { DecisionItem } from '../gates/envelopes.ts';
import { answerableDecisions, DECISION_CAP } from '../gates/envelopes.ts';
import { BK_LIMIT } from './blockkit.ts';
import { clip, plainText } from './text.ts';

// 打开模态用的按钮上带的东西（block_actions 的 action value），也是塞进 private_metadata 的东西。
export interface ModalContext {
  action: string; // 提交后核心要收到的业务动作（confirm_submit / gateb_answer_submit / go …）
  slug: string;
  round?: number; // 群卡原地编辑时防重复投递
  kind: 'decision' | 'go'; // 决定开哪种模态
}

// ── plain_text 的上限是**按字段分的**，而且超了不是截断是整发失败 ──────
// view.title / submit / close = 24；option.text / option.value = 75；placeholder = 150；
// input.label / hint = 2000（数字见 slack/blockkit.ts 的上限表——那是唯一真源）。一刀切一个数两头都错：
//   · 标题/提交文案超 24 → views.open 直接 ok:false → 人看到的是「按钮点了没反应」，
//     本仓最不能出现的那种形态（没有任何症状指向真正的原因）；
//   · 待决项 label 砍到 150 → PM 在模态里只看得见半句问题。
// 这两种都只有在真工作区点一次按钮才会暴露 → 在这里按字段各自封顶，并在本地钉死。
//
// 截断/空串/代理对这三件事的实现在 slack/text.ts，与消息卡那侧**共用一份**。
const plain = (text: string, max: number = BK_LIMIT.placeholder): Record<string, unknown> => plainText(text, max);
// title/submit/close：既不能超 24，也**不能为空**（空 plain_text 同样是 ok:false）→ 空就退到兜底文案。
const chip = (text: string, fallback: string): Record<string, unknown> => plainText(text, BK_LIMIT.viewChip, fallback);
const mrkdwnEl = (text: string): Record<string, unknown> => ({ type: 'mrkdwn', text });

// 下拉选项：text / value 都封顶 75。截断而不是报错——选项文案是人写的，长了就截，
// 绝不能因此让整张卡发不出去。value 不加省略号：它是要回喂给核心的原值，不是给人看的。
function option(label: string, value: string): Record<string, unknown> {
  return { text: plain(label, BK_LIMIT.optionText), value: clip(value, BK_LIMIT.optionValue) };
}

// 一条待决项 → 一个 input 块（block_id = action_id = ask_<id>，与 composeDecisionAnswer 同序对齐）。
// optional:true 是有意的：PM 可以只答一部分，剩下的写进补充框——跟飞书那侧的语义一致。
function askBlock(id: string, item: DecisionItem): Record<string, unknown> {
  return {
    type: 'input',
    block_id: `ask_${id}`,
    optional: true,
    label: plain(`${id}. ${item.prompt}`, BK_LIMIT.inputLabel),
    element: {
      type: 'static_select',
      action_id: `ask_${id}`,
      placeholder: plain('选择…'),
      options: [
        ...item.options.slice(0, 10).map((o) => option(`${o.recommended ? '★ ' : ''}${o.label}`, o.label)),
        option('其他（在下方补充说明里填）', '__other__'),
      ],
    },
    ...(item.hint ? { hint: plain(`建议：${item.hint}`, BK_LIMIT.inputLabel) } : {}),
  };
}

export interface DecisionModalOpts {
  items: DecisionItem[];
  verdict?: boolean;
  submitText: string;
  notesLabel: string;
  notesPlaceholder: string;
  title?: string;
}

// 决策模态（闸A PM 答复 / 闸B M 拍板）。
export function buildDecisionModal(ctx: ModalContext, o: DecisionModalOpts): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = answerableDecisions(o.items.slice(0, DECISION_CAP)).map(({ id, item }) => askBlock(id, item));
  if (o.verdict) {
    blocks.push({
      type: 'input',
      block_id: 'verdict',
      optional: true,
      label: plain('整体结论', BK_LIMIT.inputLabel),
      element: {
        type: 'static_select',
        action_id: 'verdict',
        placeholder: plain('整体结论…'),
        options: [option('✅ 采纳建议，确认通过', 'accept'), option('📝 部分采纳（见逐条/补充）', 'partial')],
      },
    });
  }
  blocks.push({
    type: 'input',
    block_id: 'notes',
    optional: true,
    label: plain(o.notesLabel, BK_LIMIT.inputLabel),
    element: { type: 'plain_text_input', action_id: 'notes', multiline: true, placeholder: plain(o.notesPlaceholder) },
  });
  return view(ctx, o.title ?? '需求评审', o.submitText, blocks);
}

// 立项模态（M 选 DRI）。
// pool 为空 = 降级路径（守护重启后表单内容已不在内存里）→ 退成自由文本框，人照样填得了短码；
// 短码合不合法本来就有 go 那侧的名单闸兜着，这里绝不因为拿不到池子就让按钮点了没反应。
export function buildGoModal(ctx: ModalContext, pool: string[], picked: string | null): Record<string, unknown> {
  const element = pool.length
    ? {
        type: 'static_select',
        action_id: 'assignee',
        placeholder: plain('指派 DRI…'),
        options: pool.map((c) => option(c, c)),
        ...(picked && pool.includes(picked) ? { initial_option: option(picked, picked) } : {}),
      }
    : { type: 'plain_text_input', action_id: 'assignee', placeholder: plain('填 DRI 短码，如 M') };
  return view(ctx, '立项 · 建需求', '✅ 立项 · 建需求', [
    { type: 'input', block_id: 'assignee', optional: true, label: plain('指派 DRI', BK_LIMIT.inputLabel), element },
  ]);
}

function view(ctx: ModalContext, title: string, submitText: string, blocks: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: 'forge_form',
    // 上下文的唯一载体：view_submission 里没有原卡片，全靠它把 {action,slug,round} 带回来。
    private_metadata: JSON.stringify({ action: ctx.action, slug: ctx.slug, round: ctx.round ?? 0 }),
    title: chip(title, '需求评审'),
    submit: chip(submitText, '提交'),
    close: chip('取消', '取消'),
    blocks: blocks.length ? blocks : [{ type: 'section', text: mrkdwnEl('（没有待填项）') }],
  };
}

// ── view_submission → 扁平的 formValues ──────────────────────────────
// Slack 的 state.values 是 { [block_id]: { [action_id]: {type, value|selected_option} } } 两层嵌套。
// 核心只认扁平的 Record<string,string>（ask_*/verdict/notes/assignee），这里拍平。
// 未选/留空的项**不出现**在结果里——绝不填一个空串，否则 composeDecisionAnswer 会把"没答"写成"答了空"。
export function flattenStateValues(state: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const values = (state as { values?: Record<string, Record<string, unknown>> } | undefined)?.values;
  if (!values) return out;
  for (const actions of Object.values(values)) {
    for (const [actionId, el] of Object.entries(actions ?? {})) {
      const e = el as { value?: unknown; selected_option?: { value?: unknown } };
      const picked = typeof e?.selected_option?.value === 'string' ? e.selected_option.value : undefined;
      const typed = typeof e?.value === 'string' ? e.value : undefined;
      const v = picked ?? typed;
      if (v !== undefined && v !== '') out[actionId] = v;
    }
  }
  return out;
}

export interface ParsedSubmission {
  action: string;
  slug: string;
  round: number;
  formValues: Record<string, string>;
}

// 解析一条 view_submission 载荷。private_metadata 坏/缺 → null（认不出就是认不出，绝不猜一个 slug）。
export function parseViewSubmission(payload: Record<string, unknown>): ParsedSubmission | null {
  const view = payload.view as { private_metadata?: unknown; state?: unknown } | undefined;
  if (!view) return null;
  let meta: { action?: unknown; slug?: unknown; round?: unknown };
  try {
    meta = JSON.parse(String(view.private_metadata ?? '')) as typeof meta;
  } catch {
    return null;
  }
  const action = typeof meta?.action === 'string' ? meta.action : '';
  const slug = typeof meta?.slug === 'string' ? meta.slug : '';
  if (!action || !slug) return null;
  return { action, slug, round: Number(meta?.round) || 0, formValues: flattenStateValues(view.state) };
}
