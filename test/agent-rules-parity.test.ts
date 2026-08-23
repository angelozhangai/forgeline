// Agent-instruction parity: Claude Code and Codex are held to one set of rules, not two.
//
// AGENTS.md already states the intent in its opening line -- "Claude Code / Codex and humans all read it;
// CLAUDE.md points here -- never fork a second copy that can drift". Until now that was the only red line in
// this repo asserted by prose alone, and prose is exactly what drift walks past. This is its machine guard.
//
// The failure it exists to catch is not hypothetical. The two copies of the deploy-forge skill shipped in the
// initial public release already disagreed on 13 lines, and nothing noticed for the repo's whole lifetime:
// the Codex-side copy carried a whole safety section on migrating a live host that the Claude-side copy did
// not, the two gave *contradictory* push rules ("never git push" vs "push only when explicitly requested"),
// and a find-and-replace had rewritten `claude -p` to `Codex -p` -- an invocation that does not exist, in the
// one gate an operator follows while standing up a production daemon.
//
// Two invariants, matching how the instructions are actually loaded: Claude Code reads CLAUDE.md, Codex reads
// AGENTS.md, and both read the skills directory named for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The two skill trees, one per agent platform. Same content, different directory name -- that is the only
// difference either side is allowed to have.
const TREES = ['.claude/skills', '.agents/skills'] as const;

function walk(dir: string, rel = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), r));
    else out.push(r);
  }
  return out.sort();
}

test('CLAUDE.md is only a pointer at AGENTS.md, never a second copy of the rules', () => {
  const body = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').trim();
  // A pointer is one line. Anything longer means someone started answering the question here instead of in
  // AGENTS.md, and the two files begin to diverge the moment one of them is edited alone.
  assert.equal(
    body,
    '@AGENTS.md',
    'CLAUDE.md must contain the @AGENTS.md pointer and nothing else -- put the rule in AGENTS.md, which ' +
      'Codex reads too. A rule written here is invisible to Codex, and a rule written in both drifts.',
  );
});

test('the Claude and Codex skill trees hold byte-identical files', () => {
  const [a, b] = TREES.map((t) => walk(join(ROOT, t)));

  // A file present on one side only is the same defect as a file that differs: one platform is being given
  // guidance the other is not.
  assert.deepEqual(
    a,
    b,
    `${TREES[0]} and ${TREES[1]} must hold the same files.\n` +
      `  only in ${TREES[0]}: ${a.filter((f) => !b.includes(f)).join(', ') || '(none)'}\n` +
      `  only in ${TREES[1]}: ${b.filter((f) => !a.includes(f)).join(', ') || '(none)'}`,
  );

  const differing = a.filter(
    (f) =>
      readFileSync(join(ROOT, TREES[0], f), 'utf8') !== readFileSync(join(ROOT, TREES[1], f), 'utf8'),
  );
  assert.deepEqual(
    differing,
    [],
    `These skills differ between the two trees, so Claude Code and Codex are following different ` +
      `instructions: ${differing.join(', ')}. Edit one and copy it to the other in the same commit.`,
  );
});

test('neither skill tree is empty, so the parity check cannot pass vacuously', () => {
  // Both assertions above hold trivially over two empty directories. If the skills ever move elsewhere this
  // test should fail and be rewritten -- not quietly keep reporting green while guarding nothing.
  for (const t of TREES) {
    assert.ok(walk(join(ROOT, t)).length > 0, `${t} is empty -- the parity check above guards nothing`);
  }
});
