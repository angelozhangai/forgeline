// 传输层薄缝——**provider 无关的消息模型**。核心（worker/actions/gates/notify）只描述「要发什么」的语义，
// 不碰任何飞书/Slack 的 JSON。每个 provider 的 adapter（见 messaging/<provider>.ts）各自把这些语义块
// 渲染成自家卡片（飞书 2.0 card / Slack Block Kit），并把自家入站事件解析回下面的 InboundEvent。
//
// 设计取舍：块的粒度取**语义级**（决策表单 / 统计行 / 回调按钮 / 宠物行），而非飞书的微观 tag
// （markdown/column_set/select_static…）。语义级才真正可移植：renderer 知道怎么把「决策表单」落成
// 飞书 form，也能落成 Slack 的 actions block；微观 tag 会把飞书细节焊死进核心。
import type { DecisionItem } from '../gates/envelopes.ts';

// 卡片主色（语义色：危险/信息/成功/中性/警示）。各 provider 映射到自家模板色。
export type CardColor = 'red' | 'blue' | 'green' | 'grey' | 'orange';

// 醒目横幅的语义色调（danger=危险/红，warning=警示/橙，info=信息/蓝）。adapter 各自落地。
export type CalloutTone = 'danger' | 'warning' | 'info';

// 回调按钮的语义（点了触发哪个 action、针对哪条 slug、附带什么 value）。
export interface CardButton {
  text: string;
  style: 'primary' | 'default' | 'danger';
  action: string; // 业务动作：confirm_submit/gateb/go/retry/force_confirm/...
  slug: string;
  value?: Record<string, unknown>; // 透传到回调的额外字段（如 round——防原地编辑卡的重复投递去重）
}

// 一条残留评审意见 / 开放问题（findingList 用）。lead=主问句/问题；notes=位置/建议等副行（仅含已知项）。
// severity 是语义级（high/med/low），由 adapter 映射成自家颜色标签——核心不持有任何 provider 颜色语法。
export interface FindingLine {
  severity?: string;
  lead: string;
  notes?: { label: string; text: string }[];
}

// 一段卡片内容的「语义块」。
export type CardBlock =
  | { kind: 'text'; md: string } // 普通 markdown 段
  | { kind: 'note'; md: string } // 次要信息（灰）
  | { kind: 'footnote'; md: string } // 小一号灰字脚注（成本/进化树/彩蛋，沉底）
  | { kind: 'quote'; text: string } // 引用块（低存在感概述）
  | { kind: 'callout'; tone: CalloutTone; md: string } // 醒目横幅（语义色调）——adapter 各自上色/前缀（飞书用 <font>，Slack 用 emoji 前缀）
  | { kind: 'divider' }
  | { kind: 'stats'; fields: string[] } // 一行并排的统计字段（复杂度/置信/成本…，每项自带 markdown）
  | { kind: 'button'; button: CardButton } // 单个回调按钮
  | { kind: 'buttonRow'; buttons: CardButton[] } // 并排回调按钮（强制立项 / 再修一轮）
  | { kind: 'decisionList'; items: DecisionItem[] } // 待决项逐条展示（问句 + 选项 ★推荐/影响）
  | { kind: 'findingList'; findings: FindingLine[] } // 评审/复审残留逐条（严重度标签 + 位置/建议副行）——adapter 负责严重度上色 + 副行灰字
  | { kind: 'decisionForm'; slug: string; items: DecisionItem[]; action: string; round?: number; verdict?: boolean; submitText: string; notesLabel: string; notesPlaceholder: string } // 逐条下拉 + (可选)整体结论 + 补充框 + 提交
  | { kind: 'goForm'; slug: string; pool: string[]; picked: string | null } // 立项：DRI 下拉 + 提交
  | { kind: 'petRow'; asset: string; voice: string; mentionId?: string }; // 宠物头像 + 台词一行；mentionId 设则 @ 该人（@PM）

// 一张待发卡片的 provider 无关描述。adapter 渲染它 + 发送。
export interface CardModel {
  color: CardColor;
  title: string;
  subtitle?: string;
  blocks: CardBlock[];
}

// ── 入站事件（provider 无关）──────────────────────────────────────
// adapter 的 parseCardAction / parseMessage 把自家原始事件规整成下面两种，listen 的业务分发只认这个。

// 卡片回调（PM/M 点按钮或提交表单）。
export interface InboundCardAction {
  type: 'card_action';
  action: string; // 回调 value.action
  slug: string; // 回调 value.slug
  value: Record<string, unknown>; // 完整回调 value（含 round 等透传字段）
  formValues: Record<string, string>; // 表单 form_value（ask_*/verdict/notes/assignee）
  operatorId?: string; // 触发人在该 IM 里的 id（飞书 open_id / Slack user id）
}

// 群消息（PM 贴 PRD 链接）。
export interface InboundMessage {
  type: 'message';
  chatId: string;
  senderId?: string;
  messageId?: string;
  text: string;
  // 需求文档链接常不在纯文本里（飞书文档分享卡 / 富文本 post / Slack 的 blocks·attachments）。
  // 「链接藏在哪种结构里」是 **messaging-provider** 专属知识——adapter 负责把这些结构挖成
  // 不透明文本块塞进这里；核心把 `text + searchTexts` 交给**文档源注册表**认领（claimDocs，见 docs/index.ts）。
  // 塞的是文本块、不是结构化 raw——既保留「扫纯文本之外」的兜底能力，又不把任何 provider 的 raw shape 泄回核心。
  searchTexts?: string[];
  createTime: number;
  // 群消息入口闸用（adapter 从自家事件算出，核心据此决定要不要入流程）：
  // isGroup=是否群消息（vs p2p 私聊——私聊天然定向，不要求 @）；
  // mentionedBot=本机器人是否被 @（飞书 adapter 读事件里**服务端填充的 mentions**；Slack adapter 看正文里的 <@BOTID>）。
  // mentionedBot=null 表示**无法确认 bot 身份**（provider 侧拿不到自己的 id）→ 核心保守忽略。
  // 「无法确认」与「确实没人 @」必须分开——混成 false 会让整条群入口悄悄敞开。
  // 省略（旧 provider/测试未设）按非群处理（照常入流程），不影响既有语义。
  isGroup?: boolean;
  mentionedBot?: boolean | null;
}

export type InboundEvent = InboundCardAction | InboundMessage;
