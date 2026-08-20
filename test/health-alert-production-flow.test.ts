// 单元/边界：健康告警的产品行为。告警是 M 私有运维信息，只能经 MessagingPort 私聊；
// bot 失败也不能降级到群 webhook，避免把本地错误细节泄到团队群。
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

test('健康降级告警：经 port 私聊发送，卡片含人能处理的状态、明细和本地入口', async () => {
  reset();
  const alertAt = Date.UTC(2026, 5, 18, 2, 3, 4);
  await sendHealthAlert('degraded', '健康端口无响应', ['主循环仍在跑', '建议查 logs/launchd.log'], alertAt);

  assert.equal(dmCards.length, 1);
  const card = dmCards[0];
  assert.equal(card.color, 'orange');
  assert.equal(card.title, '🟡 健康端口无响应');
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
  assert.match(text, /主循环仍在跑/);
  assert.match(text, /logs\/launchd\.log/);
  assert.match(text, /本地状态页/);
  assert.equal(webhookCalls, 0, '健康告警不应走群 webhook');
});

test('健康告警私聊失败：只记日志语义，不外泄到群 webhook', async () => {
  reset();
  dmResult = false;
  await sendHealthAlert('down', '服务异常', ['liveness 过期'], Date.UTC(2026, 5, 18, 2, 3, 4));

  assert.equal(dmCards.length, 1, '仍然只尝试 bot 私聊');
  assert.equal(webhookCalls, 0, 'bot 私聊失败也不能群兜底');
});
