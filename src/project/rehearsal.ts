// The no-write ProjectActions adapter — the second of the two boundaries the rehearsal replaces (the first
// is the model call; see src/rehearsal.ts).
//
// Every mechanical action a gate performs on the target project goes through the ProjectActions port, so
// swapping the adapter is enough to make a full pipeline walk touch nothing: no issue is created, no
// document is scaffolded or published, no label is applied. The gates are not aware of any of this — there
// is no `if (rehearsal)` in gate code, which is the whole point: the path exercised is the production path.
//
// **Why it reports success rather than failure.** A rehearsal is meant to reach DONE. An adapter that
// returned ok:false would park the session in WRITE_FAILED and the walk would stop two states short of the
// thing worth proving. So each method returns the shape its caller expects on success, with stdout saying
// plainly what did not happen — and `publishTechDesign` returns `published: false`, which is the honest
// answer and is what makes the DONE wording say the design was not published rather than claiming a merged
// PR.
//
// **The one place it has to invent something: the created issues.** doWrites' contract is that
// createSingle/createEpic return everything that was created, and it *rightly* refuses to call an empty set
// a success (`r.issues.length === 0` throws) — so returning nothing would park the walk in WRITE_FAILED on
// the last step of all. The placeholders it returns instead are built so that nothing can mistake them for
// real work: `number: 0` is not a valid issue number on any forge, and the URL is under the reserved
// `.invalid` TLD (RFC 2606), which can never resolve. They exist to carry the shape through labelling,
// approval and the DONE card, and nowhere else.
//
// **What it deliberately still lets through.** Nothing here touches the network or the filesystem, but the
// gates' own `git fetch` against the project root is untouched (it is read-only and is exactly the part
// worth exercising: it proves the project configuration points at a real checkout). Because
// `scaffoldReview` / `scaffoldTechDesign` never create the delivery document, Gate A and Gate B's
// `appendMachineSection` returns early on a missing file, so the target project's working tree is not
// modified either.
import { log } from '../util/log.ts';
import type { ProjectActions, ScriptResult, IssueWriteResult, PublishResult } from './actions.ts';
import type { ScaffoldOpts, IssueCommon, EpicChild } from '../workspace.ts';
import type { CreatedIssue } from '../types.ts';
import type { ProjectFull } from '../projects.ts'; // type-only, erased at runtime

const NOTE = 'REHEARSAL: not performed';

// number 0 is not a valid issue number anywhere, and .invalid can never resolve (RFC 2606) — so a
// placeholder that leaks into a card or the database is recognisable at a glance rather than plausible.
function placeholder(repo: string): CreatedIssue {
  return { repo, number: 0, url: `https://rehearsal.invalid/${repo}/no-issue-was-created` };
}

function noop(what: string): ScriptResult {
  log.info(`  rehearsal · ${what} — skipped, nothing was written`);
  return { ok: true, stdout: `${NOTE} — ${what}\n`, stderr: '' };
}

export function makeRehearsalActions(proj: ProjectFull): ProjectActions {
  const where = proj.root;
  return {
    scaffoldReview: async (o: ScaffoldOpts) => noop(`scaffold the review document for ${o.slug} under ${where}`),
    scaffoldTechDesign: async (o: ScaffoldOpts) => noop(`scaffold the technical plan for ${o.slug} under ${where}`),
    approveTechDesign: async (slug: string) => noop(`approve the technical plan for ${slug}`),

    // The issue writes. See the header for why these return a placeholder rather than nothing.
    createSingle: async (repo: string, title: string, _o: IssueCommon): Promise<IssueWriteResult> => ({
      ...noop(`create the issue "${title}" in ${repo}`),
      issues: [placeholder(repo)],
    }),
    // One per expected row — the Epic in the umbrella repo plus every child — because doWrites checks the
    // returned set against the specs it asked for, and a short set reads as a partial failure.
    createEpic: async (slug: string, title: string, children: EpicChild[], _o: IssueCommon): Promise<IssueWriteResult> => ({
      ...noop(`create the Epic "${title}" (${slug}) with ${children.length} sub-issue(s)`),
      issues: [placeholder(proj.umbrella ?? proj.repos?.[0] ?? 'umbrella'), ...children.map((c) => placeholder(c.repo))],
    }),

    // published:false is deliberate — see the header. It is what stops DONE from claiming a PR was opened.
    publishTechDesign: async (slug: string): Promise<PublishResult> => ({
      ...noop(`publish the technical plan for ${slug} to the main repo`),
      published: false,
    }),

    listEpicChildren: async (repo: string, slug: string) => {
      log.info(`  rehearsal · list the Epic children of ${slug} in ${repo} — skipped, returning none`);
      return { ok: true, issues: [], stderr: '' };
    },
    addLabel: async (repo: string, num: number, label: string) => {
      log.info(`  rehearsal · label ${repo}#${num} "${label}" — skipped`);
      return { ok: true, stderr: '' };
    },
  };
}
