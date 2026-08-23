// 群消息入口闸的**唯一判据**（provider 无关）。live 消息入口（daemon/listen.ts）与离线补拉
// （messaging/backfill.ts）都问这里，两条路径对「什么算一条需求」的看法从此不会各说各话。
//
// 闸本身是**防花钱**的：群里随手分享/转发的文档链接不该触发闸A（一次闸A 是真金白银），所以
// 群消息要求 @ 了本机器人才入流程；p2p 私聊天然定向，不要求 @。
//
// 三态而非布尔——「确认没人 @」与「确认不了」必须分开：
//   · 混成 false（当作没 @）→ 拿不到 mentions 的 provider 一条都进不来，整个离线补拉静默失效；
//   · 混成 true（当作 @ 了）→ 整条群入口悄悄敞开，闸失去意义。
// 两条路径对第三态的处置**故意不同**，这个不同就是本文件存在的理由：
//   · live：忽略（并 warn）。这条消息还在群里，人再 @ 一次就是了，代价是一次重发；
//   · 补拉：照常登记（并 warn）。这条消息已经过去了，忽略等于离线期间的需求被静默吞掉，
//     而那正是补拉这个功能存在的唯一目的——用一个「可能白跑一次闸A」换「绝不漏需求」。
import type { InboundMessage } from './model.ts';

export type MentionGate =
  | 'admit' // 私聊，或确认 @ 了本机器人 → 入流程
  | 'ignore' // 确认是群消息且没人 @ 本机器人 → 不入流程
  | 'unconfirmable'; // 群消息，但无从判断（provider 的信封不带 mentions / 拿不到 bot 自身 id）

export function mentionGate(m: Pick<InboundMessage, 'isGroup' | 'mentionedBot'>): MentionGate {
  if (!m.isGroup) return 'admit'; // 省略（旧 provider/测试未设）也按非群处理，与既有语义一致
  if (m.mentionedBot === true) return 'admit';
  if (m.mentionedBot === false) return 'ignore';
  return 'unconfirmable';
}
