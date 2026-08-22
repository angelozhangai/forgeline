// 集成：Web 面板从真实 HTTP POST 入口到 actions/state DB 的生产链路。
// 禁止镜像测试：不复制状态/权限表，只验证用户从本机面板点击后的外部后果（HTTP 响应、状态推进、审计、写调用）。
process.env.FORGE_DB = ':memory:';

import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

let webActor = 'M';
let writeCalls = 0;
const notifications: { kind: string; state: string; slug: string }[] = [];

const cfg = {
  runtime: {
    web_actor: webActor,
    poll_interval_sec: 180,
    max_parallel: 2,
    branches: { prod: 'main', dev: 'dev' },
    default_branch: 'prod',
    repos: ['demo'],
    adversarial: { reviewer: 'codex', on_missing: 'skip', max_rounds: 3 },
    claude_bin: 'claude',
    codex_bin: 'codex',
    claude_allowed_tools: '',
    claude_timeout_sec: 1,
  },
  routing: { min_confidence: 0.7, sensitive_areas: [], reviewers: { M: 'ming', BD: 'bob' }, lead: 'M' },
  permissions: {
    gate_b_allowed: ['M', 'BD'],
    go_approvers: ['M'],
    gate_c_allowed: ['M'],
    pr_create_approvers: ['M'],
    merge_ack_allowed: ['M'],
  },
  assignment: { pool: ['M', 'BD'], wip_limit: { default: 2 }, in_progress_statuses: [3] },
  projects: null,
  env: {},
};

function currentCfg(): typeof cfg {
  return { ...cfg, runtime: { ...cfg.runtime, web_actor: webActor } };
}

function resolveLogin(localCfg: typeof cfg, code: string): string | null {
  const up = code.toUpperCase();
  for (const [k, v] of Object.entries(localCfg.routing.reviewers)) {
    if (k.toUpperCase() === up) return v;
  }
  return null;
}

function inAllowList(localCfg: typeof cfg, list: string[], who: string): boolean {
  const up = who.toUpperCase();
  for (const code of list) {
    if (code.toUpperCase() === up) return true;
    const login = resolveLogin(localCfg, code);
    if (login && login.toLowerCase() === who.toLowerCase()) return true;
  }
  return false;
}

mock.module('../src/config.ts', {
  namedExports: {
    loadConfig: currentCfg,
    resolveLogin,
    inAllowList,
  },
});

mock.module('../src/notify.ts', {
  namedExports: {
    notify: async (kind: string, s: { slug: string; state: string }) => {
      notifications.push({ kind, slug: s.slug, state: s.state });
    },
    syncGroupCard: async () => {},
  },
});

mock.module('../src/writes.ts', {
  namedExports: {
    doWrites: async () => {
      writeCalls++;
      return {
        ok: true,
        stdout: 'created',
        issues: [{ repo: 'example-project', number: 10, url: 'https://github.com/your-org/example-project/issues/10' }],
      };
    },
    maybeCommitDeliveryDocs: async () => ({ ok: true, committed: false }),
  },
});

mock.module('../src/workspace.ts', {
  namedExports: {
    prMergeState: async () => ({ ok: true, merged: true, state: 'MERGED' }),
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
  },
});

mock.module('../src/util/load.ts', { namedExports: { probeLoad: async () => [] } });

const sessions = await import('../src/store/sessions.ts');
const { db, prep } = await import('../src/store/db.ts');
const { startHealthServer } = await import('../src/health/server.ts');

let server: ReturnType<typeof startHealthServer>;
let base = '';

before(async () => {
  server = startHealthServer(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  db().exec('DELETE FROM session; DELETE FROM event_log;');
  webActor = 'M';
  writeCalls = 0;
  notifications.length = 0;
});

async function createAt(slug: string, state: string, fields: Record<string, unknown> = {}): Promise<void> {
  await sessions.create({ id: slug, slug, title: `T ${slug}`, branch: 'main' });
  prep('UPDATE session SET state = ? WHERE id = ?').run(state, slug);
  if (Object.keys(fields).length) await sessions.patch(slug, fields as never);
}

async function postAction(body: unknown, origin = base): Promise<Response> {
  return fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
}

test('面板 HTTP 生产流：同源浏览器点击“出技术方案”推进真状态并留 panel/action 审计', async () => {
  await createAt('panel-gateb', 'CONFIRMED');

  const r = await postAction({ action: 'gateb', slug: 'panel-gateb' });
  const j = await r.json() as { ok: boolean; msg: string };

  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal((await sessions.get('panel-gateb'))!.state, 'GATE_B_REQUESTED');
  assert.ok((await sessions.events('panel-gateb')).some((e) => e.kind === 'panel_action' && (e.detail ?? '').includes('"by":"M"')));
  assert.equal(writeCalls, 0, '出技术方案只是授权进入闸B，不应直接触发写入');
});

test('面板 HTTP 安全闸：localhost 跨端口 Origin 被拒，真 action 不执行、无 panel 审计', async () => {
  await createAt('panel-cross-port', 'CONFIRMED');
  const wrongPortOrigin = base.replace(/:\d+$/, ':9');

  const r = await postAction({ action: 'gateb', slug: 'panel-cross-port' }, wrongPortOrigin);

  assert.equal(r.status, 403);
  assert.equal((await sessions.get('panel-cross-port'))!.state, 'CONFIRMED');
  assert.equal((await sessions.events('panel-cross-port')).some((e) => e.kind === 'panel_action'), false);
});

test('面板 HTTP 生产流：无权 web_actor 点 retry 不会重新点燃失败闸', async () => {
  webActor = 'BD';
  await createAt('panel-retry-denied', 'GATE_C_FAILED', { worktree_path: '/tmp/forge-wt', error: 'ci red' });

  const r = await postAction({ action: 'retry', slug: 'panel-retry-denied' });
  const j = await r.json() as { ok: boolean; msg: string };

  assert.equal(r.status, 400);
  assert.equal(j.ok, false);
  assert.match(j.msg, /无重试权限/);
  assert.equal((await sessions.get('panel-retry-denied'))!.state, 'GATE_C_FAILED');
  assert.ok((await sessions.events('panel-retry-denied')).some((e) => e.kind === 'permission_denied' && (e.detail ?? '').includes('"by":"BD"')));
  assert.equal(writeCalls, 0);
});

test('面板 HTTP 生产流：WRITE_FAILED 的按钮走真 go 恢复 DONE，不走 retry 空转', async () => {
  await createAt('panel-write-retry', 'WRITE_FAILED', { assignee: 'M', error: 'label failed' });

  const r = await postAction({ action: 'go', slug: 'panel-write-retry' });
  const j = await r.json() as { ok: boolean; msg: string };

  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal((await sessions.get('panel-write-retry'))!.state, 'DONE');
  assert.equal(writeCalls, 1);
  assert.ok(notifications.some((n) => n.kind === 'done' && n.slug === 'panel-write-retry'));
});
