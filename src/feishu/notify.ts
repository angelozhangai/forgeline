import { createHmac } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';

export type CardColor = 'red' | 'blue' | 'green' | 'grey' | 'orange';

function genSign(ts: string, secret: string): string {
  const key = `${ts}\n${secret}`;
  return createHmac('sha256', key).update('').digest('base64');
}

// 发飞书群卡片（dogfood 群的自定义机器人 webhook）。未配置 webhook 时返回 false（不报错）。
export async function postCard(
  title: string,
  mdLines: string[],
  color: CardColor = 'blue',
): Promise<boolean> {
  const cfg = loadConfig();
  const webhook = cfg.env.FEISHU_REVIEW_WEBHOOK;
  if (!webhook) {
    log.warn('未配置 FEISHU_REVIEW_WEBHOOK —— 跳过群卡片（结果仍写文档评论 + CLI 可见）');
    return false;
  }
  const body: Record<string, unknown> = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: color, title: { tag: 'plain_text', content: title } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: mdLines.join('\n') } }],
    },
  };
  const secret = cfg.env.FEISHU_REVIEW_WEBHOOK_SECRET;
  if (secret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    body.timestamp = ts;
    body.sign = genSign(ts, secret);
  }
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (j.code && j.code !== 0) {
      log.warn(`飞书卡片返回非 0：${JSON.stringify(j)}`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`发飞书卡片失败：${String(e)}`);
    return false;
  }
}
