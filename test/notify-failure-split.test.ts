// 错误展示分流：出问题时群侧只见「处理中」、不露具体错误；具体错误私聊 M；bot 私聊失败也不外泄群 webhook。
process.env.FORGE_DB = ':memory:';
process.env.NOTIFY_DESKTOP = '0'; // 测试里别弹桌面通知
process.env.FORGE_FUN = '0'; // 关彩蛋，输出确定（不挂宠物动图）

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../src/types.ts';

const DRIFT_ERR = 'CODEX_CONTRACT_DRIFT: codex 输出缺信封事件：thread.started、turn.completed';

// 所有 mock 必须在首次 import notify.ts 之前声明（ESM 绑定在模块求值时定死）。
let postCardCalls = 0;
let sentBot = false;
// feishu.ts adapter 现静态 import botTenantToken/FEISHU_BASE/botOpenId(Cached)（port.probe + 群 @ 闸用）——mock 须补齐这些导出，否则 ESM 实例化即失败。
mock.module('../src/feishu/dm.ts', { namedExports: { sendBotCardObject: async () => sentBot, sendBotCard: async () => false, botTenantToken: async () => '', botOpenId: async () => null, botOpenIdCached: () => null, FEISHU_BASE: 'https://example.invalid' } });
mock.module('../src/feishu/group.ts', { namedExports: { replyCard: async () => null, patchCard: async () => true, sendCardToChat: async () => null } });
mock.module('../src/feishu/notify.ts', { namedExports: { postCard: async () => { postCardCalls++; return true; } } });

const { buildStatusCard, buildCard, notify } = await import('../src/notify.ts');
const { renderFeishuCard } = await import('../src/messaging/feishu.ts');
const json = (c: Parameters<typeof renderFeishuCard>[0]) => JSON.stringify(renderFeishuCard(c));

function sess(p: Partial<Session>): Session {
  return {
    id: 'id1', slug: 'finance-report', title: 't', state: 'GATE_B_FAILED', branch: 'dev',
    gate_a_output_path: null, routing: null, adversarial_residual: null, gate_a_cost_usd: 1, gate_b_cost_usd: 2,
    confirmed_by: null, confirmed_notes: null, error: DRIFT_ERR, prd_url: null, chat_id: null,
    ...p,
  } as unknown as Session;
}

// ── 纯渲染：群卡藏错、私聊露错 ──────────────────────────────────────
test('群状态卡 *_FAILED：只显示「处理中」，绝不含具体错误，头部不报红', () => {
  for (const st of ['GATE_A_FAILED', 'GATE_B_FAILED', 'WRITE_FAILED'] as const) {
    const c = json(buildStatusCard(sess({ state: st })));
    assert.doesNotMatch(c, /CONTRACT_DRIFT|thread\.started|信封|出错|失败|处理中断/, `${st} 群卡泄漏了错误`);
    assert.doesNotMatch(c, /"template":"red"/, `${st} 群卡不该报红`);
    assert.match(c, /处理中|正在/, `${st} 群卡应显示进行中文案`);
    assert.doesNotMatch(c, /闸A|闸B|GATE_/, `${st} 群卡泄漏黑话`);
  }
});

test('私聊(M)卡 failed：保留具体错误 + 重试按钮', () => {
  const c = json(buildCard('failed', sess({}), { error: DRIFT_ERR }));
  assert.match(c, /CONTRACT_DRIFT/); // M 拿到真因
  assert.match(c, /"action":"retry"/);
});

// ── notify()：bot 私聊失败时，failed/recovered 不外泄群 webhook ──────
test('notify failed：bot 私聊失败 → 不调用 postCard（不外泄群 webhook）', async () => {
  postCardCalls = 0;
  sentBot = false; // bot 私聊失败
  await notify('failed', sess({}), { error: DRIFT_ERR });
  assert.equal(postCardCalls, 0, 'failed 时 bot 失败也绝不外泄群 webhook');
});

test('notify recovered：bot 私聊失败 → 同样不外泄群 webhook', async () => {
  postCardCalls = 0;
  sentBot = false;
  await notify('recovered', sess({ state: 'GATE_B_FAILED' }), { from: 'GATE_B_FAILED', to: 'ADVERSARIAL_LOOP' });
  assert.equal(postCardCalls, 0);
});

test('notify needs_go（对照组）：bot 私聊失败 → 仍走 postCard 群兜底（非错误类不变）', async () => {
  postCardCalls = 0;
  sentBot = false;
  await notify('needs_go', sess({ state: 'AWAITING_GO' }));
  assert.equal(postCardCalls, 1, 'M 决策类卡保留 webhook 兜底');
});
