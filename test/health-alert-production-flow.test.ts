// Unit and boundary: how health alerting behaves as a product. An alert is the maintainer's private
// operational information and may only go out as a direct message through MessagingPort; even if the bot
// fails it must not fall back to the channel webhook, which would leak local error detail into the team's
// channel.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CardModel } from '../src/messaging/model.ts';

const dmCards: CardModel[] = [];
let dmResult = true;
let webhookCalls = 0;

mock.module('../src/messaging/index.ts', {
  namedExports: {
    port: {
      sendDmCard: async (card: CardModel) => {
        dmCards.push(card);
        return dmResult;
      },
      sendDmText: async () => true,
      replyGroupCard: async () => null,
      sendGroupCard: async () => null,
      editGroupCard: async () => true,
      postWebhook: async () => {
        webhookCalls++;
        return true;
      },
      parseCardAction: () => null,
      parseMessage: () => null,
    },
  },
});

const { sendHealthAlert } = await import('../src/health/alert.ts');

function reset(): void {
  dmCards.length = 0;
  dmResult = true;
  webhookCalls = 0;
}

test("a degraded health alert: sent as a direct message through the port, with a card carrying a status a human can act on, the detail, and the local entry point", async () => {
  reset();
  const alertAt = Date.UTC(2026, 5, 18, 2, 3, 4);
  await sendHealthAlert('degraded', 'the health port is not responding', ['the main loop is still running', 'check logs/launchd.log'], alertAt);

  assert.equal(dmCards.length, 1);
  const card = dmCards[0];
  assert.equal(card.color, 'orange');
  assert.equal(card.title, '🟡 the health port is not responding');
  const expectedLocalTime = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(alertAt));
  assert.equal(card.subtitle, `Forge · ${expectedLocalTime}`);
  const text = JSON.stringify(card.blocks);
  assert.match(text, /the main loop is still running/);
  assert.match(text, /logs\/launchd\.log/);
  assert.match(text, /local status page/);
  assert.equal(webhookCalls, 0, 'a health alert must not go through the channel webhook');
});

test('a health alert whose direct message fails: it is only logged, and never leaks to the channel webhook', async () => {
  reset();
  dmResult = false;
  await sendHealthAlert('down', 'the service is disrupted', ['liveness has gone stale'], Date.UTC(2026, 5, 18, 2, 3, 4));

  assert.equal(dmCards.length, 1, "it still only attempts the bot's direct message");
  assert.equal(webhookCalls, 0, "even when the bot's direct message fails, the channel is not a fallback");
});
