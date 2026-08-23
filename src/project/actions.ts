// ProjectActions — the port for a target project's "mechanical actions" (creating issues, setting a status,
// publishing the technical plan, scaffolding for Gates A and B).
// It follows the MessagingPort pattern: the core depends on this interface only, and an adapter holds all of
// "how". The demo adapter delegates to the main repo's scripts (through the wrappers in workspace.ts); the
// nativeGithub adapter calls gh and the GitHub API directly and needs no scripts in the target project (for
// an open-source project, or one with no scripts). The selection point is in ./index.ts.
//
// The key part: the adapter injects scriptsDir and owner from "this session's project", so the caller no
// longer threads them through by hand — one fewer class of wiring mistake.
import * as ws from '../workspace.ts';
import type { ScaffoldOpts, IssueCommon, EpicChild } from '../workspace.ts';
import type { CreatedIssue } from '../types.ts';
import type { ProjectFull } from '../projects.ts'; // type-only: erased at compile time, so this module has no runtime dependency on projects.ts

// Parse the created sub-issues out of new-req.sh's epic output: the demo script prints a sub-issue as just
// `✓ C#11`, with no full URL, so parseIssues cannot pick it up.
// This is **the demo script's output format**, so it belongs to the demo adapter — doWrites no longer knows
// it, because the port's contract is that createEpic.issues holds everything created.
export function parseEpicChildren(stdout: string, repoMap: Record<string, string>, owner: string): CreatedIssue[] {
  const re = /✓\s+([CUA])#(\d+)/g;
  const seen = new Set<string>();
  const out: CreatedIssue[] = [];
  for (const m of stdout.matchAll(re)) {
    const repo = repoMap[m[1]];
    if (!repo) continue;
    const number = Number(m[2]);
    const key = `${repo}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, number, url: `https://github.com/${owner}/${repo}/issues/${number}` });
  }
  return out;
}

export interface ScriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export interface IssueWriteResult extends ScriptResult {
  issues: CreatedIssue[];
}
// The publish result: `published` distinguishes "a PR really was opened" (demo) from "nothing happened" (the
// native no-op) — the DONE wording follows it, so it never falsely claims the PR was merged automatically.
export interface PublishResult extends ScriptResult {
  published: boolean;
}

export interface ProjectActions {
  // Scaffolding for Gates A and B (the review and technical-plan documents)
  scaffoldReview(o: ScaffoldOpts): Promise<ScriptResult>;
  scaffoldTechDesign(o: ScaffoldOpts): Promise<ScriptResult>;
  approveTechDesign(slug: string, issue?: string | null, rollup?: boolean): Promise<ScriptResult>;
  // Creating the work items (a single repo, or a multi-repo Epic) and publishing the technical plan to the main repo
  createSingle(repo: string, title: string, o: IssueCommon): Promise<IssueWriteResult>;
  createEpic(slug: string, title: string, children: EpicChild[], o: IssueCommon): Promise<IssueWriteResult>;
  publishTechDesign(slug: string, o: { base: string; dryRun?: boolean }): Promise<PublishResult>;
  // The GitHub queries that go with creating issues: finding sub-issues by the epic label, and applying size labels
  listEpicChildren(repo: string, slug: string): Promise<{ ok: boolean; issues: CreatedIssue[]; stderr: string }>;
  addLabel(repo: string, num: number, label: string): Promise<{ ok: boolean; stderr: string }>;
}

// The demo adapter: it injects the project's scriptsDir and owner into workspace.ts's wrappers around the
// main repo's scripts.
// A caller passing ScaffoldOpts or IssueCommon does not have to supply scriptsDir or owner — they are
// overridden here, in one place.
export function makeDemoScriptActions(proj: ProjectFull): ProjectActions {
  const { scriptsDir, owner } = proj;
  const repoMap = proj.repoMap ?? {};
  return {
    scaffoldReview: (o) => ws.reviewReqScaffold({ ...o, scriptsDir }),
    scaffoldTechDesign: (o) => ws.techDesignScaffold({ ...o, scriptsDir }),
    approveTechDesign: (slug, issue, rollup = false) => ws.techDesignApprove(slug, issue, rollup, scriptsDir),
    createSingle: (repo, title, o) => ws.newReqSingle(repo, title, { ...o, scriptsDir, owner }),
    // A sub-issue only appears in stdout as `✓ C#n`, with no URL, so it is parsed out here and merged into
    // issues: the port's contract is "createEpic.issues = the Epic plus every sub-issue", and doWrites no
    // longer knows demo's ✓C#n format (the output format is decoupled).
    createEpic: async (slug, title, children, o) => {
      const r = await ws.newReqEpic(slug, title, children, { ...o, scriptsDir, owner });
      const merged = [...r.issues];
      for (const ci of parseEpicChildren(r.stdout, repoMap, owner)) {
        if (!merged.some((x) => x.repo === ci.repo && x.number === ci.number)) merged.push(ci);
      }
      return { ...r, issues: merged };
    },
    publishTechDesign: (slug, o) => ws.publishTechDesign(slug, { ...o, scriptsDir }).then((r) => ({ ...r, published: r.ok })), // demo really opens a PR, so ok means published
    listEpicChildren: (repo, slug) => ws.listEpicChildren(repo, slug, owner),
    addLabel: (repo, num, label) => ws.addLabel(repo, num, label, owner),
  };
}
