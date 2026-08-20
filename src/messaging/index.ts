// 传输层薄缝——**provider 选择点（唯一接线处）**。
// 核心（notify/listen）只 `import { port } from './messaging/index.ts'`，永不直接依赖某个具体 IM adapter。
// 当前唯一 provider 是飞书；将来接 Slack 只需在此换成 slackPort（实现同一 MessagingPort），核心一行不动。
import { feishuPort } from './feishu.ts';
import type { MessagingPort } from './port.ts';

export const port: MessagingPort = feishuPort;
export { renderFeishuCard } from './feishu.ts';
export type { MessagingPort, InboundHandlers, InboundChannel, InboundProbe } from './port.ts';
export type { CardModel, CardBlock, CardColor, CardButton, FindingLine, InboundEvent, InboundCardAction, InboundMessage } from './model.ts';
