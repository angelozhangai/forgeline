import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCard, buildStatusCard } from '../src/notify.ts';
import { renderFeishuCard } from '../src/messaging/feishu.ts';
import type { CardModel } from '../src/messaging/model.ts';
import type { Session } from '../src/types.ts';

// 写一个临时 gate-a.json，供「群卡读 open_questions」的渲染测试用。
function gateAFile(openQuestions: unknown[]): string {
  const p = join(mkdtempSync(join(tmpdir(), 'forge-notify-')), 'gate-a.json');
  writeFileSync(p, JSON.stringify({ summary: 's', open_questions: openQuestions, risks: [] }));
  return p;
}

// 卡片即「按钮回调契约」：daemon 靠 button.behaviors[].value.{action,slug} 派发，必须正确带上。
function sess(p: Partial<Session>): Session {
  return { id: 'id1', slug: 'finance-report', title: 't', state: 'AWAITING_GO', branch: 'dev', gate_a_output_path: null, routing: null, adversarial_residual: null, gate_a_cost_usd: 1, gate_b_cost_usd: 2, confirmed_by: null, confirmed_notes: null, error: null, prd_url: null, ...p } as unknown as Session;
}
// buildCard/buildStatusCard 现产 provider 无关 CardModel；断言走渲染管线 → 守飞书 JSON 不变。
const json = (c: CardModel) => JSON.stringify(renderFeishuCard(c));

test('needs_confirm：含 verdict/notes 表单 + confirm_submit 回调 + slug', () => {
  const s = sess({ routing: JSON.stringify({ reviewer: 'M', toLead: true, reasons: ['敏感域'], confidence: 0.78 }) });
  const c = json(buildCard('needs_confirm', s));
  assert.match(c, /"schema":"2\.0"/);
  assert.match(c, /"name":"verdict"/);
  assert.match(c, /"name":"notes"/);
  assert.match(c, /"action":"confirm_submit"/);
  assert.match(c, /finance-report/);
});

test('needs_go：放行=go、驳回=deny 两个回调按钮，均带 slug', () => {
  const c = json(buildCard('needs_go', sess({})));
  assert.match(c, /"action":"go"/);
  assert.match(c, /"action":"deny"/);
  assert.match(c, /"slug":"finance-report"/);
});

test('needs_go：含 DRI 指派下拉（go_form），有推荐时默认选推荐人并展示负载理由', () => {
  const snapshot = JSON.stringify({
    pick: 'EO',
    allOverWip: false,
    probeIncomplete: false,
    points: 3,
    table: [
      { code: 'EO', wip: 1, loadPoints: 3, projected: 6, wipLimit: 3, eligible: true },
      { code: 'CC', wip: 0, loadPoints: 8, projected: 11, wipLimit: 3, eligible: true },
    ],
  });
  const c = json(buildCard('needs_go', sess({ assignee: 'EO', assign_snapshot: snapshot } as Partial<Session>)));
  assert.match(c, /"name":"assignee"/); // DRI 下拉
  assert.match(c, /"initial_option":"EO"/); // 默认采纳推荐人
  assert.match(c, /建议 DRI：EO/); // 推荐理由块
  assert.match(c, /"action":"go"/); // 提交仍回调 go
});

test('needs_go：自动推荐失败时不默认旧人，提示 M 必须手动选择 DRI', () => {
  const snapshot = JSON.stringify({
    pick: null,
    allOverWip: false,
    probeIncomplete: true,
    points: 3,
    table: [
      { code: 'M', wip: 0, loadPoints: 0, projected: 3, wipLimit: 2, eligible: true, ok: false },
      { code: 'EO', wip: 0, loadPoints: 0, projected: 3, wipLimit: 3, eligible: true, ok: false },
    ],
  });
  const c = json(buildCard('needs_go', sess({ assignee: null, assign_snapshot: snapshot } as Partial<Session>)));
  assert.match(c, /未算出推荐/);
  assert.match(c, /请手动选/);
  assert.match(c, /负载未知/);
  assert.doesNotMatch(c, /"initial_option"/); // 没有可靠推荐时，不能让旧默认人蒙混过关
});

test('needs_gateb：出技术方案=gateb 回调按钮', () => {
  const c = json(buildCard('needs_gateb', sess({ confirmed_by: 'M' })));
  assert.match(c, /"action":"gateb"/);
});

test('needs_arbitration：M 强制通过=force_confirm 回调 + 列残留开放问题 + slug', () => {
  const c = json(buildCard('needs_arbitration', sess({ state: 'GATE_A_STALLED', gate_a_round: 6, gate_a_residual: JSON.stringify({ round: 6, open_questions: [{ q: '计费口径未定', severity: 'high' }] }) } as never)));
  assert.match(c, /"action":"force_confirm"/);
  assert.match(c, /finance-report/);
  assert.match(c, /计费口径未定/);
});

test('needs_gateb_input：每问题=交互下拉(select_static, name=ask_<id>) + 选项含「其他」兜底 + notes + gateb_answer_submit 回调', () => {
  const c = json(buildCard('needs_gateb_input', sess({ state: 'AWAITING_GATE_B_INPUT', gate_b_human_asks: JSON.stringify([{ id: 'H1', question: '退款退到余额还是原路？', options: ['原路', '余额'], severity: 'high' }]) } as never)));
  assert.match(c, /"action":"gateb_answer_submit"/);
  assert.match(c, /退款退到余额还是原路/);
  assert.match(c, /"tag":"select_static"/); // 真·交互选择框
  assert.match(c, /"name":"ask_H1"/); // 按位置 H{n} 命名，回调同序拼回
  assert.match(c, /其他/); // 「其他·手填」兜底项
  assert.match(c, /"name":"notes"/); // 补充说明框
  assert.match(c, /finance-report/);
});

test('群卡 闸A（AWAITING_PM_CONFIRM）：逐条下拉(ask_H1) + ★推荐 + 整体结论 + 补充 + round 透传', () => {
  const path = gateAFile([
    { q: '充值的钱会过期吗？', severity: 'high', options: [{ label: '不过期', recommended: true, impact: '对用户友好' }, { label: '一年后过期', recommended: false, impact: '需到期提醒' }] },
  ]);
  const c = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_output_path: path, gate_a_round: 1, poster_id: 'ou_pm', chat_id: 'oc' } as never)));
  assert.match(c, /"name":"ask_H1"/); // 逐条交互下拉（不是只有全局 verdict）
  assert.match(c, /★/); // 推荐值标记
  assert.match(c, /充值的钱会过期吗/);
  assert.match(c, /"name":"verdict"/); // 整体结论保留
  assert.match(c, /"name":"notes"/); // 末尾全局补充框
  assert.match(c, /"action":"confirm_submit"/);
  assert.match(c, /"round":1/); // round 透传（防群卡原地编辑第2轮提交被去重吞掉）
});

test('群卡 闸A：8 个待拍板问题都能逐条选择，第 9 个不挤进卡片', () => {
  const path = gateAFile(
    Array.from({ length: 9 }, (_, i) => ({
      q: `业务问题${i + 1}`,
      severity: 'med',
      options: [{ label: `选项${i + 1}`, recommended: i === 7, impact: `影响${i + 1}` }],
    })),
  );
  const c = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_output_path: path, gate_a_round: 3, poster_id: 'ou_pm', chat_id: 'oc' } as never)));
  assert.match(c, /"name":"ask_H1"/);
  assert.match(c, /"name":"ask_H8"/);
  assert.doesNotMatch(c, /"name":"ask_H9"/);
  assert.match(c, /业务问题8/);
  assert.doesNotMatch(c, /业务问题9/);
  assert.match(c, /★ 选项8/);
  assert.match(c, /"round":3/);
});

test('私聊 闸B needs_gateb_input：选项展示 ★推荐 + 影响文案', () => {
  const asks = JSON.stringify([
    { id: 'H1', question: '退款退原路还是余额？', severity: 'high', options: [{ label: '原路', recommended: true, impact: '合规清晰' }, { label: '余额', recommended: false, impact: '快但有资金沉淀' }] },
  ]);
  const c = json(buildCard('needs_gateb_input', sess({ state: 'AWAITING_GATE_B_INPUT', gate_b_human_asks: asks, gate_b_round: 2 } as never)));
  assert.match(c, /★/);
  assert.match(c, /影响：合规清晰/);
  assert.match(c, /"name":"ask_H1"/);
  assert.match(c, /"round":2/);
});

test('needs_gateb_input：无 options 的问题 → 不出下拉（靠补充说明作答）', () => {
  const c = json(buildCard('needs_gateb_input', sess({ state: 'AWAITING_GATE_B_INPUT', gate_b_human_asks: JSON.stringify([{ id: 'H1', question: '请补充背景', options: [], severity: 'med' }]) } as never)));
  assert.doesNotMatch(c, /"tag":"select_static"/);
  assert.match(c, /"name":"notes"/);
  assert.match(c, /"action":"gateb_answer_submit"/);
});

test('needs_gateb_arbitration：强制立项=gateb_force_go、再修=gateb_send_back，列残留 + slug', () => {
  const c = json(buildCard('needs_gateb_arbitration', sess({ state: 'GATE_B_STALLED', adversarial_residual: JSON.stringify({ round: 3, used: 'codex', findings: [{ issue: '幂等键缺失', severity: 'high', where: 'acceptance' }] }) } as never)));
  assert.match(c, /"action":"gateb_force_go"/);
  assert.match(c, /"action":"gateb_send_back"/);
  assert.match(c, /幂等键缺失/);
  assert.match(c, /"slug":"finance-report"/);
});

test('群状态卡 闸B 新态：人话进度、不泄漏黑话、无交互按钮', () => {
  for (const st of ['AWAITING_GATE_B_INPUT', 'GATE_B_REVISION_REQUESTED', 'GATE_B_STALLED'] as const) {
    const c = json(buildStatusCard(sess({ state: st } as never)));
    assert.doesNotMatch(c, /闸A|闸B|GATE_|ADVERSARIAL/, `${st} 群卡泄漏黑话`);
    assert.doesNotMatch(c, /"behaviors"/, `${st} 群卡不应带交互按钮（M 决策走私聊）`);
  }
});

test('failed：retry 回调按钮 + 错误文案', () => {
  const c = json(buildCard('failed', sess({ error: '解析失败' }), { stage: '闸B', error: '解析失败' }));
  assert.match(c, /"action":"retry"/);
  assert.match(c, /解析失败/);
});

test('done：列出 issue 链接，无回调按钮', () => {
  const c = json(buildCard('done', sess({}), { issues: [{ repo: 'example-admin', number: 73, url: 'https://x/73' }] }));
  assert.match(c, /example-admin#73/);
  assert.doesNotMatch(c, /"behaviors"/); // 完成卡无交互按钮
});

test('needs_go：有残留时标注条数', () => {
  const c = json(buildCard('needs_go', sess({ adversarial_residual: JSON.stringify({ findings: [{ issue: 'a' }, { issue: 'b' }] }) })));
  assert.match(c, /2 条/);
});

// 群状态卡：回复 PM 那条、原地编辑的那张卡
test('群状态卡 待产品确认：@PM + 确认表单 + 人话状态，不泄漏黑话', () => {
  const c = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', poster_id: 'ou_pm', gate_a_output_path: null })));
  assert.match(c, /<at id=ou_pm>/); // 群里 @ 发 PRD 的产品
  assert.match(c, /"action":"confirm_submit"/); // 确认表单在群卡上
  assert.match(c, /待产品确认/);
  assert.doesNotMatch(c, /闸A|闸B|GATE_/);
});

test('群状态卡 待产品确认：PM 多轮时副标题 + 待拍板标题展示「第N轮」', () => {
  const c = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_round: 2, gate_a_output_path: null } as never)));
  assert.match(c, /第2轮/);
  assert.doesNotMatch(c, /闸A|GATE_/); // 仍不泄漏黑话
});

test('群状态卡 待产品确认：confirm_submit 按轮次带 round（去重键逐轮不同，第2轮起不再被 SDK 吞）', () => {
  const rv = (c: string) => c.match(/"action":"confirm_submit","round":(\d+)/)?.[1];
  const r1 = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_round: 1, gate_a_output_path: null } as never)));
  const r2 = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_round: 2, gate_a_output_path: null } as never)));
  assert.equal(rv(r1), '1');
  assert.equal(rv(r2), '2'); // 同一原地编辑卡、同一「提交」按钮，value.round 逐轮不同 → cardActionId 不同 → 不被去重
  assert.notEqual(rv(r1), rv(r2));
});

test('群状态卡 复评轮（第2轮起）：醒目红横幅，跟首轮一眼可辨', () => {
  const c = json(buildStatusCard(sess({ state: 'AWAITING_PM_CONFIRM', gate_a_round: 2, gate_a_output_path: null } as never)));
  assert.match(c, /复评第 2 轮/);
});

test('群状态卡 复评中：人话「依答复复评」、无残留表单按钮', () => {
  const c = json(buildStatusCard(sess({ state: 'GATE_A_REVISION_REQUESTED', gate_a_round: 2 } as never)));
  assert.match(c, /复评|答复/);
  assert.doesNotMatch(c, /"action":"confirm_submit"/);
});

test('群状态卡 运行态：人话进度、无交互按钮', () => {
  const c = json(buildStatusCard(sess({ state: 'GATE_A_RUNNING' })));
  assert.match(c, /评审中|对照代码/);
  assert.doesNotMatch(c, /"behaviors"/);
});

test('群状态卡 已立项：列出 issue', () => {
  const c = json(buildStatusCard(sess({ state: 'DONE' }), { issues: [{ repo: 'example-admin', number: 88, url: 'https://x/88' }] }));
  assert.match(c, /example-admin#88/);
});

// 彩蛋(需求宠物)：群卡藏 $ 换投喂/进化树；私聊(M)卡保留真实 $ 且带宠物。
test('群状态卡：藏成本($)、显示宠物彩蛋(进化树 + 投喂)', () => {
  const c = json(buildStatusCard(sess({ state: 'GATE_A_RUNNING' }))); // sess 成本 $3
  assert.doesNotMatch(c, /\$/); // 群里不露金额
  assert.match(c, /进化树/);
  assert.match(c, /投喂/);
});

test('私聊卡 needs_go：保留真实成本($) + 带宠物彩蛋', () => {
  const c = json(buildCard('needs_go', sess({}))); // sess 成本 $3
  assert.match(c, /\$/); // 私聊保留金额（你的预算账本）
  assert.match(c, /go/); // 动作按钮仍在
});

test('复杂度：群卡副标题 + 小字脚注都展示档位', () => {
  const c = json(buildStatusCard(sess({ state: 'GATE_A_RUNNING', size: 'L', size_source: 'ai' } as never)));
  assert.match(c, /复杂度 L/); // 副标题可见
  assert.match(c, /8pt/); // 脚注带分值（L=8，对齐主仓）
});

test('私聊卡 needs_confirm：复杂度作为统计字段', () => {
  const c = json(buildCard('needs_confirm', sess({ size: 'XL' } as never)));
  assert.match(c, /复杂度/);
  assert.match(c, /XL/);
});
