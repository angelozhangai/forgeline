// 单元/契约：Feishu adapter 的真实 probe 入口要把生产故障归因成 auth 或 drift。
// 只 mock 飞书 token/HTTP 边界；feishuPort.probe 的 URL 构造、响应解析、kind 输出走真实代码。
// 禁止镜像测试：不检查内部 if 分支，只验证 Feishu 真实返回形态会导向正确的 operator 告警语义。
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

test('tenant token 取不到：归 auth，提示查凭据/网络，而不是 schema drift', async () => {
  reset();
  tenantToken = null;

  const r = await feishuPort.probe();

  assert.equal(r.available, true);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'auth');
  assert.match(r.detail, /tenant_access_token/);
});

test('Feishu API 返回权限/加群错误 code：归 auth，并按观察群做只读探针', async () => {
  reset();
  responseBody = { code: 99991663, msg: 'permission denied' };

  const r = await feishuPort.probe();

  assert.equal(r.kind, 'auth');
  assert.match(r.detail, /code=99991663/);
  assert.match(requestedUrl, /container_id=oc_prod/);
  assert.match(requestedUrl, /page_size=1/);
});

test('Feishu API 成功但分页信封字段缺失：归 drift，并保留 raw 供告警排查', async () => {
  reset();
  responseBody = { code: 0, data: { items: [] } };

  const r = await feishuPort.probe();

  assert.equal(r.ok, false);
  assert.equal(r.kind, 'drift');
  assert.match(r.detail, /缺分页信封字段/);
  assert.match(r.raw ?? '', /"items"/);
});

test('Feishu API 分页信封完整：ok，无 kind', async () => {
  reset();

  const r = await feishuPort.probe();

  assert.equal(r.ok, true);
  assert.equal(r.kind, undefined);
  assert.match(r.detail, /分页信封完好/);
});
