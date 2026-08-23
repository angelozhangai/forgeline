// Integration: the production chain from the web panel's real HTTP POST entry point through to actions and
// the state database.
// No mirror testing: it copies neither the state table nor the permission table, and checks only the outward
// consequences of someone pressing a button on the local panel -- the HTTP response, the state moving, the
// audit record, and whether a write was called.
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

test('the panel HTTP production flow: a same-origin browser pressing "produce the technical plan" moves the real state and leaves a panel/action audit record', async () => {
  await createAt('panel-gateb', 'CONFIRMED');

  const r = await postAction({ action: 'gateb', slug: 'panel-gateb' });
  const j = await r.json() as { ok: boolean; msg: string };

  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal((await sessions.get('panel-gateb'))!.state, 'GATE_B_REQUESTED');
  assert.ok((await sessions.events('panel-gateb')).some((e) => e.kind === 'panel_action' && (e.detail ?? '').includes('"by":"M"')));
  assert.equal(writeCalls, 0, 'producing the technical plan only authorises entry to gate B and should trigger no write of its own');
});

test('the panel HTTP security gate: a localhost Origin on a different port is refused, the real action never runs, and no panel audit record is left', async () => {
  await createAt('panel-cross-port', 'CONFIRMED');
  const wrongPortOrigin = base.replace(/:\d+$/, ':9');

  const r = await postAction({ action: 'gateb', slug: 'panel-cross-port' }, wrongPortOrigin);

  assert.equal(r.status, 403);
  assert.equal((await sessions.get('panel-cross-port'))!.state, 'CONFIRMED');
  assert.equal((await sessions.events('panel-cross-port')).some((e) => e.kind === 'panel_action'), false);
});

test('the panel HTTP production flow: a web_actor without the permission pressing retry does not restart the failed gate', async () => {
  webActor = 'BD';
  await createAt('panel-retry-denied', 'GATE_C_FAILED', { worktree_path: '/tmp/forge-wt', error: 'ci red' });

  const r = await postAction({ action: 'retry', slug: 'panel-retry-denied' });
  const j = await r.json() as { ok: boolean; msg: string };

  assert.equal(r.status, 400);
  assert.equal(j.ok, false);
  assert.match(j.msg, /may not retry/);
  assert.equal((await sessions.get('panel-retry-denied'))!.state, 'GATE_C_FAILED');
  assert.ok((await sessions.events('panel-retry-denied')).some((e) => e.kind === 'permission_denied' && (e.detail ?? '').includes('"by":"BD"')));
  assert.equal(writeCalls, 0);
});

test('the panel HTTP production flow: the button on a WRITE_FAILED session goes through the real go to reach DONE, rather than spinning on retry', async () => {
  await createAt('panel-write-retry', 'WRITE_FAILED', { assignee: 'M', error: 'label failed' });

  const r = await postAction({ action: 'go', slug: 'panel-write-retry' });
  const j = await r.json() as { ok: boolean; msg: string };

  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal((await sessions.get('panel-write-retry'))!.state, 'DONE');
  assert.equal(writeCalls, 1);
  assert.ok(notifications.some((n) => n.kind === 'done' && n.slug === 'panel-write-retry'));
});
