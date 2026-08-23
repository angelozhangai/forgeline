// Unit/contract: the Feishu adapter's real probe entry point must attribute production failures as
// either auth or drift.
// Only the Feishu token and HTTP boundaries are mocked; feishuPort.probe's URL construction, response
// parsing and kind output all run the real code.
// No mirror testing: this does not inspect internal if branches, only that the shapes Feishu really
// returns lead to the correct operator alert semantics.
process.env.FORGE_DB = ':memory:';
process.env.FORGE_FUN = '0';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const cfg = {
  env: {
    FEISHU_BOT_APP_ID: 'app-id',
    FEISHU_BOT_APP_SECRET: 'secret',
    FEISHU_REVIEW_CHAT_ID: 'oc_prod',
  },
};

mock.module('../src/config.ts', {
  namedExports: {
    loadConfig: () => cfg,
  },
});

let tenantToken: string | null = 'tenant-token';
mock.module('../src/feishu/dm.ts', {
  namedExports: {
    FEISHU_BASE: 'https://feishu.example.test',
    botTenantToken: async () => tenantToken,
    botOpenId: async () => null,
    botOpenIdCached: () => null,
    sendBotCard: async () => true,
    sendBotCardObject: async () => true,
  },
});
mock.module('../src/feishu/group.ts', {
  namedExports: {
    replyCard: async () => 'msg',
    patchCard: async () => true,
    sendCardToChat: async () => 'msg',
  },
});
mock.module('../src/feishu/notify.ts', { namedExports: { postCard: async () => true } });
mock.module('../src/feishu/petAssets.ts', { namedExports: { petImageKey: () => null } });

let responseBody: unknown = { code: 0, data: { items: [], has_more: false, page_token: '' } };
let requestedUrl = '';
globalThis.fetch = (async (input: string | URL | Request) => {
  requestedUrl = String(input);
  return new Response(JSON.stringify(responseBody), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { feishuPort } = await import('../src/messaging/feishu.ts');

function reset(): void {
  tenantToken = 'tenant-token';
  responseBody = { code: 0, data: { items: [], has_more: false, page_token: '' } };
  requestedUrl = '';
}

test('the tenant token cannot be obtained: attributed to auth, pointing at credentials/network rather than schema drift', async () => {
  reset();
  tenantToken = null;

  const r = await feishuPort.probe();

  assert.equal(r.available, true);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'auth');
  assert.match(r.detail, /tenant_access_token/);
});

test('the Feishu API returns a permission / not-in-chat code: attributed to auth, probing read-only against the watched chat', async () => {
  reset();
  responseBody = { code: 99991663, msg: 'permission denied' };

  const r = await feishuPort.probe();

  assert.equal(r.kind, 'auth');
  assert.match(r.detail, /code=99991663/);
  assert.match(requestedUrl, /container_id=oc_prod/);
  assert.match(requestedUrl, /page_size=1/);
});

test('the Feishu API succeeds but pagination envelope fields are missing: attributed to drift, keeping raw for alert triage', async () => {
  reset();
  responseBody = { code: 0, data: { items: [] } };

  const r = await feishuPort.probe();

  assert.equal(r.ok, false);
  assert.equal(r.kind, 'drift');
  assert.match(r.detail, /missing pagination envelope fields/);
  assert.match(r.raw ?? '', /"items"/);
});

test('the Feishu pagination envelope is intact: ok, with no kind', async () => {
  reset();

  const r = await feishuPort.probe();

  assert.equal(r.ok, true);
  assert.equal(r.kind, undefined);
  assert.match(r.detail, /pagination envelope intact/);
});
