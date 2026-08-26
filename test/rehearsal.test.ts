// The rehearsal mode: the canned model replies, the no-write project adapter, both selection points, and the
// driver's decision table.
//
// The load-bearing test here is the last one. Everything else checks that the pieces behave; that one checks
// that the *set* of pieces is complete — it reads every model call the pipeline can make out of the gate
// sources and fails when one is neither answered nor deliberately out of scope. Without it the failure mode
// is silent and expensive in the worst way: a new gate call falls through, and the operator who was told
// "this rehearsal is free" pays for a real CLI run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REHEARSAL_ENV,
  REHEARSAL_SLUG_PREFIX,
  BY_LABEL,
  BY_PREFIX,
  OUT_OF_SCOPE,
  cannedText,
  rehearsalOn,
  stageForLabel,
  resetRehearsalTally,
} from '../src/rehearsal.ts';
import { makeRehearsalActions } from '../src/project/rehearsal.ts';
import { nextStep, rehearsalDocRef } from '../src/rehearsePipeline.ts';
import { extractJsonBlock } from '../src/util/json.ts';
import type { ProjectFull } from '../src/projects.ts';
import type { State } from '../src/statemachine/states.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The env var is process-wide, so every test that turns it on puts it back. Left on, it would make the rest
// of the suite run against canned model replies without saying so.
function withRehearsal<T>(fn: () => T): T {
  const before = process.env[REHEARSAL_ENV];
  process.env[REHEARSAL_ENV] = '1';
  resetRehearsalTally();
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[REHEARSAL_ENV];
    else process.env[REHEARSAL_ENV] = before;
    resetRehearsalTally();
  }
}

const parse = (text: string): Record<string, unknown> => extractJsonBlock(text) as Record<string, unknown>;

test('rehearsalOn: only the exact value 1 turns it on -- never a truthy string', () => {
  const before = process.env[REHEARSAL_ENV];
  try {
    delete process.env[REHEARSAL_ENV];
    assert.equal(rehearsalOn(), false);
    process.env[REHEARSAL_ENV] = '1';
    assert.equal(rehearsalOn(), true);
    // "0" and "false" read as off. Anything looser and `FORGE_REHEARSAL=false` would silently fake a run.
    for (const v of ['0', 'false', 'yes', '']) {
      process.env[REHEARSAL_ENV] = v;
      assert.equal(rehearsalOn(), false, `${JSON.stringify(v)} must not enable the rehearsal`);
    }
  } finally {
    if (before === undefined) delete process.env[REHEARSAL_ENV];
    else process.env[REHEARSAL_ENV] = before;
  }
});

test('cannedText: Gate A opens questions first, and the re-review closes them', () => {
  resetRehearsalTally();
  const first = parse(cannedText('Gate A'));
  assert.ok(Array.isArray(first.open_questions) && (first.open_questions as unknown[]).length > 0);
  const again = parse(cannedText('Gate A · re-review #1'));
  assert.deepEqual(again.open_questions, []);
  resetRehearsalTally();
});

test('cannedText: the adversarial verdict asks for a change once, then approves -- one real revision round', () => {
  resetRehearsalTally();
  assert.equal(parse(cannedText('Gate A · adversarial')).verdict, 'CHANGES_REQUESTED');
  assert.equal(parse(cannedText('Gate A · adversarial')).verdict, 'LGTM');
  // Gate B keeps its own tally, so its first round still asks for a change.
  assert.equal(parse(cannedText('Gate B · adversarial')).verdict, 'CHANGES_REQUESTED');
  resetRehearsalTally();
});

test("cannedText: Gate B's first revision escalates to the maintainer, the second does not", () => {
  resetRehearsalTally();
  const round1 = parse(cannedText('Gate B · revise the design'));
  assert.equal((round1.needs_human as unknown[]).length, 1, 'round 1 must escalate so the decision card renders');
  const round2 = parse(cannedText('Gate B · revise the design'));
  assert.deepEqual(round2.needs_human, [], 'round 2 must not escalate, or the loop never ends');
  resetRehearsalTally();
});

test('cannedText: the output is a fenced block, so the real extraction path is exercised rather than bypassed', () => {
  resetRehearsalTally();
  const text = cannedText('Gate B');
  assert.match(text, /```json/);
  assert.ok(parse(text).tech_design_markdown, 'the envelope has to survive extractJsonBlock');
  resetRehearsalTally();
});

test('cannedText: runClaudeBare (no label) returns the slug, not an envelope', () => {
  resetRehearsalTally();
  assert.equal(cannedText(undefined), REHEARSAL_SLUG_PREFIX);
  resetRehearsalTally();
});

test('cannedText: an unknown label throws and names it -- never a silent fallthrough to the paid CLI', () => {
  resetRehearsalTally();
  assert.throws(
    () => cannedText('Gate E · something new'),
    (e: Error) => e.message.includes('Gate E · something new') && e.message.includes('src/rehearsal.ts'),
  );
  resetRehearsalTally();
});

test('cannedText: an out-of-scope label throws with the reason, not "unknown"', () => {
  resetRehearsalTally();
  assert.throws(
    () => cannedText('Gate C · implement'),
    (e: Error) => e.message.includes('out of the rehearsal') && e.message.includes('stops at DONE'),
  );
  resetRehearsalTally();
});

test('the no-write adapter: every action reports success, creates nothing, and never claims to have published', async () => {
  const proj = { root: '/tmp/nowhere', scriptsDir: '/tmp/nowhere/scripts', owner: 'nobody' } as unknown as ProjectFull;
  const a = makeRehearsalActions(proj);
  const scaffold = await a.scaffoldReview({ slug: 'x' } as never);
  assert.equal(scaffold.ok, true);
  assert.match(scaffold.stdout, /REHEARSAL/);

  // The created issues are the one thing the adapter has to invent, because doWrites throws on an empty
  // set. They are built to be unmistakable: number 0 is not a valid issue number and .invalid never
  // resolves, so a placeholder that ever leaked into a card or the database is obvious rather than plausible.
  const single = (await a.createSingle('repo', 'title', {} as never)).issues;
  assert.equal(single.length, 1);
  assert.equal(single[0].number, 0);
  assert.match(single[0].url, /^https:\/\/rehearsal\.invalid\//);

  // One row per thing doWrites asked for -- the Epic plus each child -- or a short set reads as a partial
  // failure and the requirement is parked instead of reaching DONE.
  const epic = await a.createEpic('slug', 'title', [{ repo: 'C', title: 'a' }, { repo: 'U', title: 'b' }] as never, {} as never);
  assert.equal(epic.issues.length, 3);
  assert.deepEqual(epic.issues.slice(1).map((i) => i.repo), ['C', 'U']);

  const pub = await a.publishTechDesign('slug', { base: 'main' });
  assert.equal(pub.ok, true);
  assert.equal(pub.published, false, 'published:true would make DONE claim a PR that does not exist');

  assert.deepEqual((await a.listEpicChildren('repo', 'slug')).issues, []);
  assert.equal((await a.addLabel('repo', 1, 'size/M')).ok, true);
});

test('the selection point returns the no-write adapter only while the rehearsal is on', async () => {
  const { projectActions } = await import('../src/project/index.ts');
  const proj = { root: '/tmp/nowhere', scriptsDir: '/tmp/nowhere/scripts', owner: 'nobody', actions: 'native' } as unknown as ProjectFull;
  const real = await projectActions(proj).publishTechDesign('slug', { base: 'main' });
  const rehearsed = await withRehearsal(() => projectActions(proj).publishTechDesign('slug', { base: 'main' }));
  assert.match(rehearsed.stdout, /REHEARSAL/);
  assert.doesNotMatch(real.stdout ?? '', /REHEARSAL/);
});

test('runClaude / runCodex short-circuit while the rehearsal is on, at zero cost and with codex still available', async () => {
  const { runClaude } = await import('../src/llm/runClaude.ts');
  const { runCodex } = await import('../src/llm/runCodex.ts');
  const before = process.env[REHEARSAL_ENV];
  process.env[REHEARSAL_ENV] = '1';
  resetRehearsalTally();
  try {
    const c = await runClaude('ignored', { label: 'Gate A' });
    assert.equal(c.ok, true);
    assert.equal(c.costUsd, 0, 'a rehearsal must never report a cost');
    assert.ok(parse(c.result).open_questions);

    const x = await runCodex('ignored', { label: 'Gate A · adversarial' });
    assert.equal(x.ok, true);
    // available:false would send the gate down the degraded claude self-review instead of the real path.
    assert.equal(x.available, true);

    // An unanswered label becomes an ordinary failed result, so the gate parks in *_FAILED with the reason
    // rather than the exception taking down the whole tick.
    const bad = await runClaude('ignored', { label: 'Gate Z' });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? '', /Gate Z/);
  } finally {
    if (before === undefined) delete process.env[REHEARSAL_ENV];
    else process.env[REHEARSAL_ENV] = before;
    resetRehearsalTally();
  }
});

test('rehearsalDocRef: the registry fallback builds the ref, addressed by content, carrying the body', () => {
  const a = rehearsalDocRef('  we should   let people export their data ');
  const b = rehearsalDocRef('we should let people export their data');
  assert.ok(a && b);
  assert.equal(a.raw, 'we should let people export their data');
  assert.equal(a.token, b.token, 'whitespace must not make the same sentence two requirements');
  // Deliberately not asserting the source id: the core asks the registry which source is the fallback, and
  // pinning "plaintext" here would re-import the very knowledge the boundary keeps out of the core.
  assert.equal(rehearsalDocRef('   '), null, 'an empty body is refused rather than turned into a ref');
});

test('refFromText is not gated the way claim is -- an explicit body is not the question claim answers', async () => {
  const { plaintextDocs } = await import('../src/docs/plaintext.ts');
  // claim() stays shut while the source is off (the default), which is what stops "@bot + a paragraph" from
  // costing a gate run...
  assert.deepEqual(plaintextDocs.claim({ text: 'we should let people export all of their data', searchTexts: [] } as never), []);
  // ...while refFromText answers, because the caller already decided this text is the requirement.
  assert.ok(plaintextDocs.refFromText?.('we should let people export all of their data'));
  // The substance floor belongs to claim as well: a caller passing a body explicitly has made that call.
  assert.ok(plaintextDocs.refFromText?.('ok thanks'));
});

test('nextStep: the driver ticks the polled states, answers the human ones, and stops at DONE or a park', () => {
  for (const s of ['INTAKE', 'GATE_A_RUNNING', 'ADVERSARIAL_LOOP', 'WRITING'] as State[]) {
    assert.deepEqual(nextStep(s, false), { kind: 'tick' }, s);
  }
  assert.deepEqual(nextStep('AWAITING_PM_CONFIRM', false), { kind: 'action', action: 'answer-pm' });
  // The second visit closes it: answering again would bounce between the PM card and the re-review forever.
  assert.deepEqual(nextStep('AWAITING_PM_CONFIRM', true), { kind: 'action', action: 'confirm' });
  assert.deepEqual(nextStep('CONFIRMED', true), { kind: 'action', action: 'request-gate-b' });
  assert.deepEqual(nextStep('AWAITING_GATE_B_INPUT', true), { kind: 'action', action: 'answer-gate-b' });
  assert.deepEqual(nextStep('AWAITING_GO', true), { kind: 'action', action: 'go' });
  assert.deepEqual(nextStep('DONE', true), { kind: 'stop', ok: true });
  for (const s of ['GATE_A_FAILED', 'GATE_B_STALLED', 'GO_DENIED', 'WRITE_FAILED'] as State[]) {
    assert.deepEqual(nextStep(s, true), { kind: 'stop', ok: false }, s);
  }
  // A downstream state is a stop, not a guess: the rehearsal's scope ends at DONE.
  assert.deepEqual(nextStep('GATE_C_RUNNING', true), { kind: 'stop', ok: false });
});

// -- the completeness guard ---------------------------------------------------------------------
// Read the labels out of the sources rather than listing them here: a list maintained by hand is exactly
// what drifts, and the whole point is to catch the label somebody adds without telling the rehearsal.
function labelsInSource(): { label: string; where: string }[] {
  const files: string[] = [];
  for (const dir of ['src/gates', 'src/review']) {
    for (const f of readdirSync(join(ROOT, dir))) if (f.endsWith('.ts')) files.push(join(dir, f));
  }
  files.push('src/intake.ts');

  // A template literal's placeholder stands in as a sample, so `Gate A · re-review #${round}` is checked as
  // a label the prefix table has to cover.
  const sample = (raw: string): string => raw.replace(/\$\{[^}]*\}/g, '1');
  const found: { label: string; where: string }[] = [];

  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8');

    // Shape 1: the option on the model call itself. The window is bounded by the next model call so a
    // `label:` belonging to some later object cannot be mistaken for this call's -- these gate files also
    // carry a loop `label:` ('Gate A adversarial'), which is a progress string and never reaches a model.
    const calls = [...src.matchAll(/run(?:Claude|Codex)\(/g)].map((m) => m.index ?? 0);
    for (let i = 0; i < calls.length; i++) {
      const window = src.slice(calls[i], calls[i + 1] ?? Math.min(src.length, calls[i] + 400));
      const m = /label:\s*(['`])([^'`]*)\1/.exec(window);
      if (m) found.push({ label: sample(m[2]), where: rel });
    }

    // Shape 2: the three labels gateALoop/gateBLoop hand to makeReviewFixDrivers, which passes them
    // straight through to runCodex/runClaude. The field names are unambiguous, so the whole file is fair game.
    for (const m of src.matchAll(/(?:reviewLabel|reviewClaudeLabel|fixLabel):\s*(['`])([^'`]*)\1/g)) {
      found.push({ label: sample(m[2]), where: rel });
    }
  }
  return found;
}

test('every model call the pipeline can make is either answered by the rehearsal or named out of scope', () => {
  const found = labelsInSource();
  assert.ok(found.length >= 10, `only ${found.length} labels found -- the scan cannot be trusted`);
  const unanswered = found.filter(({ label }) => stageForLabel(label) === null && OUT_OF_SCOPE[label] === undefined);
  assert.deepEqual(
    unanswered,
    [],
    'these model calls would fall through to the real CLI during a rehearsal the operator was told is free. ' +
      'Answer them in src/rehearsal.ts (BY_LABEL / BY_PREFIX) or name them in OUT_OF_SCOPE with the reason.',
  );
});

test('the canned table carries no label the sources no longer use -- the guard holds in both directions', () => {
  const used = new Set(labelsInSource().map((f) => f.label));
  const stale = Object.keys(BY_LABEL).filter((l) => !used.has(l));
  assert.deepEqual(stale, [], 'these labels are answered by the rehearsal but no longer appear in any gate');
  for (const [prefix] of BY_PREFIX) {
    assert.ok([...used].some((l) => l.startsWith(prefix)), `no gate emits a label starting "${prefix}" any more`);
  }
});
