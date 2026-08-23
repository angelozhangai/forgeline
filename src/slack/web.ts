// Slack provider layer — **a thin Web API wrapper**. Zero new dependencies: native fetch plus a Bearer
// token, to the same spec as the Feishu raw layer.
//
// It does five things only: build the URL and authenticate, serialise arguments in the form encoding
// Slack accepts everywhere, collapse "the HTTP layer failed" and "Slack said ok:false" into one result
// shape, back off on rate limits, and keep credential reading in one place.
// Business semantics (which card to send, how to parse a callback) are not here at all — that is
// messaging/slack.ts's job.
//
// Only messaging/slack.ts may use this (the architecture boundary gate enforces it).
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';

export const SLACK_BASE = 'https://slack.com/api';

// The Web API root is the **only** hardcoded external address (where Socket Mode connects is handed out
// by apps.connections.open at runtime).
// Leaving an override has two legitimate reasons, neither of which is testing for its own sake:
//  · the local acceptance loop (test/slack-live-loop.test.ts) runs the whole "post card -> click button ->
//    open modal -> submit" path against a fake Slack, which is the only way to verify form encoding and
//    the modal round trip on a machine with no workspace;
//  · deployments with restricted egress go through a corporate proxy.
function apiBase(): string {
  return loadConfig().env.SLACK_API_BASE || SLACK_BASE;
}

// Slack's responses are always 200 plus body.ok. Network errors, non-JSON responses and exhausted retries
// are normalised into the same shape — callers only need to look at ok/error, without distinguishing
// "HTTP failed" from "Slack said no".
export interface SlackResp {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export function botToken(): string | undefined {
  return loadConfig().env.SLACK_BOT_TOKEN;
}
// Socket Mode's apps.connections.open only accepts an app-level token (xapp-…), which is a different
// thing from the bot token.
export function appToken(): string | undefined {
  return loadConfig().env.SLACK_APP_TOKEN;
}

const MAX_RETRY = 3;

// -- Argument encoding: always application/x-www-form-urlencoded --------------
// Slack's Web API does **not** accept a JSON body for every method: JSON works only for an explicitly
// documented list of methods (write methods such as chat.postMessage / chat.update / views.open), while
// read methods like conversations.history accept form encoding only — send JSON and the parameters are
// treated as absent, returning channel_not_found / invalid_arguments, which looks like "wrong credentials
// or permissions" when it is in fact the wrong encoding.
// Those two are precisely the paths **only reachable in a real workspace** (offline backfill plus the
// inbound probe), which local tests could never surface.
//
// The official SDK does the same thing — always form-encode, with complex values serialised to JSON
// strings (the one exception being multipart file uploads). We follow suit: one encoding for every
// method, and one fewer fork that only blows up on go-live day.
function formBody(body: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    // Structured values like blocks / attachments / view are simply "JSON serialised to a string" in form
    // encoding — Slack documents accepting them that way.
    p.append(k, typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));
  }
  return p.toString();
}

// Call the Slack Web API once (POST plus form encoding, see above). A 429 backs off per Retry-After and
// retries at most MAX_RETRY times.
// It never throws on failure: it returns { ok:false, error } and lets the caller decide how to degrade —
// a transport failure must not topple the orchestration loop.
export async function slackApi(
  method: string,
  body: Record<string, unknown> = {},
  opts: { token?: string; sleep?: (ms: number) => Promise<void>; retry?: boolean } = {},
): Promise<SlackResp> {
  const token = opts.token ?? botToken();
  if (!token) return { ok: false, error: 'not_configured: SLACK_BOT_TOKEN is missing' };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // retry:false is for **time-limited calls** (views.open's trigger_id lives for only 3 seconds): a
  // backoff retry there buys nothing but an expired_trigger_id, and buries the real cause. See openModal
  // in messaging/slack.ts.
  const maxRetry = opts.retry === false ? 0 : MAX_RETRY;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${apiBase()}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: formBody(body),
      });
    } catch (e) {
      return { ok: false, error: `network: ${String(e).slice(0, 200)}` };
    }
    if (res.status === 429 && attempt < maxRetry) {
      // Slack states Retry-After explicitly (in seconds). When it is missing or broken, back off by
      // 1s x 2^n rather than spinning on retries.
      const hinted = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(hinted) && hinted > 0 ? hinted * 1000 : 1000 * 2 ** attempt;
      log.warn(`Slack rate limit (${method}); retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetry})`);
      await sleep(waitMs);
      continue;
    }
    let j: SlackResp;
    try {
      j = (await res.json()) as SlackResp;
    } catch (e) {
      // Non-JSON usually means a 5xx or a gateway page: report it faithfully, never as "not successful but
      // not an error either".
      return { ok: false, error: `bad_response: HTTP ${res.status} ${String(e).slice(0, 120)}` };
    }
    if (!j.ok && !j.error) j.error = `unknown_error (HTTP ${res.status})`;
    return j;
  }
}
