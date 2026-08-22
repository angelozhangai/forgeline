// Slack provider 层——**Web API 薄封装**。零新依赖：原生 fetch + Bearer token，跟飞书 raw 层同规格。
//
// 只做四件事：拼 URL/鉴权、把「HTTP 层失败」和「Slack 层 ok:false」压成同一种结果、限流退避、
// 把凭据的读取收在一处。业务语义（发什么卡、怎么解析回调）一概不在这里——那是 messaging/slack.ts 的事。
//
// 只允许 messaging/slack.ts 使用（架构边界闸守着）。
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';

export const SLACK_BASE = 'https://slack.com/api';

// Slack 的响应一律是 200 + body.ok。我们把网络异常/非 JSON/限流耗尽也归一成同一个形状——
// 调用方只需要看 ok/error，不必分辨"是 HTTP 挂了还是 Slack 说不行"。
export interface SlackResp {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export function botToken(): string | undefined {
  return loadConfig().env.SLACK_BOT_TOKEN;
}
// Socket Mode 的 apps.connections.open 只认 app-level token（xapp-…），跟 bot token 不是一回事。
export function appToken(): string | undefined {
  return loadConfig().env.SLACK_APP_TOKEN;
}

const MAX_RETRY = 3;

// 调一次 Slack Web API（POST + JSON）。429 按 Retry-After 退避重试，最多 MAX_RETRY 次。
// 失败绝不抛：返回 { ok:false, error }，由调用方决定降级——传输层失败不该掀翻编排循环。
export async function slackApi(
  method: string,
  body: Record<string, unknown> = {},
  opts: { token?: string; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SlackResp> {
  const token = opts.token ?? botToken();
  if (!token) return { ok: false, error: 'not_configured：缺 SLACK_BOT_TOKEN' };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${SLACK_BASE}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { ok: false, error: `network: ${String(e).slice(0, 200)}` };
    }
    if (res.status === 429 && attempt < MAX_RETRY) {
      // Slack 明确给了 Retry-After（秒）。缺/坏时按 1s×2^n 退避，绝不空转重试。
      const hinted = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(hinted) && hinted > 0 ? hinted * 1000 : 1000 * 2 ** attempt;
      log.warn(`Slack 限流（${method}），${waitMs}ms 后重试（第 ${attempt + 1}/${MAX_RETRY} 次）`);
      await sleep(waitMs);
      continue;
    }
    let j: SlackResp;
    try {
      j = (await res.json()) as SlackResp;
    } catch (e) {
      // 非 JSON 通常意味着 5xx / 网关页面：如实报，绝不当成"没成功但也没错"。
      return { ok: false, error: `bad_response: HTTP ${res.status} ${String(e).slice(0, 120)}` };
    }
    if (!j.ok && !j.error) j.error = `unknown_error (HTTP ${res.status})`;
    return j;
  }
}
