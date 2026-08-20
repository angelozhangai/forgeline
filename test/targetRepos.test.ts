// 单测：目标代码仓选择（纯函数）。顶层规则——实现锚到需求真正动的仓；仅取 proj.repos 内有效仓、保序去重；空回退首仓。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetRepos, targetReposOf, primaryTargetRepo } from '../src/util/targetRepos.ts';

const PROJ = ['demo', 'example-web', 'example-admin', 'example-engine'];
// 生产 repoMap（projects.ts DEFAULT_REPO_MAP）：闸A repos_touched 产**字母** C/U/A/E。
const MAP = { C: 'demo', U: 'example-web', A: 'example-admin', E: 'example-engine' };

// ── 生产口径：闸A 给字母，必须经 repoMap normalize 成仓名（Codex Blocker：没 repoMap 时 ["U"]/["A"] 全落空回退首仓）──
test('resolveTargetRepos：闸A 字母 C/U/A/E → 对应仓名（链式真链路）', () => {
  assert.deepEqual(resolveTargetRepos(['U'], PROJ, MAP), ['example-web']);
  assert.deepEqual(resolveTargetRepos(['A'], PROJ, MAP), ['example-admin']);
  assert.deepEqual(resolveTargetRepos(['E'], PROJ, MAP), ['example-engine']);
  assert.deepEqual(resolveTargetRepos(['C', 'U'], PROJ, MAP), ['demo', 'example-web']);
});

test('resolveTargetRepos：没传 repoMap 时字母无从映射 → 落空回退首仓（正是被修掉的错锚老行为，留作回归锚）', () => {
  assert.deepEqual(resolveTargetRepos(['U'], PROJ), ['demo']); // 无 repoMap：U 不匹配仓名 → 回退 demo（错）
  assert.deepEqual(resolveTargetRepos(['U'], PROJ, MAP), ['example-web']); // 有 repoMap：正确
});

test('resolveTargetRepos：未知字母 Z 无映射 → 落空回退首仓（不杜撰仓）；仓名输入也兼容（standalone 传名）', () => {
  assert.deepEqual(resolveTargetRepos(['Z'], PROJ, MAP), ['demo']);
  assert.deepEqual(resolveTargetRepos(['example-web'], PROJ, MAP), ['example-web']); // 已是仓名 → 原样
});

test('resolveTargetRepos：touched ∩ proj.repos，保序去重', () => {
  assert.deepEqual(resolveTargetRepos(['example-web', 'demo', 'example-web'], PROJ), ['example-web', 'demo']);
});

test('resolveTargetRepos：剔除不在 proj.repos 的仓（绝不在错仓建树）', () => {
  assert.deepEqual(resolveTargetRepos(['demo', 'unknown-repo'], PROJ), ['demo']);
});

test('resolveTargetRepos：空 / 全无效 → 回退首仓（实现绝不无仓可落）', () => {
  assert.deepEqual(resolveTargetRepos([], PROJ), ['demo']);
  assert.deepEqual(resolveTargetRepos(['nope'], PROJ), ['demo']);
  assert.deepEqual(resolveTargetRepos([], []), []); // 项目无仓 → 空（不杜撰）
});

test('targetReposOf：读 session.target_repos json；坏/空回退首仓', () => {
  assert.deepEqual(targetReposOf({ target_repos: '["example-web"]' }, PROJ), ['example-web']);
  assert.deepEqual(targetReposOf({ target_repos: null }, PROJ), ['demo']); // 缺 → 首仓
  assert.deepEqual(targetReposOf({ target_repos: '{坏json' }, PROJ), ['demo']); // 坏 json → 首仓，不抛
  assert.deepEqual(targetReposOf({ target_repos: '"非数组"' }, PROJ), ['demo']); // 非数组 → 首仓
});

test('primaryTargetRepo：取 target_repos[0]；缺 → proj.repos[0] → .', () => {
  assert.equal(primaryTargetRepo({ target_repos: '["example-admin","demo"]' }, PROJ), 'example-admin');
  assert.equal(primaryTargetRepo({ target_repos: null }, PROJ), 'demo');
  assert.equal(primaryTargetRepo({ target_repos: null }, []), '.'); // 项目无仓 → '.'（monorepo 兜底）
});
