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

test('正常调用：POST form 编码 + Bearer 鉴权，body 原样透传', async () => {
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

// 为什么必须是 form 而不是 JSON：JSON body 只有一份被标注的写方法名单吃得下，
// conversations.history 这类读方法不在名单里——JSON 发过去 channel 会被当成没传，
// 回一个 channel_not_found，看着像权限问题。而这条路径（离线补拉 + 入站探针）
// **只有真工作区才跑得到**，本地测试永远照不出来 → 只能在编码这一层钉死。
test('读方法（conversations.history）同样走 form 编码：channel/limit 必须真的出现在 body 里', async () => {
  reset();
  stubFetch([{ status: 200, json: async () => ({ ok: true, messages: [], has_more: false }) }]);
  await slackApi('conversations.history', { channel: 'C1', oldest: '1712345678.000000', limit: 50 });
  const form = new URLSearchParams(requests[0].init.body as string);
  assert.equal(form.get('channel'), 'C1');
  assert.equal(form.get('oldest'), '1712345678.000000');
  assert.equal(form.get('limit'), '50', '数字要序列化成字符串，不能整个丢掉');
  reset();
});

test('结构体入参（blocks / attachments / view）在 form 编码里就是 JSON 串', async () => {
  reset();
  stubFetch([{ status: 200, json: async () => ({ ok: true }) }]);
  await slackApi('views.open', { trigger_id: 'T1', view: { type: 'modal', blocks: [{ type: 'divider' }] }, drop: undefined });
  const form = new URLSearchParams(requests[0].init.body as string);
  assert.equal(form.get('trigger_id'), 'T1');
  assert.deepEqual(JSON.parse(form.get('view') ?? ''), { type: 'modal', blocks: [{ type: 'divider' }] });
  assert.equal(form.has('drop'), false, 'undefined 不发出去，别变成字符串 "undefined"');
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
