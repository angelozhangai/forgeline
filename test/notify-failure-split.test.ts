// How errors are split by audience: when something breaks, the channel sees only "in progress" and never the
// specific error; the specific error goes to the maintainer by direct message; and a failed direct message
// still must not leak it to the channel webhook.
process.env.FORGE_DB = ':memory:';
process.env.NOTIFY_DESKTOP = '0'; // no desktop notifications during tests
process.env.FORGE_FUN = '0'; // turn the easter egg off so the output is deterministic (no pet animation)

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../src/types.ts';

const DRIFT_ERR = 'CODEX_CONTRACT_DRIFT: the codex output is missing the envelope events thread.started and turn.completed';

// Every mock has to be declared before notify.ts is first imported -- ESM bindings are fixed when the module
// is evaluated.
let postCardCalls = 0;
let sentBot = false;
// The feishu.ts adapter now statically imports botTenantToken / FEISHU_BASE / botOpenId(Cached), used by
// port.probe and the channel mention gate, so the mock has to carry those exports or ESM instantiation fails.
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

// -- Pure rendering: the channel card hides the error, the direct message shows it --
test('the channel status card in any *_FAILED state shows only that it is in progress, never the specific error, and does not turn the header red', () => {
  for (const st of ['GATE_A_FAILED', 'GATE_B_FAILED', 'WRITE_FAILED'] as const) {
    const c = json(buildStatusCard(sess({ state: st })));
    // `interrupted` is in stateLabel's own wording for these states, so this also catches a regression that
    // let the raw state label onto the channel card.
    assert.doesNotMatch(c, /CONTRACT_DRIFT|thread\.started|envelope|interrupted|error|failed/i, `the channel card for ${st} leaked the error`);
    assert.doesNotMatch(c, /"template":"red"/, `the channel card for ${st} should not turn red`);
    assert.match(c, /In progress|reviewing|designing|creating/, `the channel card for ${st} should read as still in progress`);
    assert.doesNotMatch(c, /Gate [ABCD]|GATE_/, `the channel card for ${st} leaks jargon`);
  }
});

test('the maintainer\'s direct-message card for failed keeps the specific error and the retry button', () => {
  const c = json(buildCard('failed', sess({}), { error: DRIFT_ERR }));
  assert.match(c, /CONTRACT_DRIFT/); // the maintainer gets the real cause
  assert.match(c, /"action":"retry"/);
});

// -- notify(): when the bot's direct message fails, failed and recovered still do not leak to the channel
// webhook --
test('notify failed: the bot\'s direct message fails -> postCard is never called, so nothing leaks to the channel webhook', async () => {
  postCardCalls = 0;
  sentBot = false; // the bot's direct message fails
  await notify('failed', sess({}), { error: DRIFT_ERR });
  assert.equal(postCardCalls, 0, 'even when the bot fails, a failure must never leak to the channel webhook');
});

test('notify recovered: the bot\'s direct message fails -> it does not leak to the channel webhook either', async () => {
  postCardCalls = 0;
  sentBot = false;
  await notify('recovered', sess({ state: 'GATE_B_FAILED' }), { from: 'GATE_B_FAILED', to: 'ADVERSARIAL_LOOP' });
  assert.equal(postCardCalls, 0);
});

test('notify needs_go (the control): the bot\'s direct message fails -> it still falls back to postCard in the channel, since this is not an error card', async () => {
  postCardCalls = 0;
  sentBot = false;
  await notify('needs_go', sess({ state: 'AWAITING_GO' }));
  assert.equal(postCardCalls, 1, "a card the maintainer decides on keeps its webhook fallback");
});
