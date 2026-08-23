import { createHmac } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';

export type CardColor = 'red' | 'blue' | 'green' | 'grey' | 'orange';

function genSign(ts: string, secret: string): string {
  const key = `${ts}\n${secret}`;
  return createHmac('sha256', key).update('').digest('base64');
}

// Post a card to a Feishu chat (the custom-bot webhook of the dogfooding chat). Returns false when no
// webhook is configured (this is not an error).
export async function postCard(
  title: string,
  mdLines: string[],
  color: CardColor = 'blue',
): Promise<boolean> {
  const cfg = loadConfig();
  const webhook = cfg.env.FEISHU_REVIEW_WEBHOOK;
  if (!webhook) {
    log.warn('FEISHU_REVIEW_WEBHOOK is not configured — skipping the chat card (the result is still written as a document comment and visible in the CLI)');
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
      log.warn(`Feishu card returned a non-zero code: ${JSON.stringify(j)}`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`Posting the Feishu card failed: ${String(e)}`);
    return false;
  }
}
