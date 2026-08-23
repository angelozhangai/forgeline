// Integration: the real operator-permission chain behind a card that several people can press.
// Only the IM, notification and write-action boundaries are mocked; listen -> resolveActor -> actions ->
// the session, the events and the receipt all run for real.
// No mirror testing: it inspects no internal branch, only whether a real person pressing the card moves the
// state in production, leaves an audit record, and gets the right receipt.
process.env.FORGE_DB = ':memory:';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CardColor, InboundCardAction } from '../src/messaging/model.ts';
import type { MessagingPort } from '../src/messaging/port.ts';

const cfg = {
  runtime: {
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
  routing: {
    min_confidence: 0.7,
    sensitive_areas: [],
    reviewers: { M: 'ming', BD: 'bob' },
    lead: 'M',
  },
  permissions: {
    gate_b_allowed: ['M', 'BD'],
    go_approvers: ['M'],
    operators: { ou_m: 'M', ou_jt: 'BD' },
  },
  assignment: { pool: ['M', 'BD'], wip_limit: { default: 2 }, in_progress_statuses: [3] },
  // Config divergence: the acme project overrides gate_b_allowed to [EO] and adds its own operators
  // (ou_xw -> EO). operators is an identity map, so merging keeps the global ou_m and ou_jt.
  projects: { default_project: 'demo', projects: { acme: { root: '/tmp/acme', permissions: { gate_b_allowed: ['EO'], operators: { ou_xw: 'EO' } } } } },
  env: {},
};

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
    loadConfig: () => cfg,
    resolveLogin,
    inAllowList,
  },
});

let parsedAction: InboundCardAction | null = null;
const dmTexts: { title: string; lines: string[]; color: CardColor }[] = [];

const port: MessagingPort = {
  sendDmCard: async () => true,
  sendDmText: async (title, lines, color) => {
    dmTexts.push({ title, lines, color });
    return true;
  },
  replyGroupCard: async () => 'reply-card',
  sendGroupCard: async () => 'group-card',
  editGroupCard: async () => true,
  postWebhook: async () => true,
  parseCardAction: () => parsedAction,
  parseMessage: () => null,
  inboundConfigured: () => false,
  startInbound: () => ({ connect: async () => {} }),
  probe: async () => ({ available: false, ok: false, detail: 'stub' }),
};

mock.module('../src/messaging/index.ts', { namedExports: { port } });

const notifyCalls: { kind: string; slug: string; state: string }[] = [];
mock.module('../src/notify.ts', {
  namedExports: {
    notify: async (kind: string, s: { slug: string; state: string }) => {
      notifyCalls.push({ kind, slug: s.slug, state: s.state });
    },
    syncGroupCard: async () => {},
  },
});

let tickCalls = 0;
mock.module('../src/orchestrator/worker.ts', {
  namedExports: {
    tick: async () => {
      tickCalls++;
    },
  },
});

mock.module('../src/intake.ts', { namedExports: { addPrd: async () => ({ ok: true, msg: 'mocked intake' }) } });
mock.module('../src/messaging/backfill.ts', { namedExports: { backfillAll: async () => {} } });
mock.module('../src/health/alert.ts', { namedExports: { sendHealthAlert: async () => {} } });
mock.module('../src/writes.ts', {
  namedExports: {
    doWrites: async () => {
      throw new Error('this test should never reach a real write');
    },
  },
});
mock.module('../src/workspace.ts', {
  namedExports: {
    prMergeState: async () => ({ ok: true, merged: true, state: 'MERGED' }),
    commitDeliveryDocs: async () => ({ ok: true, committed: false, stderr: '' }),
  },
});

const sessions = await import('../src/store/sessions.ts');
const { __handleCardActionForTest } = await import('../src/daemon/listen.ts');

let seq = 0;

function reset(): void {
  parsedAction = null;
  dmTexts.length = 0;
  notifyCalls.length = 0;
  tickCalls = 0;
}

async function sessionAt(state: 'GATE_A_STALLED' | 'CONFIRMED' | 'AWAITING_GO'): Promise<string> {
  const id = `card-operator-${state.toLowerCase()}-${++seq}`;
  await sessions.create({ id, slug: id, title: 'multi-person permission check', branch: 'main' });
  const path: Record<typeof state, string[]> = {
    GATE_A_STALLED: ['GATE_A_RUNNING', 'GATE_A_STALLED'],
    CONFIRMED: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED'],
    AWAITING_GO: ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED', 'GATE_B_REQUESTED', 'GATE_B_RUNNING', 'ADVERSARIAL_LOOP', 'AWAITING_GO'],
  };
  for (const next of path[state]) await sessions.transition(id, next as never);
  if (state === 'AWAITING_GO') await sessions.patch(id, { assignee: 'M' });
  return id;
}

async function click(action: string, slug: string, operatorId: string, formValues: Record<string, string> = {}): Promise<void> {
  parsedAction = {
    type: 'card_action',
    action,
    slug,
    value: { action, slug },
    formValues,
    operatorId,
  };
  await __handleCardActionForTest({ raw: { event: { operator: { open_id: operatorId } } } });
}

test('a stranger pressing force-through: it does not reach CONFIRMED, an audit record is left, and they get a refusal receipt', async () => {
  reset();
  const slug = await sessionAt('GATE_A_STALLED');

  await click('force_confirm', slug, 'ou_stranger');

  assert.equal((await sessions.get(slug))!.state, 'GATE_A_STALLED');
  assert.ok((await sessions.events(slug)).some((e) => e.kind === 'permission_denied' && (e.detail ?? '').includes('confirm')));
  assert.equal(notifyCalls.length, 0, 'an unauthorised force-through must not send needs_gateb and let the team believe it was confirmed');
  assert.match(dmTexts.at(-1)?.lines.join('\n') ?? '', /may not confirm/);
});

test('the authorised maintainer pressing force-through: the real card chain reaches CONFIRMED and notifies that gate B is due', async () => {
  reset();
  const slug = await sessionAt('GATE_A_STALLED');

  await click('force_confirm', slug, 'ou_m');

  const s = (await sessions.get(slug))!;
  assert.equal(s.state, 'CONFIRMED');
  assert.equal(s.confirmed_by, 'M');
  assert.ok((await sessions.events(slug)).some((e) => e.kind === 'pm_confirm'));
  assert.deepEqual(notifyCalls.map((n) => n.kind), ['needs_gateb']);
  assert.equal(dmTexts.length, 0, 'a successful force-through should not also send a refusal receipt');
});

test('BD may produce the technical plan but may not give the go-ahead: the same real person gets different permission outcomes on different product actions', async () => {
  reset();
  const gatebSlug = await sessionAt('CONFIRMED');
  await click('gateb', gatebSlug, 'ou_jt');

  assert.equal((await sessions.get(gatebSlug))!.state, 'GATE_B_REQUESTED');
  assert.equal((await sessions.get(gatebSlug))!.gate_b_requested_by, 'BD');
  assert.equal(tickCalls, 1, 'an authorised gate B trigger should push the worker forward immediately');

  reset();
  const goSlug = await sessionAt('AWAITING_GO');
  await click('go', goSlug, 'ou_jt', { assignee: 'BD' });

  assert.equal((await sessions.get(goSlug))!.state, 'AWAITING_GO');
  assert.ok((await sessions.events(goSlug)).some((e) => e.kind === 'permission_denied' && (e.detail ?? '').includes('go')));
  assert.match(dmTexts.at(-1)?.lines.join('\n') ?? '', /may not GO/);
});

test('project-level operators (config divergence, the blocker): on an acme card ou_xw resolves to EO and passes acme\'s own gate_b_allowed, while the global ou_m -> M that merging preserved is refused because M is not on acme\'s list', async () => {
  reset();
  // A CONFIRMED session belonging to the acme project.
  const slug = `card-operator-acme-${++seq}`;
  await sessions.create({ id: slug, slug, title: 'project-level operators', branch: 'main', project_id: 'acme' } as never);
  for (const next of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED']) await sessions.transition(slug, next as never);

  await click('gateb', slug, 'ou_xw'); // acme's operators resolve ou_xw -> EO, and acme's gate_b_allowed=[EO] lets it through -- never by falling back to the global list or to M alone
  assert.equal((await sessions.get(slug))!.state, 'GATE_B_REQUESTED');
  assert.equal((await sessions.get(slug))!.gate_b_requested_by, 'EO');

  reset();
  const slug2 = `card-operator-acme-${++seq}`;
  await sessions.create({ id: slug2, slug: slug2, title: 'an inherited global operator', branch: 'main', project_id: 'acme' } as never);
  for (const next of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED']) await sessions.transition(slug2, next as never);

  await click('gateb', slug2, 'ou_m'); // merging kept the global ou_m -> M, so the identity is not lost, but M is not in acme's gate_b_allowed=[EO] -> refused
  assert.equal((await sessions.get(slug2))!.state, 'CONFIRMED');
  assert.ok((await sessions.events(slug2)).some((e) => e.kind === 'permission_denied' && (e.detail ?? '').includes('gateb')));
});

test('a stranger pressing deny does not reach GO_DENIED; only the authorised maintainer really sends it back', async () => {
  reset();
  const strangerSlug = await sessionAt('AWAITING_GO');
  await click('deny', strangerSlug, 'ou_stranger');

  assert.equal((await sessions.get(strangerSlug))!.state, 'AWAITING_GO');
  assert.ok((await sessions.events(strangerSlug)).some((e) => e.kind === 'permission_denied' && (e.detail ?? '').includes('deny')));
  assert.match(dmTexts.at(-1)?.lines.join('\n') ?? '', /may not send it back/);

  reset();
  const mSlug = await sessionAt('AWAITING_GO');
  await click('deny', mSlug, 'ou_m');

  assert.equal((await sessions.get(mSlug))!.state, 'GO_DENIED');
  assert.ok((await sessions.events(mSlug)).some((e) => e.kind === 'go_denied'));
  assert.match(dmTexts.at(-1)?.lines.join('\n') ?? '', /sent back/);
});
