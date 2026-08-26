// `forge rehearse` sends the whole card corpus to a real workspace and prints what the buttons send back.
// The contract worth pinning is the part that decides whether a green rehearsal means anything:
//
//   1. **It really is every kind and every state.** The corpus enumerates NOTIFY_KINDS and STATES rather
//      than a hand-written list, so a kind added tomorrow is rehearsed tomorrow.
//   2. **The forms are not empty.** A decision card with no dropdowns would sail through the send and prove
//      nothing about the one thing only a real workspace can answer.
//   3. **Every card carries the rehearsal slug**, so a click can never be mistaken for — or land on — a real
//      requirement.
//   4. **A delivery failure is reported, never thrown**: the point is to find out which cards the provider
//      rejects, which means the run has to reach the end and tell you.
//   5. **A redelivered callback is called what it is** — the only way to observe a missed ack from outside.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sendCorpus, observeCallback, rehearsalSession, REHEARSAL_SLUG, type SendPort } from '../src/rehearse.ts';
import { NOTIFY_KINDS, buildCard } from '../src/notify.ts';
import { STATES } from '../src/statemachine/states.ts';
import type { CardModel } from '../src/messaging/model.ts';

function fakePort(o: { chats?: string[]; failDm?: (c: CardModel) => boolean } = {}): SendPort & { dms: CardModel[]; group: CardModel[] } {
  const dms: CardModel[] = [];
  const group: CardModel[] = [];
  return {
    dms,
    group,
    sendDmCard: (c) => {
      dms.push(c);
      return Promise.resolve(!o.failDm?.(c));
    },
    sendGroupCard: (_chat, c) => {
      group.push(c);
      return Promise.resolve('m1');
    },
    watchedChats: () => o.chats ?? ['C1'],
  };
}

describe('forge rehearse — the sending half', () => {
  test('covers every notify kind and every state, driven by the enumerations themselves', async () => {
    const p = fakePort();
    const r = await sendCorpus({ pauseMs: 0 }, p);
    assert.equal(p.dms.length, NOTIFY_KINDS.length);
    assert.equal(p.group.length, STATES.length);
    assert.equal(r.sent, NOTIFY_KINDS.length + STATES.length);
    assert.deepEqual(r.failed, []);
  });

  test('--only dm sends no channel card, and --only channel sends no direct message', async () => {
    const dmOnly = fakePort();
    await sendCorpus({ only: 'dm', pauseMs: 0 }, dmOnly);
    assert.equal(dmOnly.group.length, 0);
    assert.ok(dmOnly.dms.length > 0);

    const chOnly = fakePort();
    await sendCorpus({ only: 'channel', pauseMs: 0 }, chOnly);
    assert.equal(chOnly.dms.length, 0);
    assert.ok(chOnly.group.length > 0);
  });

  test('with no watched chat the channel half is skipped, not thrown — the direct messages still went out', async () => {
    const p = fakePort({ chats: [] });
    const r = await sendCorpus({ pauseMs: 0 }, p);
    assert.equal(p.group.length, 0);
    assert.equal(r.sent, NOTIFY_KINDS.length);
    assert.deepEqual(r.failed, []);
  });

  test('a rejected card is named in the report and the run carries on to the end', async () => {
    const p = fakePort({ failDm: (c) => c.title.includes('REHEARSAL') });
    const r = await sendCorpus({ only: 'dm', pauseMs: 0 }, p);
    assert.equal(p.dms.length, NOTIFY_KINDS.length); // it did not stop at the first failure
    assert.equal(r.failed.length, NOTIFY_KINDS.length);
    assert.ok(r.failed.every((f) => f.startsWith('dm:')));
  });

  test('the decision card really carries a form with its questions — an empty one would prove nothing', async () => {
    const p = fakePort();
    await sendCorpus({ only: 'dm', pauseMs: 0 }, p);
    const forms = p.dms.flatMap((c) => c.blocks.filter((b) => b.kind === 'decisionForm'));
    assert.ok(forms.length > 0, 'the corpus has to contain at least one decision form');
    const withItems = forms.filter((f) => 'items' in f && Array.isArray(f.items) && f.items.length > 0);
    assert.ok(withItems.length > 0, 'at least one form has to have real questions in it');
    const first = withItems[0] as { items: { options?: unknown[] }[] };
    assert.ok(first.items.some((i) => (i.options?.length ?? 0) > 1), 'a question with several options is what makes the modal show a dropdown');
  });

  test('every card is stamped with the rehearsal slug, so a click can never land on a real requirement', async () => {
    const p = fakePort();
    await sendCorpus({ pauseMs: 0 }, p);
    const slugs = [...p.dms, ...p.group]
      .flatMap((c) => c.blocks)
      .filter((b) => 'slug' in b)
      .map((b) => (b as { slug: string }).slug);
    assert.ok(slugs.length > 0);
    assert.deepEqual([...new Set(slugs)], [REHEARSAL_SLUG]);
  });
});

describe('forge rehearse — reading one callback', () => {
  const action = { action: 'confirm_submit', slug: REHEARSAL_SLUG, formValues: { ask_0: 'Option A' } };

  test('the first arrival is ordinary; the same callback again is a redelivery, which is what a missed ack looks like', () => {
    const seen = new Map<string, number>();
    const first = observeCallback(seen, action);
    assert.deepEqual({ count: first.count, duplicate: first.duplicate }, { count: 1, duplicate: false });
    const again = observeCallback(seen, action);
    assert.deepEqual({ count: again.count, duplicate: again.duplicate }, { count: 2, duplicate: true });
  });

  test('a different answer to the same button is a distinct callback, not a duplicate', () => {
    const seen = new Map<string, number>();
    observeCallback(seen, action);
    const other = observeCallback(seen, { ...action, formValues: { ask_0: 'Option B' } });
    assert.equal(other.duplicate, false);
  });

  test('a callback from a real card is flagged foreign — a rehearsal must never report it as its own result', () => {
    const seen = new Map<string, number>();
    assert.equal(observeCallback(seen, { ...action, slug: 'finance-report' }).foreign, true);
    assert.equal(observeCallback(seen, action).foreign, false);
  });
});

describe('forge rehearse — the fake session', () => {
  test('renders a card without touching the store, and never borrows a real slug', () => {
    const s = rehearsalSession(null, { state: 'AWAITING_GO' });
    assert.equal(s.slug, REHEARSAL_SLUG);
    const card = buildCard('needs_go', s);
    assert.ok(card.title.length > 0);
    assert.match(card.title + JSON.stringify(card.blocks), /REHEARSAL/);
  });
});
