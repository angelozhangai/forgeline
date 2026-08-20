// 单元：当前在研负载聚合（scoreLoad，纯函数）。⚠️ 口径镜像主仓 weekly-load（规模×跨栈），改口径先改主仓。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLoad, crossStack, buildRepoCode, type LoadIssue } from '../src/util/load.ts';

const OPTS = { inProgressStatuses: [4, 5, 6] };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const iss = (repo: string, number: number, labels: string[]): LoadIssue => ({ repo, number, labels });

test('crossStack：单仓1.0 / 两仓1.3 / 三仓1.5', () => {
  assert.equal(crossStack(1), 1.0);
  assert.equal(crossStack(2), 1.3);
  assert.equal(crossStack(3), 1.5);
});

test('epic 跨两仓合并成 1 条需求，不重复计数；跨栈×1.3，size 取最高档', () => {
  const r = scoreLoad(
    [
      iss('demo', 1, ['epic:login', 'status:4-开发中', 'size:M']),
      iss('example-admin', 2, ['epic:login', 'status:5-review', 'size:L']),
    ],
    OPTS,
  );
  assert.equal(r.wip, 1);
  assert.equal(r.items[0].size, 'L'); // M 与 L 取最高
  assert.equal(r.items[0].span, 2);
  close(r.loadPoints, 8 * 1.3); // L=8 × 两仓1.3
});

test('单仓 issue 各算一条需求', () => {
  const r = scoreLoad(
    [
      iss('demo', 3, ['status:4-开发中', 'size:M']),
      iss('example-web', 4, ['status:6-测试中', 'size:S']),
    ],
    OPTS,
  );
  assert.equal(r.wip, 2);
  close(r.loadPoints, 3 + 1); // M×1 + S×1
});

test('只算在研：已上线(7)/早期(3)/无 status 一律不计入', () => {
  const r = scoreLoad(
    [
      iss('demo', 5, ['status:7-已上线', 'size:XL']),
      iss('demo', 6, ['status:3-待开发', 'size:L']),
      iss('demo', 7, ['size:M']), // 无 status
      iss('demo', 8, ['status:4-开发中', 'size:M']),
    ],
    OPTS,
  );
  assert.equal(r.wip, 1);
  close(r.loadPoints, 3);
});

test('size 缺省 M', () => {
  const r = scoreLoad([iss('demo', 9, ['status:4-开发中'])], OPTS);
  assert.equal(r.items[0].size, 'M');
  close(r.loadPoints, 3);
});

test('三仓 epic → 跨栈1.5；example-project(P) 是 Epic 本体不计入 span', () => {
  const r = scoreLoad(
    [
      iss('demo', 10, ['epic:big', 'status:4-开发中', 'size:M']),
      iss('example-web', 11, ['epic:big', 'status:4-开发中']),
      iss('example-admin', 12, ['epic:big', 'status:4-开发中']),
      iss('example-project', 13, ['epic:big', 'status:4-开发中']),
    ],
    OPTS,
  );
  assert.equal(r.wip, 1);
  assert.equal(r.items[0].span, 3); // C/U/A 三仓，P 不计
  close(r.loadPoints, 3 * 1.5);
});

test('Epic rollup 滞后：P 仍 3 但代码子仓已 4 → 按子仓判在研（不被滞后的 P 拖出）', () => {
  const r = scoreLoad(
    [
      iss('example-project', 20, ['epic:lag', 'status:3-待开发']), // P Epic rollup 未跑、仍滞后
      iss('demo', 21, ['epic:lag', 'status:4-开发中', 'size:M']),
      iss('example-admin', 22, ['epic:lag', 'status:4-开发中']),
    ],
    OPTS,
  );
  assert.equal(r.wip, 1); // 活跃跨仓需求，不该被算成空闲
  assert.equal(r.items[0].status, 4); // 取代码子仓 rollup，而非 P 的 3
  assert.equal(r.items[0].span, 2);
  close(r.loadPoints, 3 * 1.3);
});

test('纯 P 需求（暂无代码子 issue）→ 用 P 自身状态判在研', () => {
  const inProg = scoreLoad([iss('example-project', 30, ['epic:placeholder', 'status:4-开发中'])], OPTS);
  assert.equal(inProg.wip, 1);
  assert.equal(inProg.items[0].span, 1);
  const notYet = scoreLoad([iss('example-project', 31, ['epic:placeholder', 'status:3-待开发'])], OPTS);
  assert.equal(notYet.wip, 0); // P 仍待开发 → 不在研
});

test('空输入 → 0 负载', () => {
  const r = scoreLoad([], OPTS);
  assert.equal(r.wip, 0);
  assert.equal(r.loadPoints, 0);
});

// ── 跨栈字母口径按项目反推（Phase 0 深水：通用化 REPO_CODE）──
test('buildRepoCode：demo 仓身份反推 → 与硬编码 REPO_CODE 逐键相等（行为不变）', () => {
  const rc = buildRepoCode(
    { C: 'demo', U: 'example-web', A: 'example-admin', E: 'example-engine' },
    'example-project',
    {},
  );
  assert.deepEqual(rc, { demo: 'C', 'example-web': 'U', 'example-admin': 'A', 'example-engine': 'E', 'example-project': 'P' });
});

test('buildRepoCode：monorepo 伞仓即代码仓 → 保留代码字母不被 P 抹掉（slug 经 repoSlugs）', () => {
  const rc = buildRepoCode({ C: '.' }, '.', { '.': 'your-monorepo' });
  assert.deepEqual(rc, { 'your-monorepo': 'C' }, '伞仓 . 与代码仓 . 撞 → 保留 C，不标 P');
});

test('buildRepoCode：伞仓非代码仓 → 标 P（不计跨栈）', () => {
  const rc = buildRepoCode({ W: 'web', A: 'api' }, 'umbrella', {});
  assert.deepEqual(rc, { web: 'W', api: 'A', umbrella: 'P' });
});

test('scoreLoad：注入非 demo repoCode → 按该项目字母算跨栈（两仓×1.3）', () => {
  const repoCode = buildRepoCode({ W: 'web', A: 'api' }, 'umbrella', {});
  const r = scoreLoad(
    [
      iss('web', 1, ['epic:f', 'status:4-开发中', 'size:M']),
      iss('api', 2, ['epic:f', 'status:4-开发中']),
      iss('umbrella', 3, ['epic:f', 'status:4-开发中']), // 伞仓=Epic 本体，不计 span
    ],
    { ...OPTS, repoCode },
  );
  assert.equal(r.wip, 1);
  assert.equal(r.items[0].span, 2); // web/api 两仓，umbrella(P) 不计
  close(r.loadPoints, 3 * 1.3);
});
