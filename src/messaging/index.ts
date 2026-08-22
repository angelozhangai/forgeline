// 传输层薄缝——**provider 选择点（唯一接线处）**。
// 核心（notify/listen/worker/actions）只 `import { port } from './messaging/index.ts'`，永不直接依赖某个具体 IM adapter。
//
// 选哪个由 `FORGE_MESSAGING_PROVIDER` 决定（缺省 feishu —— 既有部署零变化）。
// **认不出的值一律硬抛，绝不静默回退飞书**：这条缝的头号失效模式就是「配错了但看起来在跑」——
// 拼错成 `slak` 之后所有审批卡照发飞书，没有任何症状，直到有人发现 Slack 那边一片空白。
// 这条规则与 ext/ 的「present but unloadable → hard error」是同一条：宁可起不来，不可假装好着。
//
// 读法（设计文档 D2）：process.env 优先，其次直接读 forge.env。**故意不走 loadConfig()**——
// 本模块被半个仓库 import，在模块加载期拖进 yaml+zod 全量校验会把启动顺序和测试都搞脆。
import { loadEnvFile } from '../root.ts';
import { feishuPort } from './feishu.ts';
import { slackPort } from './slack.ts';
import type { MessagingPort } from './port.ts';

const PROVIDERS: Record<string, MessagingPort> = {
  feishu: feishuPort,
  slack: slackPort,
};

export const DEFAULT_PROVIDER = 'feishu';

// 导出供单测直接覆盖：选择逻辑本身（含"认不出就抛"）比接线结果更值得钉死。
export function selectPort(id: string | undefined, providers: Record<string, MessagingPort> = PROVIDERS): MessagingPort {
  const key = (id ?? '').trim() || DEFAULT_PROVIDER;
  const chosen = providers[key];
  if (!chosen) {
    throw new Error(
      `FORGE_MESSAGING_PROVIDER=「${key}」不是已知的 IM provider（可选：${Object.keys(providers).join(' / ')}）。` +
        '拒绝以「静默回退到默认 provider」的形态启动——那会让配置错误完全没有症状。',
    );
  }
  return chosen;
}

function configuredProvider(): string | undefined {
  return process.env.FORGE_MESSAGING_PROVIDER?.trim() || loadEnvFile().FORGE_MESSAGING_PROVIDER;
}

export const port: MessagingPort = selectPort(configuredProvider());

export { renderFeishuCard } from './feishu.ts';
export { renderSlackMessage } from './slack.ts';
export type { MessagingPort, InboundHandlers, InboundChannel, InboundProbe } from './port.ts';
export type { CardModel, CardBlock, CardColor, CardButton, FindingLine, InboundEvent, InboundCardAction, InboundMessage } from './model.ts';
