// 传输层薄缝——**MessagingPort**：核心与具体 IM provider（飞书/未来 Slack）之间的唯一接口。
// 出站：核心交一份 provider 无关的 CardModel（或简单 title+lines），adapter 负责渲染成自家卡片 + 发送。
// 入站：adapter 把自家原始事件解析成 provider 无关的 InboundEvent，交回核心做业务分发。
//
// 当前唯一实现是飞书（messaging/feishu.ts）。要接 Slack 只需再写一个实现本接口的 adapter，
// 核心（notify/listen/worker/actions）一行不用动——这正是本薄缝的目的。
import type { CardModel, CardColor, InboundCardAction, InboundMessage } from './model.ts';

// 入站长连接回调（core 提供，adapter 收到自家原始事件时回调）。raw 是 provider 无关的不透明 Record——
// core 再交 parseCardAction/parseMessage 规整成 InboundCardAction/InboundMessage（沿用既有 parse-in-core 分发，
// adapter 只负责「建连 + 把原始事件搬过来」，不把 provider SDK/channel 生命周期泄进 core）。
export interface InboundHandlers {
  onCardAction(raw: Record<string, unknown>): void;
  onMessage(raw: Record<string, unknown>): void;
  onError(reason: string): void; // 长连接错误（标记离线）
  onReconnected(): void; // 断线重连成功（标记在线 + 补拉断连期间消息）
}

// 入站长连接句柄。connect() 建连（首连失败 reject，交 core 决定降级为仅周期 tick）。
export interface InboundChannel {
  connect(): Promise<void>;
}

// 入站传输的契约探针结果（provider 无关）：对自家 IM API 跑一发最便宜的只读往返，断言我们依赖的
// 信封字段还在。available=凭据齐能探；ok=信封完好。adapter 内部实现（feishu im/v1/messages 等细节
// 不泄进 llm/health 层）；llm/probes 的 probeFeishu 只做薄壳映射成统一 ProbeResult。
export interface InboundProbe {
  available: boolean;
  ok: boolean;
  detail: string;
  raw?: string;
  // !ok 归因（同 ProbeResult.kind，由 probeFeishu 透传到 health/contract 告警分流）：
  // auth=凭据/权限/网络（重新登录·查权限·加群，非改 contract.ts）；drift=信封字段缺失（改 contract.ts）。
  kind?: 'auth' | 'drift';
}

export interface MessagingPort {
  // ── 出站：决策/通知卡 ──
  // M 私聊卡（裁决/出方案/立项/失败重试…）。返回是否送达（失败由调用方决定降级）。
  sendDmCard(card: CardModel): Promise<boolean>;
  // 简单文本卡（title + markdown 行 + 色）——漂移/健康告警、处理中回执等无表单场景。
  sendDmText(title: string, lines: string[], color: CardColor): Promise<boolean>;

  // ── 出站：群状态卡（回复 PM 那条，全程原地编辑）──
  // 回复某条消息建群卡，返回新卡 messageId（落 status_msg_id 用）。
  replyGroupCard(replyToMessageId: string, card: CardModel): Promise<string | null>;
  // 直接发到群（无可回复的 intake 消息时），返回 messageId。
  sendGroupCard(chatId: string, card: CardModel): Promise<string | null>;
  // 原地编辑已存在的群卡（同 messageId）。
  editGroupCard(messageId: string, card: CardModel): Promise<boolean>;

  // ── 出站：群 webhook 兜底（bot 私聊未送达时的群侧降级，非错误类才用）──
  postWebhook(title: string, lines: string[], color: CardColor): Promise<boolean>;

  // ── 入站：把自家原始事件解析成 provider 无关事件（无法识别 → null）──
  parseCardAction(raw: Record<string, unknown>): InboundCardAction | null;
  parseMessage(raw: Record<string, unknown>): InboundMessage | null;

  // ── 入站：长连接（adapter 内部建 channel + 收发，core 不碰任何 provider SDK / channel 生命周期）──
  // 入站传输是否已配置（凭据齐全）。未配置 → core 退化为仅周期 tick（无卡片按钮/群消息入口）。
  inboundConfigured(): boolean;
  // 起入站长连接：adapter 建 channel、把自家原始事件转发给 handlers，返回可 connect 的句柄。
  startInbound(handlers: InboundHandlers): InboundChannel;

  // 入站传输契约探针：只读往返验自家 IM API 信封（feishu im/v1/messages 分页字段等）。
  probe(): Promise<InboundProbe>;
}
