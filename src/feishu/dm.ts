import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import type { CardColor } from './notify.ts';

const FEISHU = 'https://open.feishu.cn/open-apis';
export const FEISHU_BASE = FEISHU;

// tenant_access_token 进程内缓存（~2h 有效，留 5min 余量）。
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
      log.warn(`取 tenant_access_token 失败：${JSON.stringify(j).slice(0, 160)}`);
      return null;
    }
    tokenCache = { token: j.tenant_access_token, exp: now + (j.expire ?? 7200) * 1000 - 300_000 };
    return tokenCache.token;
  } catch (e) {
    log.warn(`取 tenant_access_token 异常：${String(e)}`);
    return null;
  }
}

// bot 应用级 tenant_access_token（供拉群历史等 API 复用，复用同一进程内缓存）。
export async function botTenantToken(): Promise<string | null> {
  const { env } = loadConfig();
  const appId = env.FEISHU_BOT_APP_ID;
  const secret = env.FEISHU_BOT_APP_SECRET;
  if (!appId || !secret) return null;
  return tenantToken(appId, secret);
}

// bot 自身的 open_id（群消息入口闸判定「这条群消息有没有 @ 本机器人」用——把它跟事件里
// **服务端填充的 mentions 数组**比对，而不是依赖 SDK 对正文 @ 的 normalize）。
// 优先 env.FEISHU_BOT_OPEN_ID（确定性、可离线测、零额外请求）；缺省则一次性问 bot/v3/info 并进程内缓存。
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
      log.warn(`取 bot open_id 失败：${JSON.stringify(j).slice(0, 160)}`);
      return null;
    }
    botOpenIdCache = j.bot.open_id;
    return botOpenIdCache;
  } catch (e) {
    log.warn(`取 bot open_id 异常：${String(e)}`);
    return null;
  }
}

// 同步读「已缓存 / 已用 env 配好」的 bot open_id（parseMessage 同步路径用）。
// 未预热且未配 env → null（由核心判定为「无法确认 @」并保守忽略）；预热见 botOpenId()。
export function botOpenIdCached(): string | null {
  if (botOpenIdCache) return botOpenIdCache;
  const { env } = loadConfig();
  if (env.FEISHU_BOT_OPEN_ID) {
    botOpenIdCache = env.FEISHU_BOT_OPEN_ID;
    return botOpenIdCache;
  }
  return null;
}

// 仅供测试：直接钉死/清空 bot open_id 进程内缓存（绕开 env 文件键 + bot/v3/info 请求），隔离用例。
export function __setBotOpenIdCacheForTest(id: string | null): void {
  botOpenIdCache = id;
}

// 解析推送目标。目标优先级：open_id > union_id > chat_id > email。
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

// 发一个完整卡片对象（卡片 1.0 或 2.0 schema 皆可）。未配置 bot/失败 → false。
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
      log.warn(`bot 私聊发送失败：${JSON.stringify(j).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`bot 私聊发送异常：${String(e)}`);
    return false;
  }
}

// 简单卡片（标题 + 文本行），用于无结构化卡片时。
export async function sendBotCard(title: string, mdLines: string[], color: CardColor = 'blue'): Promise<boolean> {
  return sendBotCardObject({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: color, title: { tag: 'plain_text', content: title } },
    body: { elements: [{ tag: 'markdown', content: mdLines.join('\n') }] },
  });
}
