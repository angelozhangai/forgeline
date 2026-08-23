// 集成：多人卡片入口的真实操作者权限链路。
// 只 mock IM/通知/写动作边界；listen → resolveActor → actions → session/events/回执走真实代码。
// 禁止镜像测试：不检查内部分支，只验证真实点击人点卡后，生产上状态是否被推进、是否留审计、是否给对的回执。
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
  // 配置分化：acme 项目覆盖 gate_b_allowed=[EO] + 自己的 operators(ou_xw→EO)。operators 是身份映射 → map 合并保留全局 ou_m/ou_jt。
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
      throw new Error('本测试不应走真实写入');
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
  await sessions.create({ id, slug: id, title: '多人权限验证', branch: 'main' });
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

test('陌生人点击强制通过：不推进 CONFIRMED，留审计，并给失败回执', async () => {
  reset();
  const slug = await sessionAt('GATE_A_STALLED');

  await click('force_confirm', slug, 'ou_stranger');

  assert.equal((await sessions.get(slug))!.state, 'GATE_A_STALLED');
  assert.ok((await sessions.events(slug)).some((e) => e.kind === 'permission_denied' && (e.detail ?? '').includes('confirm')));
  assert.equal(notifyCalls.length, 0, '越权强制通过不应发 needs_gateb，让团队误以为已确认');
  assert.match(dmTexts.at(-1)?.lines.join('\n') ?? '', /may not confirm/);
});

test('授权 M 点击强制通过：真实卡片链路推进 CONFIRMED 并通知出闸B', async () => {
  reset();
  const slug = await sessionAt('GATE_A_STALLED');

  await click('force_confirm', slug, 'ou_m');

  const s = (await sessions.get(slug))!;
  assert.equal(s.state, 'CONFIRMED');
  assert.equal(s.confirmed_by, 'M');
  assert.ok((await sessions.events(slug)).some((e) => e.kind === 'pm_confirm'));
  assert.deepEqual(notifyCalls.map((n) => n.kind), ['needs_gateb']);
  assert.equal(dmTexts.length, 0, '成功强制通过不应额外发失败回执');
});

test('BD 可出技术方案但不能 GO：同一真实点击人在不同产品动作上得到不同权限后果', async () => {
  reset();
  const gatebSlug = await sessionAt('CONFIRMED');
  await click('gateb', gatebSlug, 'ou_jt');

  assert.equal((await sessions.get(gatebSlug))!.state, 'GATE_B_REQUESTED');
  assert.equal((await sessions.get(gatebSlug))!.gate_b_requested_by, 'BD');
  assert.equal(tickCalls, 1, '授权触发闸B后应立即推进 worker');

  reset();
  const goSlug = await sessionAt('AWAITING_GO');
  await click('go', goSlug, 'ou_jt', { assignee: 'BD' });

  assert.equal((await sessions.get(goSlug))!.state, 'AWAITING_GO');
  assert.ok((await sessions.events(goSlug)).some((e) => e.kind === 'permission_denied' && (e.detail ?? '').includes('go')));
  assert.match(dmTexts.at(-1)?.lines.join('\n') ?? '', /may not GO/);
});

test('项目级 operators（配置分化·Blocker）：acme 卡 ou_xw→EO 过 acme 自己的 gate_b_allowed；map 合并保留的全局 ou_m→M 不在 acme 名单被拒', async () => {
  reset();
  // acme 项目的 CONFIRMED session
  const slug = `card-operator-acme-${++seq}`;
  await sessions.create({ id: slug, slug, title: '项目级 operators', branch: 'main', project_id: 'acme' } as never);
  for (const next of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED']) await sessions.transition(slug, next as never);

  await click('gateb', slug, 'ou_xw'); // acme operators 解析 ou_xw→EO；acme gate_b_allowed=[EO] → 过（绝非回退全局/单人 M）
  assert.equal((await sessions.get(slug))!.state, 'GATE_B_REQUESTED');
  assert.equal((await sessions.get(slug))!.gate_b_requested_by, 'EO');

  reset();
  const slug2 = `card-operator-acme-${++seq}`;
  await sessions.create({ id: slug2, slug: slug2, title: '继承全局 operator', branch: 'main', project_id: 'acme' } as never);
  for (const next of ['GATE_A_RUNNING', 'AWAITING_PM_CONFIRM', 'CONFIRMED']) await sessions.transition(slug2, next as never);

  await click('gateb', slug2, 'ou_m'); // map 合并保留全局 ou_m→M（身份不丢）；但 M 不在 acme gate_b_allowed=[EO] → 拒
  assert.equal((await sessions.get(slug2))!.state, 'CONFIRMED');
  assert.ok((await sessions.events(slug2)).some((e) => e.kind === 'permission_denied' && (e.detail ?? '').includes('gateb')));
});

test('陌生人点击打回：不进入 GO_DENIED；授权 M 点击才真正打回', async () => {
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
