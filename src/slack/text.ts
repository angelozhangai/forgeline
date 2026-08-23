// Slack provider 层——**文本封顶**。Block Kit 的每一处文本都有自己的上限，而三种越界的症状是**同一个**：
// `ok:false / invalid_blocks`，卡片压根不出现，日志里只有一行 warn，没有任何东西指向真正的原因。
//
//   ① 超限——上限还按字段分（header 150 / section 3000 / 按钮文案 75 / 模态标题 24…），一刀切两头都错；
//   ② 空串——`plain_text` 与 `mrkdwn` 都**不接受空文本**，空一个就整条消息被拒；
//   ③ 非法 UTF-16——按 UTF-16 单元 `slice` 会把 emoji 的代理对劈成两半，整个载荷被拒。
//
// 三条规矩收在这一份实现里，模态与消息卡共用。这不是洁癖：这套助手当初只有 slack/modal.ts 有
// （#18），隔壁 messaging/slack.ts 那侧还在裸 `.slice()` —— 同一类只在真工作区才现形的坑，
// 修了一半比没修更危险，因为它看起来像修过了。
import { BK_LIMIT } from './blockkit.ts';

// 按**码点**截断（不按 UTF-16 单元）。
export function clip(text: string, max: number): string {
  return Array.from(text ?? '').slice(0, max).join('');
}

// 给人看的文本超限 → 留一个省略号，让"这里被截过"是看得见的。
export function ellipsize(text: string, max: number): string {
  const t = text ?? '';
  return Array.from(t).length <= max ? t : `${clip(t, max - 1)}…`;
}

// plain_text 元素。fallback 兜住"空串同样非法"：调用方给不出内容时退到一个中性文案，
// 绝不发一条 Slack 会整体拒掉的消息。
export function plainText(text: string, max: number, fallback = '—'): Record<string, unknown> {
  return { type: 'plain_text', text: ellipsize((text ?? '').trim() || fallback, max), emoji: true };
}

// mrkdwn 元素（section.text / context.elements）。同样不接受空。
export function mrkdwnText(text: string, max: number = BK_LIMIT.sectionText, fallback = '—'): Record<string, unknown> {
  return { type: 'mrkdwn', text: ellipsize((text ?? '').trim() || fallback, max) };
}

// 一段文本是不是"没内容"——决定要不要干脆**不出这一块**（比发一个占位符干净，也比发个空的合法）。
export function blank(text: string | undefined | null): boolean {
  return !(text ?? '').trim();
}
