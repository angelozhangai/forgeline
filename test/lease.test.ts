// 单测：lease（多 runner 防重领）的原子领取语义 store.leaseClaim()。
// 守四条：① 两 runner 不重领同一 job；② 过期租约可被另一 runner 重领（持有者疑似已死）；
//         ③ 自持续租（同 runner 再领拿回自己的并延期）；④ 领取**绝不 bump updated_at**（否则刷掉 remindStuck idle 判定）。
// 必须在导入前设 FORGE_DB（真 node:sqlite，:memory:）。直 import 实现（实现单测，护栏只管 src 消费方）。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { localSqliteStore: store } = await import('../src/store/sessions.ts');

function mk(id: string, state: string): Promise<unknown> {
  return store.create({ id, slug: id, title: `T ${id}`, branch: 'dev', state: state as never });
}

// 每个 test 用**独立 poller 状态**领取，避开共享 :memory: 库里别的 test 已建/已占租的 session（否则 state 过滤会
// 跨 test 捞到它们）。每个状态都属 POLLER_DRIVEN。

test('lease①：两 runner 不重领——A 领走后 B 同刻领到空', async () => {
  await mk('L1', 'INTAKE');
  await mk('L2', 'GATE_C_LOOP');
  await mk('Lh', 'AWAITING_GO'); // 不在 states 集 → 永不被领（人等态）

  const states = ['INTAKE', 'GATE_C_LOOP'] as never;
  const a = await store.leaseClaim(states, 'runnerA', 60_000, 100);
  assert.deepEqual(a.map((s) => s.id).sort(), ['L1', 'L2']);
  // B 同刻领：L1/L2 已被 A 占租（未过期、非 B 持有）→ 空，绝不重领。
  const b = await store.leaseClaim(states, 'runnerB', 60_000, 100);
  assert.deepEqual(b, []);
  // 落库的 owner 确是 A。
  assert.equal((await store.get('L1'))!.lease_owner, 'runnerA');
  assert.equal((await store.get('Lh'))!.lease_owner, null); // 人等态从未被领
});

test('lease②：过期租约被另一 runner 重领（持有者疑似已死）', async () => {
  await mk('E1', 'GATE_B_REQUESTED'); // 本 test 专属状态，避开 lease① 的 INTAKE
  // A 以**已过期**租约领走（ttl 负 → expires 在过去）。
  const a = await store.leaseClaim(['GATE_B_REQUESTED'] as never, 'runnerA', -1000, 100);
  assert.deepEqual(a.map((s) => s.id), ['E1']);
  // B 领：A 的租约已过期（expires < now）→ B 重领到。
  const b = await store.leaseClaim(['GATE_B_REQUESTED'] as never, 'runnerB', 60_000, 100);
  assert.deepEqual(b.map((s) => s.id), ['E1']);
  assert.equal((await store.get('E1'))!.lease_owner, 'runnerB');
});

test('lease③：自持续租——同 runner 再领拿回自己的并延期', async () => {
  await mk('R1', 'GATE_D_LOOP'); // 本 test 专属状态
  const first = await store.leaseClaim(['GATE_D_LOOP'] as never, 'runnerA', 60_000, 100);
  const exp1 = first[0]!.lease_expires_at!;
  const again = await store.leaseClaim(['GATE_D_LOOP'] as never, 'runnerA', 120_000, 100);
  assert.deepEqual(again.map((s) => s.id), ['R1']); // 自持分支 → 拿回
  assert.ok((again[0]!.lease_expires_at ?? 0) >= exp1, '续租应延长到期时刻');
});

test('lease④：领取绝不 bump updated_at（不刷 remindStuck 的 idle 判定）', async () => {
  await mk('U1', 'GATE_C_REQUESTED'); // 本 test 专属状态
  const before = (await store.get('U1'))!.updated_at;
  await store.leaseClaim(['GATE_C_REQUESTED'] as never, 'runnerA', 60_000, 100);
  const after = (await store.get('U1'))!.updated_at;
  assert.equal(after, before, 'leaseClaim 改的是 lease 列、绝不能动 updated_at');
});

test('lease⑤：空 states / limit<1 → 空（不误领全表）', async () => {
  assert.deepEqual(await store.leaseClaim([] as never, 'runnerA', 60_000, 100), []);
  await mk('Z1', 'GATE_A_ADVERSARIAL');
  assert.deepEqual(await store.leaseClaim(['GATE_A_ADVERSARIAL'] as never, 'runnerA', 60_000, 0), []);
});

test('lease⑥：limit 限定每轮领取量 + 不重领（A 领 2、B 领剩 1，合计 3 无重叠——不一次占租整批 backlog）', async () => {
  await mk('F1', 'GATE_D_REQUESTED'); // 本 test 专属状态
  await mk('F2', 'GATE_D_REQUESTED');
  await mk('F3', 'GATE_D_REQUESTED');
  const a = await store.leaseClaim(['GATE_D_REQUESTED'] as never, 'runnerA', 60_000, 2);
  assert.equal(a.length, 2, 'A 本轮只领 limit=2 条（绝不一次占租整批）');
  const b = await store.leaseClaim(['GATE_D_REQUESTED'] as never, 'runnerB', 60_000, 2);
  assert.equal(b.length, 1, 'B 领到 A 没占的剩 1 条（backlog 分摊）');
  assert.deepEqual([...a, ...b].map((s) => s.id).sort(), ['F1', 'F2', 'F3'], '三条全被领、无重叠（无重领）');
});
