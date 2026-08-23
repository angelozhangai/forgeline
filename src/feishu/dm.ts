import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import type { CardColor } from './notify.ts';

const FEISHU = 'https://open.feishu.cn/open-apis';
export const FEISHU_BASE = FEISHU;

// In-process cache of the tenant_access_token (valid for ~2h, with a 5-minute safety margin).
let tokenCache: { token: string; exp: number } | null = null;

async function tenantToken(appId: string, secret: string): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && tokenCache.exp > now) return tokenCache.token;
  try {
    const res = await fetch(`${FEISHU}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: secret }),
    });
    const j = (await res.json()) as { code?: number; tenant_access_token?: string; expire?: number };
    if (j.code !== 0 || !j.tenant_access_token) {
      log.warn(`Failed to obtain tenant_access_token: ${JSON.stringify(j).slice(0, 160)}`);
      return null;
    }
    tokenCache = { token: j.tenant_access_token, exp: now + (j.expire ?? 7200) * 1000 - 300_000 };
    return tokenCache.token;
  } catch (e) {
    log.warn(`Error obtaining tenant_access_token: ${String(e)}`);
    return null;
  }
}

// The bot's app-level tenant_access_token (reused by APIs such as chat history retrieval, sharing the
// same in-process cache).
export async function botTenantToken(): Promise<string | null> {
  const { env } = loadConfig();
  const appId = env.FEISHU_BOT_APP_ID;
  const secret = env.FEISHU_BOT_APP_SECRET;
  if (!appId || !secret) return null;
  return tenantToken(appId, secret);
}

// The bot's own open_id (used by the channel intake gate to decide "was this bot @-mentioned in this
// channel message" — by comparing it against the **server-populated mentions array** on the event, rather
// than relying on the SDK's normalisation of mentions in the body).
// Prefers env.FEISHU_BOT_OPEN_ID (deterministic, testable offline, zero extra requests); otherwise it
// asks bot/v3/info once and caches the answer in-process.
let botOpenIdCache: string | null = null;
export async function botOpenId(): Promise<string | null> {
  if (botOpenIdCache) return botOpenIdCache;
  const { env } = loadConfig();
  if (env.FEISHU_BOT_OPEN_ID) {
    botOpenIdCache = env.FEISHU_BOT_OPEN_ID;
    return botOpenIdCache;
  }
  const token = await botTenantToken();
  if (!token) return null;
  try {
    const res = await fetch(`${FEISHU}/bot/v3/info`, { headers: { Authorization: `Bearer ${token}` } });
    const j = (await res.json()) as { code?: number; bot?: { open_id?: string } };
    if (j.code !== 0 || !j.bot?.open_id) {
      log.warn(`Failed to obtain the bot open_id: ${JSON.stringify(j).slice(0, 160)}`);
      return null;
    }
    botOpenIdCache = j.bot.open_id;
    return botOpenIdCache;
  } catch (e) {
    log.warn(`Error obtaining the bot open_id: ${String(e)}`);
    return null;
  }
}

// Synchronously read the bot open_id that is already cached or already configured via env (used by
// parseMessage's synchronous path).
// Not warmed up and no env set -> null (the core treats that as "the mention cannot be confirmed" and
// conservatively ignores it); warming up happens in botOpenId().
export function botOpenIdCached(): string | null {
  if (botOpenIdCache) return botOpenIdCache;
  const { env } = loadConfig();
  if (env.FEISHU_BOT_OPEN_ID) {
    botOpenIdCache = env.FEISHU_BOT_OPEN_ID;
    return botOpenIdCache;
  }
  return null;
}

// Test-only: pin or clear the in-process bot open_id cache directly (bypassing the env file key and the
// bot/v3/info request), to isolate test cases.
export function __setBotOpenIdCacheForTest(id: string | null): void {
  botOpenIdCache = id;
}

// Resolve the delivery target. Priority: open_id > union_id > chat_id > email.
function botTarget(): { appId: string; secret: string; idType: string; receiveId: string } | null {
  const { env } = loadConfig();
  const appId = env.FEISHU_BOT_APP_ID;
  const secret = env.FEISHU_BOT_APP_SECRET;
  const idType = env.FEISHU_DM_OPEN_ID
    ? 'open_id'
    : env.FEISHU_DM_UNION_ID
      ? 'union_id'
      : env.FEISHU_DM_CHAT_ID
        ? 'chat_id'
        : 'email';
  const receiveId =
    env.FEISHU_DM_OPEN_ID || env.FEISHU_DM_UNION_ID || env.FEISHU_DM_CHAT_ID || env.FEISHU_DM_EMAIL;
  if (!appId || !secret || !receiveId) return null;
  return { appId, secret, idType, receiveId };
}

// Send a complete card object (either the 1.0 or the 2.0 card schema). Bot unconfigured, or failure ->
// false.
export async function sendBotCardObject(card: unknown): Promise<boolean> {
  const t = botTarget();
  if (!t) return false;
  const token = await tenantToken(t.appId, t.secret);
  if (!token) return false;
  try {
    const res = await fetch(`${FEISHU}/im/v1/messages?receive_id_type=${t.idType}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receive_id: t.receiveId, msg_type: 'interactive', content: JSON.stringify(card) }),
    });
    const j = (await res.json()) as { code?: number; msg?: string };
    if (j.code !== 0) {
      log.warn(`Bot DM delivery failed: ${JSON.stringify(j).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`Bot DM delivery threw: ${String(e)}`);
    return false;
  }
}

// A simple card (a title plus text lines), used when there is no structured card.
export async function sendBotCard(title: string, mdLines: string[], color: CardColor = 'blue'): Promise<boolean> {
  return sendBotCardObject({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: color, title: { tag: 'plain_text', content: title } },
    body: { elements: [{ tag: 'markdown', content: mdLines.join('\n') }] },
  });
}
