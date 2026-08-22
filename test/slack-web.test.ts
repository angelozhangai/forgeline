// Slack Web API 薄封装（src/slack/web.ts）：把「HTTP 层失败」和「Slack 层 ok:false」压成同一种结果，
// 加限流退避。调用方只看 ok/error —— 传输层失败绝不掀翻编排循环，所以这里**永远不抛**。
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

test('凭据读取：bot token 与 app token 是两枚不同的东西（Socket Mode 只认后者）', () => {
  reset();
  assert.equal(botToken(), 'xoxb-test');
  assert.equal(appToken(), 'xapp-test');
});

test('正常调用：POST JSON + Bearer 鉴权，body 原样透传', async () => {
  reset();
  stubFetch([{ status: 200, json: async () => ({ ok: true, ts: '1.2' }) }]);
  const r = await slackApi('chat.postMessage', { channel: 'C1', text: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(requests[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, 'Bearer xoxb-test');
  assert.deepEqual(JSON.parse(requests[0].init.body as string), { channel: 'C1', text: 'hi' });
  reset();
});

test('未配 token：直接说没配，不打一发注定失败的请求', async () => {
  reset();
  env = {};
  stubFetch([{ status: 200, json: async () => ({ ok: true }) }]);
  const r = await slackApi('chat.postMessage');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not_configured/);
  assert.equal(requests.length, 0);
  reset();
});

test('限流 429：按 Retry-After 退避重试，最终成功', async () => {
  reset();
  const waited: number[] = [];
  stubFetch([
    { status: 429, headers: { 'retry-after': '2' }, json: async () => ({}) },
    { status: 200, json: async () => ({ ok: true }) },
  ]);
  const r = await slackApi('chat.update', {}, { sleep: async (ms) => void waited.push(ms) });
  assert.equal(r.ok, true);
  assert.deepEqual(waited, [2000], 'Slack 给了 Retry-After 就照它等，别自作聪明');
  assert.equal(requests.length, 2);
  reset();
});

test('限流 429 且没给 Retry-After：退避 1s→2s→4s，重试耗尽后如实报错（绝不空转）', async () => {
  reset();
  const waited: number[] = [];
  stubFetch([{ status: 429, json: async () => ({ ok: false, error: 'ratelimited' }) }]);
  const r = await slackApi('chat.postMessage', {}, { sleep: async (ms) => void waited.push(ms) });
  assert.deepEqual(waited, [1000, 2000, 4000]);
  assert.equal(r.ok, false);
  assert.equal(requests.length, 4, '首次 + 3 次重试就到顶，不无限重试');
  reset();
});

test('网络异常 / 非 JSON 响应：压成同一种 {ok:false,error}，绝不抛（传输层失败不该掀翻编排循环）', async () => {
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

test('Slack 说 ok:false 但没给 error：补一个，绝不留「没成功但也没错」这种状态', async () => {
  reset();
  stubFetch([{ status: 200, json: async () => ({ ok: false }) }]);
  const r = await slackApi('chat.postMessage');
  assert.match(r.error ?? '', /unknown_error/);
  reset();
});
