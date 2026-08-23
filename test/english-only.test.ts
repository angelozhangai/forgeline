// English-only fitness test: every tracked byte of this repository is English.
//
// This repo is an open core whose whole premise is that downstream integrators build against
// src/ext/port.ts and src/messaging/port.ts without ever patching a core file. A contract they
// cannot read is not a contract. The rule therefore covers source, comments, docs, config
// comments and every string the service emits — see the "English is the only language" top rule
// in AGENTS.md.
//
// Scope is **tracked files** (`git ls-files`), and that boundary is the point, not an accident:
//  · Requirement documents arriving from Feishu/Slack are *input*. Forge must keep handling
//    non-English PRDs perfectly well — logs/ and state/ are full of them and are untracked.
//  · What must be English is what a contributor reads and what the service says back.
// Scanning the working tree instead of the index would conflate the two and start failing on a
// developer's own runtime data.
//
// PENDING is a ratchet, exactly like ALLOW in arch-boundary.test.ts: it may only get shorter, its
// contents are asserted exactly, and the whole mechanism is deleted once empty. Putting a file
// back is a visible diff in this file, never a silent regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Non-Latin scripts that would defeat the rule. Deliberately *not* matched: emoji (U+1F300 and
// up) and symbols like the check mark, which the status labels in src/util/display.ts use on
// purpose.
const NON_ENGLISH = new RegExp(
  '[' +
    '\\u2e80-\\u2eff' + // CJK radicals supplement
    '\\u3000-\\u303f' + // CJK symbols and punctuation (fullwidth brackets, ideographic comma/stop)
    '\\u3040-\\u30ff' + // hiragana + katakana
    '\\u3400-\\u4dbf' + // CJK unified ideographs extension A
    '\\u4e00-\\u9fff' + // CJK unified ideographs
    '\\uac00-\\ud7af' + // hangul syllables
    '\\uf900-\\ufaff' + // CJK compatibility ideographs
    '\\uff00-\\uffef' + // halfwidth and fullwidth forms
    ']',
);

// Binary payloads have no language. Everything else is read as UTF-8 and scanned.
const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|zip|gz|db|sqlite)$/i;

// Files still carrying non-English text. RATCHET — this list may only get shorter.
const PENDING: string[] = [
  '.agents/skills/deploy-forge/SKILL.md',
  '.claude/skills/deploy-forge/SKILL.md',
  '.githooks/pre-commit',
  '.githooks/pre-push',
  '.github/workflows/ci.yml',
  '.gitignore',
  'README.md',
  'config/assignment.yaml',
  'config/forge.env.example',
  'config/permissions.yaml',
  'config/projects.yaml.example',
  'config/routing.yaml',
  'config/runtime.yaml',
  'deploy/README.md',
  'deploy/bootstrap.sh',
  'deploy/com.forge.daemon.plist',
  'deploy/com.forge.watchdog.plist',
  'deploy/forge-daemon',
  'deploy/forge-watchdog',
  'deploy/install.sh',
  'deploy/newsyslog/com.forge.conf',
  'deploy/uninstall.sh',
  'docs/pluggable-messaging-and-doc-sources.md',
  'forge',
  'package.json',
  'src/actions.ts',
  'src/config.ts',
  'src/control/server.ts',
  'src/cost.ts',
  'src/daemon/listen.ts',
  'src/docs/feishu.ts',
  'src/docs/plaintext.ts',
  'src/drift/reconcile.ts',
  'src/eval/aggregate.ts',
  'src/eval/expectations.ts',
  'src/eval/judge.ts',
  'src/eval/runEval.ts',
  'src/eval/store.ts',
  'src/feishu/dm.ts',
  'src/feishu/group.ts',
  'src/feishu/history.ts',
  'src/feishu/notify.ts',
  'src/feishu/petAssets.ts',
  'src/feishu/upload.ts',
  'src/gates/ci.ts',
  'src/gates/envelopes.ts',
  'src/gates/gateA.ts',
  'src/gates/gateALoop.ts',
  'src/gates/gateB.ts',
  'src/gates/gateBLoop.ts',
  'src/gates/gateC.ts',
  'src/gates/gateCLoop.ts',
  'src/gates/gateD.ts',
  'src/gates/gateDHarden.ts',
  'src/gates/gateDLoop.ts',
  'src/gates/legs.ts',
  'src/gates/prdTruth.ts',
  'src/gates/repoAnchor.ts',
  'src/gates/repoFreshness.ts',
  'src/gates/triage.ts',
  'src/health/action-gateway.ts',
  'src/health/alert.ts',
  'src/health/board.ts',
  'src/health/check.ts',
  'src/health/config.ts',
  'src/health/contract.ts',
  'src/health/heartbeat.ts',
  'src/health/history.ts',
  'src/health/page.html',
  'src/health/server.ts',
  'src/health/watchdog.ts',
  'src/index.ts',
  'src/intake.ts',
  'src/llm/contract.ts',
  'src/llm/probes.ts',
  'src/llm/runClaude.ts',
  'src/llm/runCodex.ts',
  'src/llm/structured.ts',
  'src/messaging/backfill.ts',
  'src/messaging/feishu.ts',
  'src/messaging/gate.ts',
  'src/messaging/index.ts',
  'src/messaging/model.ts',
  'src/messaging/operators.ts',
  'src/messaging/slack.ts',
  'src/notify.ts',
  'src/orchestrator/jobs/index.ts',
  'src/orchestrator/jobs/local.ts',
  'src/orchestrator/jobs/port.ts',
  'src/orchestrator/jobs/remote.ts',
  'src/orchestrator/jobs/runner.ts',
  'src/orchestrator/queue.ts',
  'src/orchestrator/retry.ts',
  'src/orchestrator/worker.ts',
  'src/project.ts',
  'src/project/actions.ts',
  'src/project/github.ts',
  'src/project/index.ts',
  'src/projects.ts',
  'src/review/drivers.ts',
  'src/review/reviewFixLoop.ts',
  'src/slack/blockkit.ts',
  'src/slack/modal.ts',
  'src/slack/socket.ts',
  'src/slack/text.ts',
  'src/slack/web.ts',
  'src/store/backup.ts',
  'src/store/contract.ts',
  'src/store/cursors.ts',
  'src/store/db.ts',
  'src/store/index.ts',
  'src/store/port.ts',
  'src/store/readModel.ts',
  'src/store/remote.ts',
  'src/store/schema.sql',
  'src/store/sessions.ts',
  'src/util/acceptance.ts',
  'src/util/assign.ts',
  'src/util/display.ts',
  'src/util/json.ts',
  'src/util/load.ts',
  'src/util/log.ts',
  'src/util/pet.ts',
  'src/util/proc.ts',
  'src/util/render.ts',
  'src/util/scoring.ts',
  'src/util/sizing.ts',
  'src/util/slug.ts',
  'src/util/targetRepos.ts',
  'src/util/time.ts',
  'src/util/worktree.ts',
  'src/workspace.ts',
  'src/writes.ts',
  'test/acceptance.test.ts',
  'test/actions.test.ts',
  'test/arch-boundary.test.ts',
  'test/assign.test.ts',
  'test/assignment-production-flow.test.ts',
  'test/autonomy-policy.test.ts',
  'test/autonomy-realaction.test.ts',
  'test/autonomy-worker.test.ts',
  'test/backup.test.ts',
  'test/card-operator-production-flow.test.ts',
  'test/ci.test.ts',
  'test/commit-delivery-docs.test.ts',
  'test/config-divergence-action.test.ts',
  'test/config.test.ts',
  'test/contract-alert.test.ts',
  'test/contract-assert.test.ts',
  'test/contract-flip.test.ts',
  'test/contract-startup-probe.test.ts',
  'test/contract.test.ts',
  'test/control-server.test.ts',
  'test/cost.test.ts',
  'test/cursors.test.ts',
  'test/daemon-message-production-flow.test.ts',
  'test/daemon.test.ts',
  'test/db-migrations.test.ts',
  'test/decision-card-production-flow.test.ts',
  'test/deploy-dirs.test.ts',
  'test/display.test.ts',
  'test/docs-feishu.test.ts',
  'test/docs-plaintext.test.ts',
  'test/docs-registry.test.ts',
  'test/downstream-production-flow.test.ts',
  'test/downstream-prompts.test.ts',
  'test/drift.test.ts',
  'test/engine.test.ts',
  'test/envelopes.test.ts',
  'test/eval-aggregate.test.ts',
  'test/eval-cli-production-flow.test.ts',
  'test/eval-judge.test.ts',
  'test/eval-production-flow.test.ts',
  'test/eval.test.ts',
  'test/ext-seam.test.ts',
  'test/feishu-chat-kind.test.ts',
  'test/feishu-probe-production-flow.test.ts',
  'test/gateA.test.ts',
  'test/gateALoop.test.ts',
  'test/gateB-prd-truth-production-flow.test.ts',
  'test/gateC-setup.test.ts',
  'test/gateC.test.ts',
  'test/gateCLoop.test.ts',
  'test/gateD-legs-flow.test.ts',
  'test/gateD-setup.test.ts',
  'test/gateD.test.ts',
  'test/gateDHarden.test.ts',
  'test/gateDLoop.test.ts',
  'test/go-production-flow.test.ts',
  'test/health-alert-production-flow.test.ts',
  'test/health-board.test.ts',
  'test/health-check.test.ts',
  'test/health-history.test.ts',
  'test/health-server.test.ts',
  'test/heartbeat.test.ts',
  'test/intake.test.ts',
  'test/json.test.ts',
  'test/lease.test.ts',
  'test/legs.test.ts',
  'test/load-probe.test.ts',
  'test/load.test.ts',
  'test/maybe-commit-delivery.test.ts',
  'test/mention-gate.test.ts',
  'test/messaging-backfill.test.ts',
  'test/messaging-feishu-history.test.ts',
  'test/messaging-feishu.test.ts',
  'test/messaging-select.test.ts',
  'test/messaging-slack.test.ts',
  'test/notify-failure-split.test.ts',
  'test/notify-group-card.test.ts',
  'test/notify.test.ts',
  'test/operators.test.ts',
  'test/panel-action-real.test.ts',
  'test/panel-action.test.ts',
  'test/panel-http-production-flow.test.ts',
  'test/pet.test.ts',
  'test/prdTruth.test.ts',
  'test/probe-im-kind.test.ts',
  'test/project-actions-native.test.ts',
  'test/project-actions.test.ts',
  'test/projects.test.ts',
  'test/readModel.test.ts',
  'test/remote-store.test.ts',
  'test/repo-anchor.test.ts',
  'test/repoFreshness.test.ts',
  'test/retry.test.ts',
  'test/reviewFixLoop.test.ts',
  'test/runClaude-guard.test.ts',
  'test/runCodex.test.ts',
  'test/runner-jobsource.test.ts',
  'test/runner-remote-jobs.test.ts',
  'test/scoring.test.ts',
  'test/show-production-flow.test.ts',
  'test/sizing.test.ts',
  'test/slack-blockkit.test.ts',
  'test/slack-live-loop.test.ts',
  'test/slack-modal.test.ts',
  'test/slack-socket.test.ts',
  'test/slack-web.test.ts',
  'test/slug.test.ts',
  'test/store-legacy-duplicates.test.ts',
  'test/store-port.test.ts',
  'test/store-seam-guard.test.ts',
  'test/store.test.ts',
  'test/structured.test.ts',
  'test/targetRepos.test.ts',
  'test/triage.test.ts',
  'test/watchdog-decide.test.ts',
  'test/worker.test.ts',
  'test/workspace.test.ts',
  'test/worktree.test.ts',
  'test/writes-native-chain.test.ts',
  'test/writes-native-epic.test.ts',
  'test/writes-project-dri.test.ts',
  'test/writes.test.ts',
  'tools/gen-pet-sprites.ts',
  'tools/test-with-floor.sh',
  'tools/upload-pet-assets.ts',
  'tools/weekly-load.sh',
];

function trackedFiles(): string[] {
  // A check that cannot check is not a check (see the --test-force-exit episode): if git is
  // unavailable this must fail loudly rather than quietly scanning nothing.
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const files = out.split('\0').filter(Boolean);
  assert.ok(files.length > 100, `git ls-files returned ${files.length} files — the scan cannot be trusted`);
  return files.filter((f) => !BINARY.test(f));
}

/** Tracked files containing non-English text, each with its first offending line. */
export function offenders(files: string[]): { file: string; line: number; text: string }[] {
  const found: { file: string; line: number; text: string }[] = [];
  for (const rel of files) {
    let content: string;
    try {
      content = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      continue; // deleted-but-still-indexed; nothing to scan
    }
    if (!NON_ENGLISH.test(content)) continue;
    const lines = content.split('\n');
    const i = lines.findIndex((l) => NON_ENGLISH.test(l));
    found.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 80) });
  }
  return found;
}

test('English-only: no tracked file carries non-English text', () => {
  const pending = new Set(PENDING);
  const bad = offenders(trackedFiles()).filter((o) => !pending.has(o.file));
  assert.deepEqual(
    bad.map((o) => `${o.file}:${o.line}`),
    [],
    `These tracked files contain non-English text and are not in PENDING:\n  ${bad
      .map((o) => `${o.file}:${o.line}  ${o.text}`)
      .join('\n  ')}`,
  );
});

// The ratchet only ratchets if a stale entry is a failure rather than dead weight: a file that was
// converted but left in PENDING would silently re-open the hole it was covering.
test('English-only: PENDING holds no file that is already clean', () => {
  const dirty = new Set(offenders(trackedFiles()).map((o) => o.file));
  const stale = PENDING.filter((f) => !dirty.has(f));
  assert.deepEqual(stale, [], `Already English — delete these from PENDING:\n  ${stale.join('\n  ')}`);
});

// Detection itself has to be pinned, or the ratchet could be emptied by a regex that matches
// nothing. Each case is a script the rule bans; the last two are what must NOT trip it.
//
// The fixtures are built from code points rather than written as literal characters on purpose:
// this file is itself a tracked file, and a guard that has to exempt itself from its own rule is
// not a guard.
test('English-only: the detector matches every banned script and no emoji', () => {
  const matched = (...cps: number[]) => NON_ENGLISH.test(String.fromCodePoint(...cps));
  assert.equal(matched(0x67, 0x61, 0x74, 0x65), false, 'plain ASCII');
  assert.equal(matched(0x95f8), true, 'CJK unified');
  assert.equal(matched(0x3400), true, 'CJK extension A');
  assert.equal(matched(0xff08), true, 'fullwidth punctuation');
  assert.equal(matched(0x300c), true, 'CJK punctuation');
  assert.equal(matched(0x3072), true, 'hiragana');
  assert.equal(matched(0x30ab), true, 'katakana');
  assert.equal(matched(0xd55c), true, 'hangul');
  assert.equal(matched(0xf900), true, 'CJK compatibility ideographs');
  assert.equal(matched(0x2e80), true, 'CJK radicals');
  assert.equal(matched(0x1f4e5), false, 'emoji are deliberately allowed');
  assert.equal(matched(0x2713), false, 'check mark is allowed');
  assert.equal(matched(0x2014), false, 'em dash is allowed');
});
