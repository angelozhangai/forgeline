// 单测：JobSource 接缝（控制面/Runner 边界——jobs/port.ts 接口 + jobs/index.ts 选择点 + localJobSource adapter）。
// 守两条：① 选择点 `jobSource` 即 localJobSource（DB 枚举）；② claimDueJobs 只取 POLLER_DRIVEN 态 session
//（到期 job），人等态 / 终态绝不入 job 队列——与现状 tick 的 listByStates([...POLLER_DRIVEN]) 行为一致。
// 必须在导入前设 FORGE_DB（真 node:sqlite，:memory: 隔离）。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { store } = await import('../src/store/index.ts');
const { jobSource } = await import('../src/orchestrator/jobs/index.ts');
const { localJobSource } = await import('../src/orchestrator/jobs/local.ts');

function mk(id: string, state: string): void {
  store.create({ id, slug: id, title: `T ${id}`, branch: 'dev', state: state as never });
}

test('jobSource 选择点 = localJobSource（DB 枚举 adapter）', () => {
  assert.equal(jobSource, localJobSource);
  assert.equal(typeof jobSource.claimDueJobs, 'function');
});

test('claimDueJobs：只取 POLLER_DRIVEN 态（到期 job），人等态/终态不入队', async () => {
  mk('due-intake', 'INTAKE'); // POLLER_DRIVEN
  mk('due-cloop', 'GATE_C_LOOP'); // POLLER_DRIVEN
  mk('wait-go', 'AWAITING_GO'); // 人等态——不该入 job 队列
  mk('done', 'DONE'); // 终态——不该入 job 队列

  const ids = (await jobSource.claimDueJobs(100)).map((s) => s.id).sort();
  assert.deepEqual(ids, ['due-cloop', 'due-intake'], '只列 POLLER_DRIVEN 态');
  assert.ok(!ids.includes('wait-go') && !ids.includes('done'), '人等态/终态绝不入队');
});

test('claimDueJobs：返回的每条都属 POLLER_DRIVEN（不漏放非到期态）', async () => {
  // 与上一用例同库（已有 4 条）：断「返回集 ⊆ POLLER_DRIVEN」（非到期态不泄漏）。
  for (const s of await jobSource.claimDueJobs(100)) {
    assert.ok(['due-intake', 'due-cloop'].includes(s.id), `非到期态泄漏：${s.id}/${s.state}`);
  }
});
