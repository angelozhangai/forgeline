import type { Acceptance, GateBEnvelope } from '../gates/envelopes.ts';

// Repo letter -> display name (the same terms as REPO_NAME in writes.ts; the util layer must not depend
// backwards on it, so it keeps its own copy).
const REPO_LABEL: Record<string, string> = {
  C: 'demo',
  U: 'example-web',
  A: 'example-admin',
};

// Render the "Acceptance (definition of done · outer ring)" markdown, the engineer-facing block of an issue
// body or a technical-design document.
// Given a repo, take only that repo's items plus the ones with no repo set; given none, take everything (for
// the Epic and the technical-design document).
// The outer ring binds contracts and boundaries and is executable and entirely red today; the inner ring
// (unit + integration) is what the engineer adds TDD-style during development, gated by the diff-coverage
// floor on the new lines.
export function acceptanceMarkdown(acc: Acceptance | undefined, repo?: string): string {
  if (!acc) return '';
  const pick = <T extends { repo?: string }>(xs: T[]): T[] =>
    repo ? xs.filter((x) => !x.repo || x.repo === repo) : xs;
  const contracts = pick(acc.contracts ?? []).filter((c) => c.surface.trim());
  const scenarios = pick(acc.scenarios ?? []).filter((s) => s.gherkin.trim());
  if (contracts.length === 0 && scenarios.length === 0) return '';

  const tag = (r: string): string => (r ? `[${REPO_LABEL[r] ?? r}] ` : '');
  const lines: string[] = ['## Acceptance (definition of done · outer ring, all red before development starts)'];
  if (contracts.length) {
    lines.push('', '**Contracts (the fixed boundary — tests bind here, never to an internal method)**');
    for (const c of contracts) lines.push(`- ${tag(c.repo)}${c.surface.trim()}`);
  }
  if (scenarios.length) {
    lines.push('', '**Acceptance scenarios (declarative BDD; written first and red today — the engineer adds the inner-ring unit and integration tests TDD-style to turn them green)**');
    for (const s of scenarios) {
      lines.push('', `*${s.id || 'AC'}*`, '```gherkin', s.gherkin.trim(), '```');
    }
  }
  return lines.join('\n');
}

// Imperative UI actions (acceptance should state a business outcome, not a click path). A match means it is
// not declarative.
// The scenarios being linted are generated from the requirement document, and a requirement document may
// arrive in any language — source is English, input is not. So the non-English alternatives have to stay, or
// the lint would quietly stop catching click paths for every non-English PRD. They are written as escapes
// rather than as literal characters, which is how this repo keeps non-English *data* out of its source text
// (see test/english-only.test.ts).
const IMPERATIVE_INTL = [
  '\u70b9\u51fb', // click
  '\u70b9\u6309\u94ae', // click the button
  '\u5355\u51fb', // single-click
  '\u586b\u5199', // fill in
  '\u586b\u5165', // enter into
  '\u8f93\u5165\u6846', // input field
  '\u52fe\u9009', // tick / check
  '\u4e0b\u62c9\u6846', // dropdown
].join('|');
const IMPERATIVE = new RegExp(`${IMPERATIVE_INTL}|\\bclick\\b|\\bfill in\\b|\\btype into\\b`, 'i');

export interface AcceptanceLint {
  ok: boolean;
  problems: string[];
}

// The deterministic lint on the outer-ring acceptance (the gate before GO): empty, structurally incomplete,
// imperative, or missing a repo -> blocked.
// It only covers the high-signal cases; a judgement like "this binds an internal method name", which is easy
// to get wrong, is left to the adversarial review.
export function lintAcceptance(env: GateBEnvelope): AcceptanceLint {
  const problems: string[] = [];
  const acc = env.acceptance ?? { contracts: [], scenarios: [] };
  const contracts = (acc.contracts ?? []).filter((c) => c.surface.trim());
  const scenarios = (acc.scenarios ?? []).filter((s) => s.gherkin.trim());

  if (scenarios.length === 0)
    problems.push('the outer-ring acceptance has no scenario: acceptance.scenarios needs at least one declarative Given/When/Then');
  if (contracts.length === 0)
    problems.push('the outer-ring acceptance has no contract: acceptance.contracts needs at least one fixed boundary (an endpoint/schema, or an exported signature)');

  for (const s of scenarios) {
    const id = s.id || '(scenario with no id)';
    const g = s.gherkin;
    if (!(/given/i.test(g) && /when/i.test(g) && /then/i.test(g)))
      problems.push(`scenario ${id} is structurally incomplete: it must contain Given, When and Then`);
    if (IMPERATIVE.test(g))
      problems.push(`scenario ${id} uses an imperative action (click a button, fill in a field, ...): acceptance must state the business outcome declaratively`);
  }

  // Every repo that has an issue must be covered by the outer ring (either by a contract/scenario of its own,
  // or by an item with no repo set, which covers all of them).
  const hasGeneral = contracts.some((c) => !c.repo) || scenarios.some((s) => !s.repo);
  if (!hasGeneral) {
    const covered = new Set(
      [...contracts, ...scenarios].map((x) => x.repo).filter(Boolean),
    );
    for (const r of new Set(env.issue_specs.map((i) => i.repo).filter(Boolean))) {
      if (!covered.has(r))
        problems.push(`repo ${r} has an issue but no outer-ring acceptance covering it (give it a contract/scenario, or use an unscoped one)`);
    }
  }

  return { ok: problems.length === 0, problems };
}
