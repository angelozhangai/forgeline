// 健康告警 → IM（经传输层薄缝 MessagingPort，provider 无关）。bot 私聊卡片，错误细节只走 M 私聊。
// 去抖由调用方负责（守护采样器靠 health_sample 翻转；看门狗靠 watchdog.json）——本模块只管发。
import { port } from '../messaging/index.ts';
import type { CardModel, CardColor } from '../messaging/index.ts';
import { log } from '../util/log.ts';

export type AlertSeverity = 'down' | 'degraded' | 'recovered';

const COLOR: Record<AlertSeverity, CardColor> = { down: 'red', degraded: 'orange', recovered: 'green' };
const EMOJI: Record<AlertSeverity, string> = { down: '🔴', degraded: '🟡', recovered: '🟢' };

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 发一条健康告警卡。title 不含 emoji（本函数加）；lines 为正文 markdown 行。
export async function sendHealthAlert(
  severity: AlertSeverity,
  title: string,
  lines: string[],
  now: number = Date.now(),
): Promise<void> {
  const card: CardModel = {
    color: COLOR[severity],
    title: `${EMOJI[severity]} ${title}`,
    subtitle: `Forge · ${stamp(now)}`,
    blocks: [
      { kind: 'text', md: lines.join('\n') },
      { kind: 'divider' },
      { kind: 'footnote', md: '自动健康告警 · 本地状态页 http://127.0.0.1 见 deploy/README' },
    ],
  };
  try {
    // 错误展示分流：健康/契约告警是 M 私有运维细节 → 只走 bot 私聊。
    // bot 私聊失败也**不**外泄到群 webhook（团队渠道），仅记日志（状态页 + 后续翻转会再现）。
    const sent = await port.sendDmCard(card);
    if (!sent) log.warn(`健康告警 bot 私聊未送达，按分流不外泄群，仅日志：${title} ｜ ${lines.join(' ｜ ').slice(0, 200)}`);
  } catch (e) {
    log.warn(`健康告警发送失败（已记日志，不影响流程）：${String(e).slice(0, 160)}`);
  }
}
