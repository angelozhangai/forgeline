// A golden test (free, and part of npm run ci): the regression net over the **template side** of the
// downstream prompt assets. It pins two things that are deterministic:
//  1. **The template's variable contract, in both directions**: rendering with the documented variable set
//     leaves no {{X}} behind (the template introduces no variable outside the contract), and every declared
//     variable really is used (the contract table lists nothing redundant). Note that this only pins template
//     against contract table; it does **not** prove the code actually supplies those variables. That case --
//     the code forgetting one, leaving a {{X}} at runtime -- is covered by each driver's integration test
//     asserting on the **real rendered output** (running render for real, capturing the prompt from a mocked
//     LLM, and asserting there is no {{X}}): gate-c-implement and -fix-resume in gateCLoop.test;
//     gate-d-pr-review (+resume) and gate-d-fix (+resume) in gateDLoop.test; gate-d-ci-fix in gateDLoop.test
//     (the loop's self-repair call site) and gateDHarden.test (hardening's own), so both call sites are
//     covered; and gate-d-harden-tests in gateDHarden.test. In other words every downstream gate-c/gate-d
//     prompt asset has at least one driver rendering it for real, and this file adds only the
//     template-against-contract layer, including the pure template consistency nothing above runs separately.
//  2. **The red lines are not deleted by accident**: the revise prompts' trio of never open a PR, never push,
//     never touch git, plus the needs_human escalation and JSON-only output; the codex review prompt's
//     contract that LGTM means no findings and CHANGES_REQUESTED means some, plus its mirror-test check; and
//     the hardening prompt's worked example of what a mirror test looks like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt, render } from '../src/util/render.ts';

// The red lines shared by revise, implement and harden -- everything where claude edits the worktree: no
// outward writes, an escalation route, and JSON-only output.
// The patterns are deliberately tolerant, so a change of case or slight rewording does not turn CI red, while
// the intent they protect stays exactly the same.
const FIXER = [/do not open a PR/i, /do not push/i, /do not touch git/i, /needs_human/, /output ONLY this JSON/i];
// The verdict contract for codex reviewing the diff, plus its test-quality check.
const REVIEWER = [/LGTM ⇔ findings must be empty/i, /CHANGES_REQUESTED ⇔ findings/, /mirror test/i];

const PROMPTS: { f: string; vars: string[]; must: RegExp[] }[] = [
  // Gate C: implement, and resume
  { f: 'gate-c-implement.md', vars: ['CONTEXT', 'FINDINGS', 'WORKTREE'], must: FIXER },
  { f: 'gate-c-fix-resume.md', vars: ['FINDINGS', 'HUMAN_ANSWER', 'WORKTREE'], must: FIXER },
  // Gate D: codex reviewing the diff
  { f: 'gate-d-pr-review.md', vars: ['CONTEXT', 'BASE', 'WORKTREE'], must: REVIEWER },
  { f: 'gate-d-pr-review-resume.md', vars: ['BASE', 'WORKTREE'], must: REVIEWER },
  // Gate D: claude revising, resuming, and repairing CI itself
  { f: 'gate-d-fix.md', vars: ['FINDINGS', 'WORKTREE'], must: FIXER },
  { f: 'gate-d-fix-resume.md', vars: ['FINDINGS', 'HUMAN_ANSWER', 'WORKTREE'], must: FIXER },
  { f: 'gate-d-ci-fix.md', vars: ['CI', 'WORKTREE'], must: FIXER },
  // Gate D, test hardening: the fixer red lines plus the worked example of a mirror test (the hard rule
  // against mirror tests is injected by the code's hardenRules() into {{HARDEN_RULES}}).
  { f: 'gate-d-harden-tests.md', vars: ['WORKTREE', 'DIFF_STAT', 'CONTEXT', 'HARDEN_RULES'], must: [...FIXER, /mirror test/i, /anti-pattern/i] },
];

for (const p of PROMPTS) {
  test(`prompt asset (template side): ${p.f} exists, its variable contract agrees in both directions, and the red lines are still there`, () => {
    const tmpl = loadPrompt(p.f); // a missing file throws, which is what guards against deleting one
    assert.ok(tmpl.trim().length > 0, `${p.f} is empty`);
    const vars = Object.fromEntries(p.vars.map((v) => [v, `‹${v}›`]));
    const out = render(tmpl, vars);
    // The contract in both directions: nothing renders to a leftover {{X}} (the template introduces no
    // variable outside the contract), and every declared variable is used (the table lists nothing redundant).
    assert.doesNotMatch(out, /\{\{\w+\}\}/, `${p.f} introduces a variable the contract table does not list (a leftover placeholder)`);
    for (const v of p.vars) assert.match(out, new RegExp(`‹${v}›`), `${p.f} declares ${v} in the contract table, but the template never uses it`);
    // The red lines have not been deleted by accident.
    for (const re of p.must) assert.match(out, re, `${p.f} is missing the red line ${re}`);
  });
}
