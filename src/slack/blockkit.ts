// Slack provider 层——**Block Kit 的结构约束**：上限表 + 一个校验器。
//
// 为什么值得单独写一个校验器：Slack 拒绝一条消息/一个模态时，回的是 `ok:false, error:"invalid_blocks"`
// ——**不告诉你是哪一块、哪个字段、超了多少**。人看到的症状是"卡片没出现"或"按钮点了没反应"，
// 而日志里只有一行 warn。这是本仓明令要消灭的形态（没有任何症状指向真正的原因）。
//
// 于是这份文件承担两件事：
//   ① 上限表是**唯一真源**：渲染那侧（slack/text.ts + messaging/slack.ts + slack/modal.ts）按它封顶；
//   ② 校验器在**两处**被用到——
//      · 单测里对着"Forge 能发出的每一种卡片/模态"跑一遍，把这类只在真工作区才现形的坑搬到 CI 里；
//      · 运行时**只在 Slack 已经说不行之后**跑一遍，把 invalid_blocks 翻译成"第 3 块 section.text 是空的"。
//        happy path 一次都不跑，所以它不是热路径上的负担。
//
// 数字取自 Slack 官方 Block Kit 参考。它们是 Slack 的规格，不是我们的偏好——改动只应因为 Slack 改了。
export const BK_LIMIT = {
  blocksPerMessage: 50,
  blocksPerView: 100,
  headerText: 150,
  sectionText: 3000,
  contextText: 3000,
  contextElements: 10,
  fieldText: 2000,
  fieldsPerSection: 10,
  buttonText: 75,
  buttonValue: 2000,
  actionId: 255,
  elementsPerActions: 25,
  optionText: 75,
  optionValue: 75,
  optionsPerSelect: 100,
  placeholder: 150,
  inputLabel: 2000,
  viewChip: 24, // title / submit / close
  privateMetadata: 3000,
  callbackId: 255,
} as const;

// 落单的代理对（把 emoji 从中间劈开的产物）。Slack 收到非法 UTF-16 会整条拒掉。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
const cp = (s: string): number => Array.from(s).length;

// 一个 {type:'plain_text'|'mrkdwn', text} 文本对象：非空、不超限、UTF-16 合法。
function checkText(where: string, v: unknown, max: number, out: string[], kinds = ['plain_text', 'mrkdwn']): void {
  const o = obj(v);
  if (!o) return void out.push(`${where}：缺文本对象`);
  if (typeof o.type !== 'string' || !kinds.includes(o.type)) out.push(`${where}：type 应为 ${kinds.join('/')}，实际 ${String(o.type)}`);
  const t = o.text;
  if (typeof t !== 'string') return void out.push(`${where}：text 不是字符串`);
  if (t === '') out.push(`${where}：text 为空（Slack 不接受空文本，整条载荷会被拒）`);
  if (cp(t) > max) out.push(`${where}：text 超上限（${cp(t)} > ${max}）`);
  if (LONE_SURROGATE.test(t)) out.push(`${where}：text 含落单的代理对（emoji 被截断成非法 UTF-16）`);
}

function checkOption(where: string, v: unknown, out: string[]): void {
  const o = obj(v);
  if (!o) return void out.push(`${where}：选项不是对象`);
  checkText(`${where}.text`, o.text, BK_LIMIT.optionText, out, ['plain_text']);
  if (typeof o.value !== 'string' || o.value === '') out.push(`${where}.value：缺/为空`);
  else if (cp(o.value) > BK_LIMIT.optionValue) out.push(`${where}.value：超上限（${cp(o.value)} > ${BK_LIMIT.optionValue}）`);
}

function checkElement(where: string, v: unknown, out: string[], actionIds: string[]): void {
  const e = obj(v);
  if (!e) return void out.push(`${where}：元素不是对象`);
  const id = e.action_id;
  if (typeof id === 'string') {
    if (cp(id) > BK_LIMIT.actionId) out.push(`${where}.action_id：超上限（${cp(id)} > ${BK_LIMIT.actionId}）`);
    actionIds.push(id);
  }
  if (e.placeholder !== undefined) checkText(`${where}.placeholder`, e.placeholder, BK_LIMIT.placeholder, out, ['plain_text']);
  switch (e.type) {
    case 'button': {
      checkText(`${where}.text`, e.text, BK_LIMIT.buttonText, out, ['plain_text']);
      const val = e.value;
      if (val !== undefined) {
        if (typeof val !== 'string' || val === '') out.push(`${where}.value：应为非空字符串`);
        else if (cp(val) > BK_LIMIT.buttonValue) out.push(`${where}.value：超上限（${cp(val)} > ${BK_LIMIT.buttonValue}）`);
      }
      // Slack 只认这两种 style，给别的（含 'default'）会整块报错。
      if (e.style !== undefined && e.style !== 'primary' && e.style !== 'danger') out.push(`${where}.style：只允许 primary/danger，实际 ${String(e.style)}`);
      break;
    }
    case 'static_select': {
      const opts = arr(e.options);
      if (!opts || opts.length === 0) out.push(`${where}.options：静态下拉必须至少一个选项`);
      else {
        if (opts.length > BK_LIMIT.optionsPerSelect) out.push(`${where}.options：超上限（${opts.length} > ${BK_LIMIT.optionsPerSelect}）`);
        for (const [i, o] of opts.entries()) checkOption(`${where}.options[${i}]`, o, out);
      }
      if (e.initial_option !== undefined) checkOption(`${where}.initial_option`, e.initial_option, out);
      break;
    }
    case 'plain_text_input':
      break;
    default:
      out.push(`${where}.type：本仓不该发出的元素类型 ${String(e.type)}`);
  }
}

function checkBlock(where: string, v: unknown, out: string[], actionIds: string[]): void {
  const b = obj(v);
  if (!b) return void out.push(`${where}：块不是对象`);
  switch (b.type) {
    case 'header':
      checkText(`${where}.text`, b.text, BK_LIMIT.headerText, out, ['plain_text']);
      break;
    case 'section': {
      const fields = arr(b.fields);
      if (b.text === undefined && fields === null) out.push(`${where}：section 既没有 text 也没有 fields`);
      if (b.text !== undefined) checkText(`${where}.text`, b.text, BK_LIMIT.sectionText, out);
      if (fields) {
        if (fields.length === 0) out.push(`${where}.fields：为空数组（要么给内容，要么别出这一块）`);
        if (fields.length > BK_LIMIT.fieldsPerSection) out.push(`${where}.fields：超上限（${fields.length} > ${BK_LIMIT.fieldsPerSection}）`);
        for (const [i, f] of fields.entries()) checkText(`${where}.fields[${i}]`, f, BK_LIMIT.fieldText, out);
      }
      break;
    }
    case 'context': {
      const els = arr(b.elements);
      if (!els || els.length === 0) out.push(`${where}.elements：为空`);
      else {
        if (els.length > BK_LIMIT.contextElements) out.push(`${where}.elements：超上限（${els.length} > ${BK_LIMIT.contextElements}）`);
        for (const [i, el] of els.entries()) checkText(`${where}.elements[${i}]`, el, BK_LIMIT.contextText, out);
      }
      break;
    }
    case 'actions': {
      const els = arr(b.elements);
      if (!els || els.length === 0) out.push(`${where}.elements：actions 块必须至少一个元素（空数组 = 整条消息被拒）`);
      else {
        if (els.length > BK_LIMIT.elementsPerActions) out.push(`${where}.elements：超上限（${els.length} > ${BK_LIMIT.elementsPerActions}）`);
        for (const [i, el] of els.entries()) checkElement(`${where}.elements[${i}]`, el, out, actionIds);
      }
      break;
    }
    case 'input': {
      checkText(`${where}.label`, b.label, BK_LIMIT.inputLabel, out, ['plain_text']);
      if (b.hint !== undefined) checkText(`${where}.hint`, b.hint, BK_LIMIT.inputLabel, out, ['plain_text']);
      if (typeof b.block_id === 'string' && b.block_id === '') out.push(`${where}.block_id：为空字符串`);
      if (b.element === undefined) out.push(`${where}.element：input 块缺 element`);
      else checkElement(`${where}.element`, b.element, out, actionIds);
      break;
    }
    case 'divider':
      break;
    default:
      out.push(`${where}.type：本仓不该发出的块类型 ${String(b.type)}`);
  }
}

// 校验一组块。返回违规说明；**空数组 = 结构上合法**（不代表 Slack 一定收，只代表这一类坑都不在了）。
export function validateBlocks(blocks: unknown, opts: { max?: number; where?: string } = {}): string[] {
  const max = opts.max ?? BK_LIMIT.blocksPerMessage;
  const where = opts.where ?? 'blocks';
  const out: string[] = [];
  const list = arr(blocks);
  if (!list) return [`${where}：不是数组`];
  if (list.length === 0) out.push(`${where}：为空（Slack 不接受空块列表）`);
  if (list.length > max) out.push(`${where}：块数超上限（${list.length} > ${max}）`);
  const actionIds: string[] = [];
  for (const [i, b] of list.entries()) checkBlock(`${where}[${i}]`, b, out, actionIds);
  // 同一条消息/模态里 action_id 必须唯一，否则 Slack 整条拒掉。
  const dup = actionIds.filter((id, i) => actionIds.indexOf(id) !== i);
  for (const id of [...new Set(dup)]) out.push(`${where}：action_id 重复「${id}」（同一条载荷里必须唯一）`);
  return out;
}

// 校验一条 chat.postMessage / chat.update 的 attachments（本仓的块都挂在 attachment 上——色条在那儿）。
export function validateAttachments(attachments: unknown): string[] {
  const list = arr(attachments);
  if (!list) return ['attachments：不是数组'];
  const out: string[] = [];
  for (const [i, a] of list.entries()) {
    const o = obj(a);
    if (!o) {
      out.push(`attachments[${i}]：不是对象`);
      continue;
    }
    if (typeof o.color === 'string' && !/^#[0-9a-fA-F]{6}$/.test(o.color)) out.push(`attachments[${i}].color：应为 #rrggbb，实际 ${o.color}`);
    out.push(...validateBlocks(o.blocks, { where: `attachments[${i}].blocks` }));
  }
  return out;
}

// 校验一个 views.open 的 view。模态多三样东西：标题三件套 24 上限、private_metadata、callback_id。
export function validateView(view: unknown): string[] {
  const v = obj(view);
  if (!v) return ['view：不是对象'];
  const out: string[] = [];
  if (v.type !== 'modal') out.push(`view.type：应为 modal，实际 ${String(v.type)}`);
  checkText('view.title', v.title, BK_LIMIT.viewChip, out, ['plain_text']);
  if (v.submit !== undefined) checkText('view.submit', v.submit, BK_LIMIT.viewChip, out, ['plain_text']);
  if (v.close !== undefined) checkText('view.close', v.close, BK_LIMIT.viewChip, out, ['plain_text']);
  if (v.private_metadata !== undefined) {
    if (typeof v.private_metadata !== 'string') out.push('view.private_metadata：不是字符串');
    else if (cp(v.private_metadata) > BK_LIMIT.privateMetadata) out.push(`view.private_metadata：超上限（${cp(v.private_metadata)} > ${BK_LIMIT.privateMetadata}）`);
  }
  if (typeof v.callback_id === 'string' && cp(v.callback_id) > BK_LIMIT.callbackId) out.push(`view.callback_id：超上限（${cp(v.callback_id)} > ${BK_LIMIT.callbackId}）`);
  out.push(...validateBlocks(v.blocks, { max: BK_LIMIT.blocksPerView, where: 'view.blocks' }));
  return out;
}

// 把校验结论压成一行可读的日志尾巴（Slack 只会说 invalid_blocks，这一行才是真正的定位信息）。
export function explain(problems: string[]): string {
  if (problems.length === 0) return '（结构自检没发现问题——多半是权限/频道/凭据，而不是载荷）';
  return `结构自检：${problems.slice(0, 5).join('；')}${problems.length > 5 ? `；…共 ${problems.length} 条` : ''}`;
}
