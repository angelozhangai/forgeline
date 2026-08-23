// The thin wrapper over the Slack Web API (src/slack/web.ts): it flattens an HTTP-level failure and a
// Slack-level ok:false into one kind of result, and backs off when rate-limited. Callers read only ok and
// error -- a transport failure must never take the orchestration loop down, so this **never throws**.
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let env: Record<string, string | undefined> = { SLACK_BOT_TOKEN: 'xoxb-test' };
mock.module('../src/config.ts', { namedExports: { loadConfig: () => ({ env }) } });
const { slackApi, botToken, appToken } = await import('../src/slack/web.ts');

type FakeRes = { status: number; headers?: Record<string, string>; json: () => Promise<unknown> };
const origFetch = globalThis.fetch;
const requests: { url: string; init: RequestInit }[] = [];
function stubFetch(seq: FakeRes[]): void {
  let i = 0;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    requests.push({ url: String(url), init });
    const r = seq[Math.min(i++, seq.length - 1)];
    return { status: r.status, headers: { get: (k: string) => r.headers?.[k] ?? null }, json: r.json } as unknown as Response;
  }) as typeof fetch;
}
function reset(): void {
  requests.length = 0;
  env = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' };
  globalThis.fetch = origFetch;
}

test('reading the credentials: the bot token and the app token are two different things, and Socket Mode takes only the latter', () => {
  reset();
  assert.equal(botToken(), 'xoxb-test');
  assert.equal(appToken(), 'xapp-test');
});

test('an ordinary call: POST with form encoding and Bearer auth, passing the body through unchanged', async () => {
  reset();
  stubFetch([{ status: 200, json: async () => ({ ok: true, ts: '1.2' }) }]);
  const r = await slackApi('chat.postMessage', { channel: 'C1', text: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(requests[0].url, 'https://slack.com/api/chat.postMessage');
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer xoxb-test');
  assert.match(headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[0].init.body as string)), { channel: 'C1', text: 'hi' });
  reset();
});

// Why this has to be form encoding rather than JSON: only a specific documented list of write methods accepts
// a JSON body, and read methods such as conversations.history are not on it. Send JSON and channel is treated
// as absent, coming back as channel_not_found -- which looks like a permissions problem. And this path,
// offline backfill plus the inbound probe, **only runs against a real workspace**, so a local test can never
// surface it. Pinning the encoding here is the only place it can be caught.
test('a read method (conversations.history) uses form encoding too: channel and limit have to really appear in the body', async () => {
  reset();
  stubFetch([{ status: 200, json: async () => ({ ok: true, messages: [], has_more: false }) }]);
  await slackApi('conversations.history', { channel: 'C1', oldest: '1712345678.000000', limit: 50 });
  const form = new URLSearchParams(requests[0].init.body as string);
  assert.equal(form.get('channel'), 'C1');
  assert.equal(form.get('oldest'), '1712345678.000000');
  assert.equal(form.get('limit'), '50', 'a number has to be serialised as a string, not dropped entirely');
  reset();
});

test('structured arguments (blocks, attachments, view) become JSON strings inside the form encoding', async () => {
  reset();
  stubFetch([{ status: 200, json: async () => ({ ok: true }) }]);
  await slackApi('views.open', { trigger_id: 'T1', view: { type: 'modal', blocks: [{ type: 'divider' }] }, drop: undefined });
  const form = new URLSearchParams(requests[0].init.body as string);
  assert.equal(form.get('trigger_id'), 'T1');
  assert.deepEqual(JSON.parse(form.get('view') ?? ''), { type: 'modal', blocks: [{ type: 'divider' }] });
  assert.equal(form.has('drop'), false, 'undefined is not sent, and must not turn into the string "undefined"');
  reset();
});

test('no token configured: say so directly rather than firing a request that is bound to fail', async () => {
  reset();
  env = {};
  stubFetch([{ status: 200, json: async () => ({ ok: true }) }]);
  const r = await slackApi('chat.postMessage');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not_configured/);
  assert.equal(requests.length, 0);
  reset();
});

test('rate-limited with 429: back off by Retry-After, retry, and eventually succeed', async () => {
  reset();
  const waited: number[] = [];
  stubFetch([
    { status: 429, headers: { 'retry-after': '2' }, json: async () => ({}) },
    { status: 200, json: async () => ({ ok: true }) },
  ]);
  const r = await slackApi('chat.update', {}, { sleep: async (ms) => void waited.push(ms) });
  assert.equal(r.ok, true);
  assert.deepEqual(waited, [2000], 'when Slack gives a Retry-After, wait exactly that long rather than second-guessing it');
  assert.equal(requests.length, 2);
  reset();
});

test('rate-limited with 429 and no Retry-After: back off 1s, 2s, 4s, and report the failure honestly once the retries run out rather than spinning', async () => {
  reset();
  const waited: number[] = [];
  stubFetch([{ status: 429, json: async () => ({ ok: false, error: 'ratelimited' }) }]);
  const r = await slackApi('chat.postMessage', {}, { sleep: async (ms) => void waited.push(ms) });
  assert.deepEqual(waited, [1000, 2000, 4000]);
  assert.equal(r.ok, false);
  assert.equal(requests.length, 4, 'the first attempt plus three retries is the cap -- it never retries forever');
  reset();
});

test('a network error or a non-JSON response flattens into the same {ok:false, error} and never throws (a transport failure must not take the orchestration loop down)', async () => {
  reset();
  globalThis.fetch = (async () => {
    throw new Error('ECONNRESET');
  }) as typeof fetch;
  const net = await slackApi('chat.postMessage');
  assert.equal(net.ok, false);
  assert.match(net.error ?? '', /network: .*ECONNRESET/);

  stubFetch([{ status: 502, json: async () => { throw new Error('Unexpected token <'); } }]);
  const bad = await slackApi('chat.postMessage');
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /bad_response: HTTP 502/);
  reset();
});

test('Slack says ok:false without an error: one is supplied, so there is never a "did not succeed but nothing went wrong" state', async () => {
  reset();
  stubFetch([{ status: 200, json: async () => ({ ok: false }) }]);
  const r = await slackApi('chat.postMessage');
  assert.match(r.error ?? '', /unknown_error/);
  reset();
});
