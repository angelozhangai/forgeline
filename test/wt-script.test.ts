// Integration test for tools/wt.sh and the two mechanical gates (.githooks/lib/no-main-checkout.sh,
// .claude/hooks/guard-main-checkout.sh). It builds **real git repositories** (a bare origin plus a
// clone) and runs the real scripts: these three files are the only implementation of the "every
// change happens in a worktree" top rule, and mocking git out would test nothing at all. Dependency
// installation is switched off with WT_NO_INSTALL=1 -- the temporary repos have no lockfile, and
// npm ci has no place in a unit test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const WT = join(REPO, 'tools/wt.sh');
const NO_MAIN = join(REPO, '.githooks/lib/no-main-checkout.sh');
const GUARD = join(REPO, '.claude/hooks/guard-main-checkout.sh');

interface Res {
  code: number | null;
  out: string;
  err: string;
}

// Every inherited GIT_* has to be stripped: **this suite itself runs inside a git hook**
// (pre-commit -> npm run ci), and git injects GIT_DIR / GIT_INDEX_FILE into hooks, so every git
// command in a child process would be hijacked back to the forgeline repository instead of the
// temporary one the test just built. The symptom is thoroughly misleading: `node --test` alone is
// green, and the same commit goes red the moment it runs from pre-commit.
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  return env;
}

function sh(bin: string, args: string[], cwd: string, o: { input?: string; env?: Record<string, string> } = {}): Res {
  const r = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    input: o.input ?? '',
    // Also clear the escape hatch, or a session that exported it would silently wave the gate tests through.
    env: { ...scrubbedEnv(), WT_NO_INSTALL: '1', WT_OFFLINE: '1', FORGELINE_ALLOW_MAIN_CHECKOUT: '', ...(o.env ?? {}) },
  });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
}

const git = (cwd: string, args: string[]): Res => sh('git', args, cwd);
const wt = (cwd: string, args: string[], o?: { input?: string; env?: Record<string, string> }): Res =>
  sh('bash', [WT, ...args], cwd, o);

// Create a tree and assert it really appeared. **Never use wt(...).out as a path directly**: on
// failure stdout is the empty string and join('', 'wip.txt') degrades into a relative path, so the
// test writes its fixture into whichever repo is running the tests (which happened during this
// script's own development).
function mkTree(main: string, slug: string): string {
  const r = wt(main, ['new', slug]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith(`${main}/`), `new did not return an absolute path: ${r.out}`);
  return r.out;
}

// A bare origin plus a clone, close to the real thing: a .gitignore, an ignored secret, a
// .worktreeinclude. core.hooksPath is deliberately left unset so `check` has something to catch.
function mkRepo(opts: { ignoreForge?: boolean } = {}): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wt-test-')));
  const origin = join(tmp, 'origin.git');
  const main = join(tmp, 'main');
  git(tmp, ['init', '--quiet', '--bare', '-b', 'main', origin]);
  git(tmp, ['clone', '--quiet', origin, main]);
  git(main, ['config', 'user.email', 'test@example.com']);
  git(main, ['config', 'user.name', 'Test']);
  git(main, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(main, '.gitignore'), `${opts.ignoreForge === false ? '' : '.forge/\n'}config/secret.env\n`);
  mkdirSync(join(main, 'src'), { recursive: true });
  mkdirSync(join(main, 'config'), { recursive: true });
  writeFileSync(join(main, 'src/app.ts'), 'export const a = 1;\n');
  writeFileSync(join(main, 'config/secret.env'), 'TOKEN=xyz\n');
  writeFileSync(join(main, '.worktreeinclude'), '# a comment\nconfig/secret.env\nsrc/app.ts\nconfig/missing.yaml\n');
  git(main, ['add', '-A']);
  git(main, ['commit', '--quiet', '-m', 'init']);
  git(main, ['push', '--quiet', '-u', 'origin', 'main']);
  git(main, ['remote', 'set-head', 'origin', '-a']);
  return main;
}

test('new: lands in .forge/worktrees/<key>, branch verbatim (no worktree- prefix), stdout is the path alone', () => {
  const main = mkRepo();
  const r = wt(main, ['new', 'fix/mention-gate']);
  assert.equal(r.code, 0, r.err);
  const path = join(main, '.forge/worktrees/fix-mention-gate');
  assert.equal(r.out, path); // one line on stdout: Claude Code's WorktreeCreate hook reads exactly this
  assert.equal(r.out.split('\n').length, 1);
  assert.ok(existsSync(path));
  assert.equal(git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).out, 'fix/mention-gate');
});

test('new: the main checkout stays clean afterwards (the tree is ignored, not a pile of new files)', () => {
  const main = mkRepo();
  assert.equal(wt(main, ['new', 'feat/x']).code, 0);
  assert.equal(git(main, ['status', '--porcelain']).out, '');
});

test('new: with no .forge/ in .gitignore it writes .git/info/exclude first (never create under a non-ignored dir)', () => {
  const main = mkRepo({ ignoreForge: false });
  const r = wt(main, ['new', 'feat/x']);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(join(main, '.git/info/exclude'), 'utf8'), /^\/\.forge\/$/m);
  assert.equal(git(main, ['status', '--porcelain']).out, '');
});

test('new: the baseline is a pinned sha -- the tree starts at whatever origin/main was', () => {
  const main = mkRepo();
  const sha = git(main, ['rev-parse', 'origin/main']).out;
  const r = wt(main, ['new', 'feat/pin']);
  assert.equal(git(r.out, ['rev-parse', 'HEAD']).out, sha);
});

test('new: idempotent -- the same slug again reuses the tree instead of failing', () => {
  const main = mkRepo();
  const first = wt(main, ['new', 'feat/same']);
  const second = wt(main, ['new', 'feat/same']);
  assert.equal(second.code, 0, second.err);
  assert.equal(second.out, first.out);
  assert.match(second.err, /reusing/);
});

test('new: .worktreeinclude carries only files that are ignored and exist; tracked ones are skipped', () => {
  const main = mkRepo();
  const r = wt(main, ['new', 'feat/inc']);
  assert.equal(readFileSync(join(r.out, 'config/secret.env'), 'utf8'), 'TOKEN=xyz\n'); // ignored: carried
  assert.match(r.err, /skipping src\/app\.ts/); // tracked: not copied, a copy would be a fake diff
  assert.doesNotMatch(r.err, /carried config\/missing\.yaml/); // absent: skipped silently
});

test('new: an existing but unoccupied branch is attached, its history untouched', () => {
  const main = mkRepo();
  git(main, ['branch', 'feat/exists']);
  const tip = git(main, ['rev-parse', 'feat/exists']).out;
  const r = wt(main, ['new', 'feat/exists']);
  assert.equal(r.code, 0, r.err);
  assert.equal(git(r.out, ['rev-parse', 'HEAD']).out, tip);
});

test('new: a branch already checked out elsewhere is refused, and the message says where', () => {
  const main = mkRepo();
  const r = wt(main, ['new', 'main']); // main is held by the main checkout
  assert.equal(r.code, 1);
  assert.match(r.err, /already checked out at/);
});

test('new: invalid slugs are refused (path traversal / spaces / leading dash)', () => {
  const main = mkRepo();
  for (const bad of ['../evil', 'a b', '-x', 'feat/']) {
    const r = wt(main, ['new', bad]);
    assert.equal(r.code, 1, `should have been refused: ${bad}`);
    assert.ok(!existsSync(join(main, '.forge/worktrees', bad.replace(/\//g, '-'))));
  }
});

test('path: computes the path without creating anything', () => {
  const main = mkRepo();
  const r = wt(main, ['path', 'feat/calc']);
  assert.equal(r.out, join(main, '.forge/worktrees/feat-calc'));
  assert.ok(!existsSync(r.out));
});

test('list --json: reports the trees under this convention, dirty count included', () => {
  const main = mkRepo();
  const p = mkTree(main, 'feat/listed');
  writeFileSync(join(p, 'dirty.txt'), 'x');
  const r = wt(main, ['list', '--json']);
  const rows = JSON.parse(r.out) as { path: string; branch: string; dirty: number }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].branch, 'feat/listed');
  assert.equal(rows[0].dirty, 1);
});

test('check: a correctly laid out repo passes', () => {
  const main = mkRepo();
  mkTree(main, 'feat/ok'); // also sets core.hooksPath, one of the things check asserts
  const r = wt(main, ['check']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /every worktree is under/);
});

test('check: a worktree outside .forge/worktrees/ fails and is named -- the drift that started this', () => {
  const main = mkRepo();
  mkTree(main, 'feat/ok');
  // Exactly what Claude Code's built-in EnterWorktree produces.
  const stray = join(main, '.claude/worktrees/legacy');
  assert.equal(git(main, ['worktree', 'add', '--quiet', stray, '-b', 'worktree-legacy']).code, 0);
  const r = wt(main, ['check']);
  assert.equal(r.code, 1);
  assert.match(r.err, /stray worktree/);
  assert.ok(r.err.includes(stray));
  assert.ok(r.err.includes(join(main, '.forge/worktrees/legacy'))); // says where it belongs
  assert.match(r.err, /check --fix/); // a refusal has to give the next step
});

test('check --fix: relocates a stray tree with git worktree move, registration and branch intact', () => {
  const main = mkRepo();
  mkTree(main, 'feat/ok');
  const stray = join(main, '.claude/worktrees/legacy');
  git(main, ['worktree', 'add', '--quiet', stray, '-b', 'worktree-legacy']);
  writeFileSync(join(stray, 'wip.txt'), 'x'); // uncommitted work must survive the move

  const fixed = wt(main, ['check', '--fix']);
  assert.equal(fixed.code, 0, fixed.err);
  const moved = join(main, '.forge/worktrees/legacy');
  assert.ok(existsSync(join(moved, 'wip.txt')));
  assert.ok(!existsSync(stray));
  // Registered at the new path -- `mv` would have left this dangling and the branch would read as
  // "already checked out" from everywhere else.
  assert.ok(git(main, ['worktree', 'list', '--porcelain']).out.includes(`worktree ${moved}`));
  assert.equal(git(moved, ['rev-parse', '--abbrev-ref', 'HEAD']).out, 'worktree-legacy');
  assert.equal(wt(main, ['check']).code, 0);
});

test('check: fails when .forge/ is not ignored, and when core.hooksPath is unset', () => {
  const main = mkRepo({ ignoreForge: false });
  const r = wt(main, ['check']); // no tree created, so neither precondition has been fixed
  assert.equal(r.code, 1);
  assert.match(r.err, /\.forge\/ is not ignored/);
  assert.match(r.err, /core\.hooksPath is unset/);
});

test('rm: refuses while there are uncommitted changes; --force takes the tree and the branch', () => {
  const main = mkRepo();
  const p = mkTree(main, 'feat/rm');
  writeFileSync(join(p, 'wip.txt'), 'x');
  const refused = wt(main, ['rm', 'feat/rm']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /uncommitted changes/);
  assert.ok(existsSync(p));

  const forced = wt(main, ['rm', 'feat/rm', '--force']);
  assert.equal(forced.code, 0, forced.err);
  assert.ok(!existsSync(p));
  assert.equal(git(main, ['worktree', 'list', '--porcelain']).out.includes(p), false);
  assert.notEqual(git(main, ['rev-parse', '--verify', '--quiet', 'refs/heads/feat/rm']).code, 0);
});

test('rm: refuses while there are unpushed commits (push first, or say --force)', () => {
  const main = mkRepo();
  const p = mkTree(main, 'feat/unpushed');
  writeFileSync(join(p, 'a.txt'), 'x');
  git(p, ['add', '-A']);
  git(p, ['commit', '--quiet', '-m', 'wip']);
  const r = wt(main, ['rm', 'feat/unpushed']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unpushed commits/);
});

test('rm: refuses any path outside the worktree root -- one typo must not reach the main checkout', () => {
  const main = mkRepo();
  const r = wt(main, ['rm', main]);
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to remove/);
});

test('sweep: dry-run by default; a dirty tree is kept and the reason is given', () => {
  const main = mkRepo();
  const p = mkTree(main, 'feat/keep');
  writeFileSync(join(p, 'wip.txt'), 'x');
  const r = wt(main, ['sweep', '--days', '0']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /keeping feat-keep \(uncommitted changes\)/);
  assert.ok(existsSync(p));
});

test('hook-create / hook-remove: read Claude Code JSON, stdout carries only the path', () => {
  const main = mkRepo();
  const created = wt(main, ['hook-create'], {
    input: JSON.stringify({
      hook_event_name: 'WorktreeCreate',
      worktree_name: 'feat/hooked',
      worktree_path: `${main}/.claude/worktrees/feat-hooked`,
    }),
  });
  assert.equal(created.code, 0, created.err);
  assert.equal(created.out, join(main, '.forge/worktrees/feat-hooked')); // our convention, not .claude/worktrees
  assert.ok(existsSync(created.out));

  const removed = wt(main, ['hook-remove'], {
    input: JSON.stringify({ hook_event_name: 'WorktreeRemove', worktree_path: created.out }),
  });
  assert.equal(removed.code, 0, removed.err);
  assert.ok(!existsSync(created.out));
});

test('hook-remove: a path outside this convention is left alone (handed back to Claude Code)', () => {
  const main = mkRepo();
  const r = wt(main, ['hook-remove'], { input: JSON.stringify({ worktree_path: `${main}/.claude/worktrees/other` }) });
  assert.equal(r.code, 0);
});

test('doctor: reports the ignore rule, hooksPath and dependencies', () => {
  const main = mkRepo();
  wt(main, ['new', 'feat/doc']);
  const r = wt(main, ['doctor']);
  assert.match(r.err, /worktree root:/);
  assert.match(r.err, /has no node_modules/); // WT_NO_INSTALL=1 in tests, so this is the honest answer
});

test('gate 1 (pre-commit): refuses in the main checkout, allows in a worktree, escape hatch works', () => {
  const main = mkRepo();
  const p = mkTree(main, 'feat/gate');

  const inMain = sh('sh', [NO_MAIN], main);
  assert.equal(inMain.code, 1);
  assert.match(inMain.err, /Do not commit in the main checkout/);
  assert.match(inMain.err, /tools\/wt\.sh new/); // a refusal has to say what to do instead

  assert.equal(sh('sh', [NO_MAIN], p).code, 0); // inside a worktree: allowed
  assert.equal(sh('sh', [NO_MAIN], main, { env: { FORGELINE_ALLOW_MAIN_CHECKOUT: '1' } }).code, 0);
});

test('gate 2 (PreToolUse): denies source edits in the main checkout; worktree, runtime state and hatch allowed', () => {
  const main = mkRepo();
  const p = mkTree(main, 'feat/guard');
  const ask = (file: string, cwd = main, env?: Record<string, string>) =>
    sh('sh', [GUARD], cwd, {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd, tool_input: { file_path: file } }),
      env,
    });

  const denied = ask(join(main, 'src/app.ts'));
  assert.equal(denied.code, 0); // the gate itself always exits cleanly; the verdict is in the JSON
  assert.equal(JSON.parse(denied.out).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(denied.out).hookSpecificOutput.permissionDecisionReason, /tools\/wt\.sh new/);

  assert.equal(ask(join(p, 'src/app.ts'), p).out, ''); // already in a worktree: allowed
  assert.equal(ask(join(main, 'state/service.db')).out, ''); // untracked runtime artefact: allowed
  assert.equal(ask('src/app.ts').out !== '', true); // a relative path is resolved against cwd first
  assert.equal(ask(join(main, 'src/app.ts'), main, { FORGELINE_ALLOW_MAIN_CHECKOUT: '1' }).out, '');
});
