// 单测：多仓「每仓一腿」模型 helpers（src/gates/legs.ts）。纯函数（mkLeg/getLegs/buildLegs）+ setLegs/patchLeg 落库。
// 真 sessions(:memory:)——patchLeg 从 DB 重读 legs（防同一 stale 引用连写多条互相覆盖），故须真库验证该不变量。
process.env.FORGE_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sessions = await import('../src/store/sessions.ts');
const { mkLeg, getLegs, buildLegs, setLegs, patchLeg, planLegAdvance, planGateDAdvance } = await import('../src/gates/legs.ts');

let n = 0;
async function mk(): Promise<string> {
  const id = `leg${++n}`;
  await sessions.create({ id, slug: id, title: 'T', branch: 'main' });
  return id;
}

test('mkLeg：仅锚仓名，其余字段空(pending)；fields 可覆盖', () => {
  const l = mkLeg('demo');
  assert.equal(l.repo, 'demo');
  assert.equal(l.worktree_path, null);
  assert.equal(l.ci_ok, null);
  assert.equal(l.merged, null);
  const built = mkLeg('demo', { worktree_path: '/wt', base_sha: 'abc' });
  assert.equal(built.worktree_path, '/wt');
  assert.equal(built.base_sha, 'abc');
});

test('getLegs：坏/空/非数组 json → []；正常解析', () => {
  assert.deepEqual(getLegs({ legs: null }), []);
  assert.deepEqual(getLegs({ legs: '{坏json' }), []);
  assert.deepEqual(getLegs({ legs: '"非数组"' }), []);
  assert.equal(getLegs({ legs: JSON.stringify([mkLeg('demo')]) }).length, 1);
});

test('buildLegs：保序，builder 填字段(primary 建树、其余 pending)', () => {
  const legs = buildLegs(['demo', 'example-web'], (_r, i) => (i === 0 ? { worktree_path: '/wt/demo' } : {}));
  assert.deepEqual(
    legs.map((l) => l.repo),
    ['demo', 'example-web'],
  );
  assert.equal(legs[0].worktree_path, '/wt/demo');
  assert.equal(legs[1].worktree_path, null);
});

test('setLegs：整组落库', async () => {
  const id = await mk();
  await setLegs({ id }, [mkLeg('demo')]);
  assert.deepEqual(
    getLegs((await sessions.get(id))!).map((l) => l.repo),
    ['demo'],
  );
});

test('patchLeg：按 repo 更新一条；repo 不存在则不变(不冒进新增)', async () => {
  const id = await mk();
  await setLegs({ id }, [mkLeg('demo'), mkLeg('example-web')]);
  await patchLeg({ id }, 'example-web', { ci_ok: true });
  const legs = getLegs((await sessions.get(id))!);
  assert.equal(legs.find((l) => l.repo === 'example-web')!.ci_ok, true);
  assert.equal(legs.find((l) => l.repo === 'demo')!.ci_ok, null); // 只动目标腿
  await patchLeg({ id }, 'nope-repo', { ci_ok: true });
  assert.equal(getLegs((await sessions.get(id))!).length, 2); // 不存在的 repo 不新增
});

test('planLegAdvance：标记当前 leg 绿后，返回下一条未绿且已建树的 repo；全绿 → null', () => {
  const legs = [
    mkLeg('demo', { worktree_path: '/wt/c' }),
    mkLeg('example-web', { worktree_path: '/wt/u' }),
    mkLeg('example-admin', { worktree_path: '/wt/a' }),
  ];
  assert.equal(planLegAdvance(legs, 'demo').nextRepo, 'example-web'); // 绿了 demo → 下一条
  const after1 = legs.map((l) => (['demo', 'example-web'].includes(l.repo) ? { ...l, ci_ok: true } : l));
  assert.equal(planLegAdvance(after1, 'example-admin').nextRepo, null); // 绿了最后一条 → 全绿
  assert.equal(planLegAdvance([mkLeg('demo', { worktree_path: '/wt/c' })], 'demo').nextRepo, null); // 单仓绿 → null
  // 未建树的 leg（worktree 空）不作为下一步（2b setup 全建了，此为防御）
  assert.equal(planLegAdvance([mkLeg('demo', { worktree_path: '/wt/c' }), mkLeg('example-web')], 'demo').nextRepo, null);
});

test('planGateDAdvance：标记当前 leg 过闸D 后，返回下一条已开 PR、已建树、未过闸D 的 repo；全过 → null', () => {
  const legs = [
    mkLeg('demo', { worktree_path: '/wt/c', pr_url: 'PC' }),
    mkLeg('example-web', { worktree_path: '/wt/u', pr_url: 'PU' }),
    mkLeg('example-admin', { worktree_path: '/wt/a', pr_url: 'PA' }),
  ];
  assert.equal(planGateDAdvance(legs, 'demo').nextRepo, 'example-web'); // demo 补强完 → 下一条
  // demo/example 都过闸D（有 verified sha）→ 下一条 admin
  const after2 = legs.map((l) => (['demo', 'example-web'].includes(l.repo) ? { ...l, gate_d_harden_verified_sha: 'V' } : l));
  assert.equal(planGateDAdvance(after2, 'example-admin').nextRepo, null); // 最后一条补强完 → 全过
  assert.equal(planGateDAdvance([mkLeg('demo', { worktree_path: '/wt/c', pr_url: 'PC' })], 'demo').nextRepo, null); // 单仓 → null
});

test('planGateDAdvance：未开 PR / 未建树的 leg 不作为下一步（防御：理论上闸C/openReviewPr 全建全开）', () => {
  // 下一条无 pr_url → 不推进（PR 没开过，不能审）
  assert.equal(
    planGateDAdvance([mkLeg('demo', { worktree_path: '/wt/c', pr_url: 'PC' }), mkLeg('example-web', { worktree_path: '/wt/u' })], 'demo').nextRepo,
    null,
  );
  // 下一条无 worktree → 不推进
  assert.equal(
    planGateDAdvance([mkLeg('demo', { worktree_path: '/wt/c', pr_url: 'PC' }), mkLeg('example-web', { pr_url: 'PU' })], 'demo').nextRepo,
    null,
  );
});

test('patchLeg：从 DB 重读——同一 stale 引用连写多条 leg 不互相覆盖（openReviewPr 逐 leg 开 PR 场景）', async () => {
  const id = await mk();
  await setLegs({ id }, [mkLeg('demo'), mkLeg('example-web')]);
  const stale = (await sessions.get(id))!; // 旧快照：legs 两条均无 pr_url
  await patchLeg(stale, 'demo', { pr_url: 'A' });
  await patchLeg(stale, 'example-web', { pr_url: 'B' }); // 仍用 stale，但 patchLeg 内部从 DB 重读最新
  const legs = getLegs((await sessions.get(id))!);
  assert.equal(legs.find((l) => l.repo === 'demo')!.pr_url, 'A'); // 没被第二次 patch 覆盖（旧实现这里会变 null）
  assert.equal(legs.find((l) => l.repo === 'example-web')!.pr_url, 'B');
});
