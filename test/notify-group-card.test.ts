// Unit tests for how the channel status card is **delivered** (notify.ts syncGroupCard). No network at all --
// both the port and the store are replaced.
//
// What this pins is a rule that only shows itself in a real channel: **the card must never vanish just
// because it could not be threaded under the original message.** The status card is the requirement's only
// visible feedback in the channel, and the intake message can stop being repliable at any time -- deleted,
// too old, or an id recorded during backfill that already spans a restart. If a failed reply did not fall
// back to posting into the channel, the requirement would be silent from end to end, and status_msg_id would
// stay empty -- so every later sync would walk the same failing path and never recover on its own.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CardModel } from '../src/messaging/model.ts';
import type { Session } from '../src/types.ts';

// -- A fake port implementing only the three channel-card exits; nothing else is ever called here --
let replyResult: string | null = 'reply-card-id';
let sendResult: string | null = 'group-card-id';
const replies: { messageId: string; card: CardModel }[] = [];
const sends: { chatId: string; card: CardModel }[] = [];
const edits: { messageId: string; card: CardModel }[] = [];
const fakePort = {
  id: 'fake',
  async replyGroupCard(messageId: string, card: CardModel) {
    replies.push({ messageId, card });
    return replyResult;
  },
  async sendGroupCard(chatId: string, card: CardModel) {
    sends.push({ chatId, card });
    return sendResult;
  },
  async editGroupCard(messageId: string, card: CardModel) {
    edits.push({ messageId, card });
    return true;
  },
};

// -- A fake store: get reads the latest state back (syncGroupCard uses it to avoid re-sending something
// stale), and patch records what was written --
let current: Session | null = null;
const patches: { id: string; fields: Partial<Session> }[] = [];
const fakeStore = {
  get: async () => current,
  patch: async (id: string, fields: Partial<Session>) => {
    patches.push({ id, fields });
    return { ...(current as Session), ...fields };
  },
};

mock.module('../src/messaging/index.ts', { namedExports: { port: fakePort } });
mock.module('../src/store/index.ts', { namedExports: { store: fakeStore } });

const { syncGroupCard } = await import('../src/notify.ts');

function sess(p: Partial<Session>): Session {
  return {
    id: 'id1', slug: 'finance-report', title: 't', state: 'AWAITING_GO', branch: 'dev',
    gate_a_output_path: null, routing: null, adversarial_residual: null,
    gate_a_cost_usd: 0, gate_b_cost_usd: 0, confirmed_by: null, confirmed_notes: null,
    error: null, prd_url: null, chat_id: 'oc_1', poster_id: null, intake_msg_id: null, status_msg_id: null,
    ...p,
  } as unknown as Session;
}

function reset(): void {
  replyResult = 'reply-card-id';
  sendResult = 'group-card-id';
  replies.length = 0;
  sends.length = 0;
  edits.length = 0;
  patches.length = 0;
}

test('the channel status card: with an intake message id it threads under product\'s message, and the card id is stored in status_msg_id', async () => {
  reset();
  current = sess({ intake_msg_id: 'om_pm' });
  await syncGroupCard(current);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].messageId, 'om_pm');
  assert.equal(sends.length, 0, 'a successful reply should not also post a second card into the channel');
  assert.deepEqual(patches, [{ id: 'id1', fields: { status_msg_id: 'reply-card-id' } }]);
});

test('the channel status card: with no intake message id -- added by hand, or backfill never captured one -- it posts straight into the channel', async () => {
  reset();
  current = sess({ intake_msg_id: null });
  await syncGroupCard(current);
  assert.equal(replies.length, 0);
  assert.deepEqual(sends.map((s) => s.chatId), ['oc_1']);
  assert.deepEqual(patches, [{ id: 'id1', fields: { status_msg_id: 'group-card-id' } }]);
});

test('the channel status card: when the intake message cannot be replied to (deleted or expired) it falls back to posting into the channel, and the card is not lost', async () => {
  reset();
  replyResult = null; // the adapter reports the reply failed
  current = sess({ intake_msg_id: 'om_gone' });
  await syncGroupCard(current);
  assert.equal(replies.length, 1, 'it tries the reply first');
  assert.deepEqual(sends.map((s) => s.chatId), ['oc_1'], 'a failed reply has to fall back to posting into the channel rather than dropping the card');
  // What is stored is the channel card's id, so the next sync edits it in place and never walks the failing
  // reply path again.
  assert.deepEqual(patches, [{ id: 'id1', fields: { status_msg_id: 'group-card-id' } }]);
});

test('the channel status card: when both the reply and the channel post fail, status_msg_id is not written and nothing throws -- the flow carries on', async () => {
  reset();
  replyResult = null;
  sendResult = null;
  current = sess({ intake_msg_id: 'om_gone' });
  await syncGroupCard(current);
  assert.equal(patches.length, 0, 'nothing was delivered, so status_msg_id must not be recorded -- otherwise every later in-place edit targets an id that is not there');
});

test('the channel status card: with a status_msg_id already there it edits that same card in place rather than posting a new one', async () => {
  reset();
  current = sess({ intake_msg_id: 'om_pm', status_msg_id: 'card_1' });
  await syncGroupCard(current);
  assert.deepEqual(edits.map((e) => e.messageId), ['card_1']);
  assert.equal(replies.length + sends.length, 0);
  assert.equal(patches.length, 0);
});

test('the channel status card: a requirement that did not come from a channel (no chat_id) posts nothing at all', async () => {
  reset();
  current = sess({ chat_id: null });
  await syncGroupCard(current);
  assert.equal(replies.length + sends.length + edits.length, 0);
});
