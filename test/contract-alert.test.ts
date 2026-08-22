// 契约/凭据告警分流：maybeAlertContractDrift 据 kind 区分「登录/鉴权失效」与「schema 漂移」，
// 给操作者**对的处置**（重新登录 vs 改 contract.ts）。直击「token 过期 → 链路静默瘫」的可操作性。
process.env.FORGE_DB = ':memory:';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const alerts: { kind: string; title: string; lines: string[] }[] = [];
mock.module('../src/health/alert.ts', {
  namedExports: {
    sendHealthAlert: async (kind: string, title: string, lines: string[]) => {
      alerts.push({ kind, title, lines });
      return true;
    },
  },
});
let stored: Record<string, { ok: boolean }> = {};
mock.module('../src/store/contract.ts', {
  namedExports: {
    getProbe: (dep: string) => stored[dep] ?? null,
    upsertProbe: (r: { dep: string; ok: boolean }) => { stored[r.dep] = { ok: r.ok }; },
    allProbes: () => Object.entries(stored).map(([dep, v]) => ({ dep, ok: v.ok })),
  },
});

const { maybeAlertContractDrift } = await import('../src/health/contract.ts');

test('kind=auth → 🔑 登录/鉴权告警 + 「重新登录」指引（非「改 contract.ts」）', async () => {
  alerts.length = 0; stored = {};
  await maybeAlertContractDrift([{ dep: 'gh', available: true, ok: false, kind: 'auth', detail: 'gh 非零退出（可能未登录）', at: 1 }]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /登录\/鉴权/);
  assert.ok(alerts[0].lines.some((l) => l.includes('gh auth login')));
  assert.ok(!alerts[0].lines.some((l) => l.includes('contract.ts'))); // auth 不该误导去改信封
});

test('IM kind=auth → 🔑 告警用 **adapter 自报的** 处置指引（非「改 contract.ts」）', async () => {
  alerts.length = 0; stored = {};
  // authFix 由 provider 给：怎么修飞书 token 是飞书的知识，核心不替它说话（换 Slack 就是另一句）。
  await maybeAlertContractDrift([
    { dep: 'im', available: true, ok: false, kind: 'auth', authFix: '检查飞书 bot 凭据/权限（FEISHU_BOT_APP_ID/SECRET、群是否已加 bot）', detail: 'im/v1/messages code=99991663（权限/群未加 bot）', at: 1 },
  ]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /登录\/鉴权/);
  assert.ok(alerts[0].lines.some((l) => l.includes('飞书 bot 凭据')));
  assert.ok(!alerts[0].lines.some((l) => l.includes('contract.ts'))); // 鉴权失败不该误导去改信封
});

test('IM kind=auth 但 adapter 没给 authFix → 退到通用文案，不冒充知道怎么修', async () => {
  alerts.length = 0; stored = {};
  await maybeAlertContractDrift([{ dep: 'im', available: true, ok: false, kind: 'auth', detail: 'token 失效', at: 1 }]);
  assert.ok(alerts[0].lines.some((l) => l.includes('检查该工具登录态')));
});

test('kind=drift → 契约漂移告警 + 改 contract.ts', async () => {
  alerts.length = 0; stored = {};
  await maybeAlertContractDrift([{ dep: 'codex', available: true, ok: false, kind: 'drift', detail: '缺 thread.started', at: 1 }]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /契约漂移/);
  assert.ok(alerts[0].lines.some((l) => l.includes('contract.ts')));
});

test('available=false（跳过）/ ok（完好）→ 不告警', async () => {
  alerts.length = 0; stored = {};
  await maybeAlertContractDrift([
    { dep: 'gh', available: false, ok: false, at: 1 },
    { dep: 'codex', available: true, ok: true, at: 1 },
  ]);
  assert.equal(alerts.length, 0);
});

test('翻转去抖：持续失败只告一次（第二次同态不再发）', async () => {
  alerts.length = 0; stored = {};
  const bad = [{ dep: 'gh' as const, available: true, ok: false, kind: 'auth' as const, detail: 'x', at: 1 }];
  await maybeAlertContractDrift(bad); // 完好→坏：告警
  await maybeAlertContractDrift(bad); // 坏→坏：不再告
  assert.equal(alerts.length, 1);
});
