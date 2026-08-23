// 单元：群消息入口闸的**唯一判据**（messaging/gate.ts）。纯函数，无任何 IO。
//
// 这道闸是防花钱的：群里随手分享的文档不该触发一次闸A。它值得单独钉死，是因为它的
// **第三态**才是真正的设计点——「确认没人 @」与「确认不了」混成一个布尔，就必然二选一地坏掉：
// 当作没 @ → 拿不到 mentions 的 provider 一条都进不来（离线补拉静默失效）；
// 当作 @ 了 → 整条群入口悄悄敞开（闸等于没有）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionGate } from '../src/messaging/gate.ts';

test('私聊天然定向 → 放行，不要求 @', () => {
  assert.equal(mentionGate({ isGroup: false, mentionedBot: false }), 'admit');
});

test('isGroup 省略（旧 provider / 老测试未设）按非群处理 → 放行，既有语义不变', () => {
  assert.equal(mentionGate({}), 'admit');
});

test('群消息 + 确认 @ 了本机器人 → 放行', () => {
  assert.equal(mentionGate({ isGroup: true, mentionedBot: true }), 'admit');
});

test('群消息 + 确认没人 @ → 挡下（这条挡住的就是白跑的闸A）', () => {
  assert.equal(mentionGate({ isGroup: true, mentionedBot: false }), 'ignore');
});

test('群消息 + 无从判断（信封不带 mentions）→ 第三态，绝不并入前两者', () => {
  assert.equal(mentionGate({ isGroup: true, mentionedBot: null }), 'unconfirmable');
  assert.equal(mentionGate({ isGroup: true }), 'unconfirmable');
});
