// 飞书 adapter renderer + 入站解析的「契约级」单测：每个 CardBlock → 精确飞书 2.0 JSON。
// 这是传输层薄缝的回归底座——CardModel 语义块的渲染形状被钉死，未来改 model 不会静默漂移飞书 JSON。
process.env.FORGE_FUN = '0'; // 关彩蛋：petRow 不挂动图，渲染确定（无 image_key 依赖）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardModel, CardBlock } from '../src/messaging/model.ts';
import type { DecisionItem } from '../src/gates/envelopes.ts';
// 动态 import：保证 FORGE_FUN=0 在 feishu.ts→util/pet.ts 模块求值前生效（静态 import 会被 ESM 提升到设 env 之前）。
const { renderFeishuCard, feishuPort } = await import('../src/messaging/feishu.ts');
const { __setBotOpenIdCacheForTest } = await import('../src/feishu/dm.ts');
// 群消息入口闸判 @ 用：钉死 bot open_id，parseMessage 同步可比对（绕开 env 文件键 + bot/v3/info 请求）。
__setBotOpenIdCacheForTest('ou_bot');

// 把单个块塞进最小卡片，取 body.elements 出来断言。
function els(block: CardBlock): unknown[] {
  const card: CardModel = { color: 'grey', title: 't', blocks: [block] };
  return (renderFeishuCard(card).body as { elements: unknown[] }).elements;
}
const one = (block: CardBlock): unknown => els(block)[0];

test('envelope：color→template、title、subtitle 仅非空时出 key', () => {
  const withSub = renderFeishuCard({ color: 'red', title: 'T', subtitle: 'S', blocks: [] });
  assert.deepEqual(withSub, {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text', content: 'T' }, subtitle: { tag: 'plain_text', content: 'S' } },
    body: { elements: [] },
  });
  const noSub = renderFeishuCard({ color: 'blue', title: 'T', blocks: [] }) as { header: Record<string, unknown> };
  assert.equal('subtitle' in noSub.header, false); // 空副标题不出 key
});

test('text / note / footnote / quote：散文块的精确包裹', () => {
  assert.deepEqual(one({ kind: 'text', md: 'hello' }), { tag: 'markdown', content: 'hello' });
  assert.deepEqual(one({ kind: 'note', md: '灰字' }), { tag: 'markdown', content: "<font color='grey'>灰字</font>" });
  assert.deepEqual(one({ kind: 'footnote', md: '脚注' }), { tag: 'markdown', text_size: 'notation', content: "<font color='grey'>脚注</font>" });
  // quote 折叠内部换行/空白成单行
  assert.deepEqual(one({ kind: 'quote', text: '一段\n  概述  ' }), { tag: 'markdown', content: '> 一段 概述' });
});

test('callout：语义色调整段包裹（danger→red），核心不再持有 <font>', () => {
  assert.deepEqual(one({ kind: 'callout', tone: 'danger', md: '🔁 **复评第 2 轮** — 注意' }), { tag: 'markdown', content: "<font color='red'>🔁 **复评第 2 轮** — 注意</font>" });
  assert.match(JSON.stringify(one({ kind: 'callout', tone: 'warning', md: 'x' })), /<font color='orange'>x<\/font>/);
  assert.match(JSON.stringify(one({ kind: 'callout', tone: 'info', md: 'x' })), /<font color='blue'>x<\/font>/);
});

test('divider → hr；stats → column_set(weighted field 列)', () => {
  assert.deepEqual(one({ kind: 'divider' }), { tag: 'hr' });
  assert.deepEqual(one({ kind: 'stats', fields: ['**A**\n1', '**B**\n2'] }), {
    tag: 'column_set',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**A**\n1' }] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**B**\n2' }] },
    ],
  });
});

test('button：callback 按钮，value={action,slug,...extra}（顺序固定）', () => {
  assert.deepEqual(one({ kind: 'button', button: { text: '重试', style: 'primary', action: 'retry', slug: 'foo' } }), {
    tag: 'button',
    text: { tag: 'plain_text', content: '重试' },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { action: 'retry', slug: 'foo' } }],
  });
  // 带透传 value（如 round）
  const b = one({ kind: 'button', button: { text: '再修', style: 'default', action: 'gateb_send_back', slug: 'foo', value: { round: 3 } } });
  assert.equal(JSON.stringify(b).includes('"value":{"action":"gateb_send_back","slug":"foo","round":3}'), true);
});

test('buttonRow → column_set，每按钮独占 weighted 列', () => {
  const row = one({
    kind: 'buttonRow',
    buttons: [
      { text: 'A', style: 'primary', action: 'go', slug: 's' },
      { text: 'B', style: 'default', action: 'no', slug: 's' },
    ],
  }) as { tag: string; columns: { elements: { type: string }[] }[] };
  assert.equal(row.tag, 'column_set');
  assert.equal(row.columns.length, 2);
  assert.equal(row.columns[0].elements[0].type, 'primary');
  assert.equal(row.columns[1].elements[0].type, 'default');
});

const di = (prompt: string, options: DecisionItem['options'], severity = 'med', hint = ''): DecisionItem => ({ prompt, options, severity, hint });

test('decisionList：逐条 markdown，★标推荐 + 影响副文案 + 严重度上色 + 副提示', () => {
  const items = [di('要不要过期？', [{ label: '不过期', recommended: true, impact: '对用户友好' }, { label: '一年', recommended: false, impact: '' }], 'high', '倾向不过期')];
  const md = JSON.stringify(els({ kind: 'decisionList', items }));
  assert.match(md, /\*\*1\.\*\*/);
  assert.match(md, /<font color='red'>\[high\]<\/font>/); // 严重度上色在 adapter
  assert.match(md, /★ 不过期（影响：对用户友好）/);
  assert.match(md, /<font color='grey'>建议：倾向不过期<\/font>/);
});

test('findingList：编号 + 严重度标签 + 位置/建议灰字副行（缺则省略）', () => {
  const out = JSON.stringify(
    els({ kind: 'findingList', findings: [
      { severity: 'high', lead: '幂等键缺失', notes: [{ label: '位置', text: 'acceptance' }, { label: '建议', text: '加唯一键' }] },
      { severity: 'low', lead: '命名小问题' }, // 无 notes
    ] }),
  );
  assert.match(out, /\*\*1\.\*\* <font color='red'>\[high\]<\/font> 幂等键缺失/);
  assert.match(out, /<font color='grey'>位置：acceptance<\/font>/);
  assert.match(out, /<font color='grey'>建议：加唯一键<\/font>/);
  assert.match(out, /\*\*2\.\*\* <font color='grey'>\[low\]<\/font> 命名小问题/);
  assert.doesNotMatch(out, /\*\*2\.\*\*[\s\S]*位置/); // 第2条无副行（[\s\S]=任意字符含换行）
});

test('decisionForm：每条 select_static(ask_H{n}) + 「其他」兜底 + verdict + notes + submit(value 顺序 action,round,slug)', () => {
  const items = [di('Q1', [{ label: '甲', recommended: true, impact: '' }]), di('Q2', [{ label: '乙', recommended: false, impact: '' }])];
  const form = one({ kind: 'decisionForm', slug: 'foo', items, action: 'confirm_submit', round: 2, verdict: true, submitText: '提交', notesLabel: '补充', notesPlaceholder: 'ph' });
  const s = JSON.stringify(form);
  assert.match(s, /"name":"ask_H1"/);
  assert.match(s, /"name":"ask_H2"/);
  assert.match(s, /"value":"__other__"/); // 「其他」兜底项
  assert.match(s, /"name":"verdict"/);
  assert.match(s, /"name":"notes"/);
  assert.match(s, /"value":\{"action":"confirm_submit","round":2,"slug":"foo"\}/); // round 透传 + 顺序钉死（防 SDK 去重吞）
});

test('decisionForm：verdict=false 时无整体结论下拉；无选项的项不出 select', () => {
  const items = [di('无选项问题', [])];
  const s = JSON.stringify(one({ kind: 'decisionForm', slug: 'foo', items, action: 'gateb_answer_submit', round: 0, submitText: '提交', notesLabel: 'L', notesPlaceholder: 'P' }));
  assert.doesNotMatch(s, /"name":"verdict"/);
  assert.doesNotMatch(s, /"tag":"select_static"/); // 无选项 → 无下拉
  assert.match(s, /"name":"notes"/);
});

test('goForm：DRI 下拉（含推荐人 initial_option）+ go submit', () => {
  const withPick = JSON.stringify(one({ kind: 'goForm', slug: 'foo', pool: ['EO', 'CC'], picked: 'EO' }));
  assert.match(withPick, /"initial_option":"EO"/);
  assert.match(withPick, /"value":\{"action":"go","slug":"foo"\}/);
  // picked 不在池里 → 不出 initial_option（不让旧人蒙混）
  assert.doesNotMatch(JSON.stringify(one({ kind: 'goForm', slug: 'foo', pool: ['EO'], picked: 'ZZ' })), /"initial_option"/);
});

test('petRow：mentionId 设 → 前缀 <at>；FUN 关闭时退化为纯 markdown 文字', () => {
  // FORGE_FUN=0 → 无动图，petRow 退化成 md(content)
  assert.deepEqual(one({ kind: 'petRow', asset: 'egg', voice: '在评审…' }), { tag: 'markdown', content: '在评审…' });
  assert.deepEqual(one({ kind: 'petRow', asset: 'egg', voice: '待你拍板', mentionId: 'ou_pm' }), { tag: 'markdown', content: '<at id=ou_pm></at> 待你拍板' });
});

// ── 入站解析 ─────────────────────────────────────────────────────────
test('parseCardAction：挖 action/slug/value + form_value；缺 action/slug → null', () => {
  const raw = {
    action: { value: { action: 'confirm_submit', slug: 'foo', round: 1 } },
    raw: { event: { action: { form_value: { verdict: 'accept', notes: 'x', ask_H1: '甲' } }, operator: { open_id: 'ou_m' } } },
  };
  const a = feishuPort.parseCardAction(raw);
  assert.ok(a);
  assert.equal(a.action, 'confirm_submit');
  assert.equal(a.slug, 'foo');
  assert.deepEqual(a.value, { action: 'confirm_submit', slug: 'foo', round: 1 });
  assert.deepEqual(a.formValues, { verdict: 'accept', notes: 'x', ask_H1: '甲' });
  assert.equal(a.operatorId, 'ou_m');
  // 缺 slug → 不识别
  assert.equal(feishuPort.parseCardAction({ action: { value: { action: 'go' } } }), null);
  assert.equal(feishuPort.parseCardAction({}), null);
});

test('parseMessage：纯文本取 message.content.text；searchTexts 兜底整事件（保住富文本/分享卡抽链）', () => {
  // 富文本 / 文档分享卡：纯 text 抽不到链接，但链接藏在事件 JSON 里 → searchTexts 仍带出来
  const shareUrl = 'https://x.feishu.cn/docx/abc123';
  const raw = {
    chatId: 'oc_1',
    senderId: 'ou_pm',
    messageId: 'om_1',
    createTime: '1700000000000',
    text: '',
    raw: { event: { message: { content: JSON.stringify({ title: '需求', href: shareUrl }) } } },
  };
  const m = feishuPort.parseMessage(raw);
  assert.ok(m);
  assert.equal(m.chatId, 'oc_1');
  assert.equal(m.senderId, 'ou_pm');
  assert.equal(m.messageId, 'om_1');
  assert.equal(m.createTime, 1700000000000);
  assert.equal(Array.isArray(m.searchTexts), true);
  assert.equal(m.searchTexts![0].includes(shareUrl), true); // 分享卡链接落在候选里，核心可抽
});

test('parseMessage：纯文本 URL → text 直接带出', () => {
  const m = feishuPort.parseMessage({ chatId: 'oc', text: '看下 https://x.feishu.cn/docx/zzz', createTime: 1 });
  assert.ok(m);
  assert.match(m.text, /docx\/zzz/);
});

test('parseMessage：缺/坏 createTime → 兜 now()（不塞 0，避免水位插到 epoch 触发 backfill 重扫历史）', () => {
  const before = Date.now();
  const m = feishuPort.parseMessage({ chatId: 'oc', text: 'x' }); // 无 createTime
  const after = Date.now();
  assert.ok(m);
  assert.ok(m.createTime >= before && m.createTime <= after, `createTime=${m.createTime} 应落在调用前后窗口 [${before},${after}] 而非 0`);
  assert.notEqual(m.createTime, 0);
});

test('parseMessage：群消息 @ 了本机器人 → isGroup=true、mentionedBot=true（读服务端 mentions，不靠正文 normalize）', () => {
  const m = feishuPort.parseMessage({
    chatId: 'oc_g',
    text: '@机器人 看下这个需求 https://x.feishu.cn/docx/abc',
    createTime: 1,
    raw: { event: { message: { chat_type: 'group', mentions: [{ id: { open_id: 'ou_bot' } }] } } },
  });
  assert.ok(m);
  assert.equal(m.isGroup, true);
  assert.equal(m.mentionedBot, true);
});

test('parseMessage：群消息只 @ 了别人、没 @机器人 → mentionedBot=false（核心据此忽略）', () => {
  const m = feishuPort.parseMessage({
    chatId: 'oc_g',
    text: '随手分享 https://x.feishu.cn/docx/abc',
    createTime: 1,
    raw: { event: { message: { chat_type: 'group', mentions: [{ id: { open_id: 'ou_other' } }] } } },
  });
  assert.ok(m);
  assert.equal(m.isGroup, true);
  assert.equal(m.mentionedBot, false);
});

test('parseMessage：p2p 私聊 → isGroup=false（核心不要求 @ 即可入流程）', () => {
  const m = feishuPort.parseMessage({
    chatId: 'oc_p',
    text: '私聊发需求 https://x.feishu.cn/docx/abc',
    createTime: 1,
    raw: { event: { message: { chat_type: 'p2p' } } },
  });
  assert.ok(m);
  assert.equal(m.isGroup, false);
});
