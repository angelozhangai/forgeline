import { readFileSync, existsSync } from 'node:fs';
import { GateBSchema } from './gates/envelopes.ts';
import type { IssueSpec } from './gates/envelopes.ts';
import { commitDeliveryDocs } from './workspace.ts';
import { projectActions, type ProjectActions } from './project/index.ts';
import { projectForSession, configForSession } from './projects.ts';
import { loadConfig, resolveLogin } from './config.ts';
import { log } from './util/log.ts';
import { reqRef } from './util/display.ts';
import { acceptanceMarkdown } from './util/acceptance.ts';
import { normSize, type Size } from './util/sizing.ts';
import { safeParse } from './util/json.ts';
import type { Session, CreatedIssue } from './types.ts';

export interface WriteResult {
  ok: boolean;
  stdout: string;
  issues: CreatedIssue[];
  published: boolean; // whether the technical plan **really** was published as a PR to the main repo (the demo adapter really does = true; a native no-op, or publishing switched off = false). The DONE wording follows this.
}

// dryRun prints without creating; onCreated is called back the moment an issue is created so it is persisted
// (nothing is lost in the crash window, and a retry uses it to skip recreating).
export interface WriteOpts {
  dryRun?: boolean;
  onCreated?: (issues: CreatedIssue[]) => void;
}

// The umbrella repo (where a multi-repo Epic itself lives) and the "repo letter -> repo name" mapping are now
// resolved from the target project (projectForSession(s) -> .umbrella / .repoMap).

// Committing the delivery documents automatically (gated by config, off by default, and it **never pushes**):
// it commits docs/delivery/<slug>/ onto the target project's current branch.
// It is called from two places: (1) when the work is opened successfully (archiving req-review and
// tech-design); (2) when Gate D has finished hardening every target repo and moves to merge-ready (archiving
// merge-readiness*.md).
// Best-effort — a failure or an exception only warns and never blocks a pipeline that has already succeeded;
// the result is returned so the caller can record an event and an audit trail. Exported so the downstream
// worker reuses the same gating.
export async function maybeCommitDeliveryDocs(s: Session): Promise<{ ok: boolean; committed: boolean }> {
  if (!loadConfig().runtime.delivery_doc_commit?.enabled) return { ok: true, committed: false };
  try {
    const { root } = projectForSession(s);
    const r = await commitDeliveryDocs({ root, slug: s.slug, refNum: s.ref_num ?? undefined });
    if (r.committed) log.info(`📄 committed the delivery documents docs/delivery/${s.slug} (onto the target project's current branch; not pushed)`);
    else if (!r.ok) log.warn(`committing the delivery documents automatically failed (it does not affect the pipeline; please commit them yourself): ${r.stderr}`);
    return { ok: r.ok, committed: r.committed };
  } catch (e) {
    log.warn(`committing the delivery documents automatically threw (it does not affect the pipeline): ${String(e).slice(0, 140)}`);
    return { ok: false, committed: false };
  }
}

// The issues the previous round already created (a WRITE_FAILED usually happens in the labelling or approval
// step *after* they exist) -> a retry uses this to skip recreating them, so an issue is never created twice.
function alreadyCreated(s: Session): CreatedIssue[] {
  const arr = safeParse<CreatedIssue[]>(s.created_issues, []);
  return Array.isArray(arr) ? arr.filter((i) => i?.repo && i.number) : [];
}

// Label the created issues with size:* (which feeds the size axis of the main repo's weekly-load.sh). It
// returns the failures, and doWrites decides from the aggregate whether to park.
// The size is visible to engineers as a label, but the weighted per-person workload (weekly-load) is
// management-facing — show the size, and do not misuse workload.
async function applySizeLabels(
  issues: CreatedIssue[],
  overall: Size | null,
  specs: IssueSpec[],
  repoMap: Record<string, string>,
  pa: ProjectActions,
): Promise<{ repo: string; number: number; stderr: string }[]> {
  const fails: { repo: string; number: number; stderr: string }[] = [];
  for (const iss of issues) {
    // An Epic (in the umbrella repo) or a single repo takes the whole requirement's tier; a sub-issue takes
    // that repo's slice tier, falling back to the whole requirement's.
    const spec = specs.find((sp) => repoMap[sp.repo] === iss.repo);
    const size = (spec?.size ? normSize(spec.size) : null) ?? overall;
    if (!size) continue;
    const r = await pa.addLabel(iss.repo, iss.number, `size:${size}`);
    if (!r.ok) fails.push({ repo: iss.repo, number: iss.number, stderr: r.stderr.slice(0, 120) });
  }
  return fails;
}

// Where it actually lands: create the issues (single repo or an Epic) and set status:3 as Gate B releases it.
// dryRun prints without creating.
// Idempotence (P1-D): (1) an issue is persisted through onCreated the moment it is created, so a failure in
// the labelling or approval that follows does not lose the record; (2) if created_issues already has entries
// on entry, recreating is skipped and only the idempotent labelling and approval are re-run — an issue is
// never created twice.
// Failures are never silent: a non-zero approve, a failed size label, or missing sub-issues in a multi-repo
// requirement all throw -> WRITE_FAILED, and it never pretends to be DONE.
export async function doWrites(s: Session, opts: WriteOpts = {}): Promise<WriteResult> {
  if (!s.gate_b_draft_path || !existsSync(s.gate_b_draft_path)) {
    throw new Error('the gate-b draft is missing, so the work items cannot be created');
  }
  const env = GateBSchema.parse(JSON.parse(readFileSync(s.gate_b_draft_path, 'utf8')));
  if (env.issue_specs.length === 0) throw new Error('issue_specs is empty, so there is no issue to create');
  // The target project decides the repo letter -> repo name mapping and the umbrella repo; the mechanical
  // actions go through the ProjectActions port (the adapter injects scriptsDir and owner).
  const proj = projectForSession(s);
  const { repoMap, umbrella } = proj;
  const pa = projectActions(proj);
  const prd = s.prd_url ?? undefined;
  // The DRI the work is opened under: the session's assignment (the automatic recommendation, or a human
  // reassignment) wins, falling back to the assignee in Gate B's issue_spec. The short code is resolved to a
  // login through **that project's** reviewers (configuration diverges per project: a short code produced by
  // the project's pool has to be mapped to a GitHub login by the project's own reviewers, or passing the bare
  // code to new-req.sh assigns the wrong person or fails).
  const sessionDri = s.assignee ? resolveLogin(configForSession(s), s.assignee) ?? s.assignee : null;
  // The requirement number travels the whole way through, so it goes into the issue body (linking back to
  // where the review came from). The complexity goes on as a size:* label (see applySizeLabels).
  const refLine = `Review reference: ${reqRef(s)}`;

  // Publish the technical-design document to the main repo first (commit, PR, merge), and only then create
  // the issues — the maintainer's rule is that the work opens once the plan has landed.
  // A failure throws -> go() moves to WRITE_FAILED and creates no issues; a transient error (gh, the network)
  // is retried automatically by classifyError; and it is idempotent, so it never publishes twice.
  let publishOut = '';
  let published = false; // only true when a PR really was opened (the native publishTechDesign is a no-op -> false), so the DONE wording never falsely claims the PR was merged
  const pub = proj.techDesignPublish; // resolved per project (projects.yaml can switch it off individually); it no longer reads the global runtime, which multiple projects and a pluggable target require
  if (pub?.enabled) {
    const r = await pa.publishTechDesign(s.slug, { base: pub.base, dryRun: opts.dryRun });
    publishOut = r.stdout ? `${r.stdout}\n` : '';
    if (!r.ok) throw new Error(`publishing the technical plan to the main repo failed: ${(r.stderr || r.stdout || '').slice(0, 300)} (fix it and retry go; it is idempotent and will not publish twice)`);
    published = r.published;
  }

  // Only a real run (not a dry run) considers resuming; a dry run always rehearses the whole thing.
  const resume = !opts.dryRun ? alreadyCreated(s) : [];

  // Failed size labels are aggregated and thrown together (weekly-load's numbers are never silently short);
  // this happens before approve, so a missing label does not get released to status:3.
  const failIfLabelsFailed = (fails: { repo: string; number: number }[]): void => {
    if (fails.length) {
      throw new Error(
        `${fails.length} size label(s) failed: ${fails.map((f) => `${f.repo}#${f.number}`).join(', ')}` +
          ` (labels out of sync? run the main repo's sync-labels.sh, then retry go; the issues already exist and are not created again)`,
      );
    }
  };
  const approveOrThrow = async (issue?: string): Promise<void> => {
    const ap = await pa.approveTechDesign(s.slug, issue, false);
    if (!ap.ok) throw new Error(`the tech-design approve failed: ${(ap.stderr || ap.stdout || '').slice(0, 300)} (fix it and retry go)`);
  };

  if (env.multi_repo) {
    const expectedRepos = [...new Set(env.issue_specs.map((i) => repoMap[i.repo] ?? i.repo))]; // the repos expected to have a sub-issue (deduplicated)
    const missingOf = (have: CreatedIssue[]): string[] => expectedRepos.filter((repo) => !have.some((i) => i.repo === repo));

    const fromResume = resume.length > 0;
    let issues = resume;
    let stdout = '(the issues already exist; recreating is skipped and only labelling and approval are re-run)';
    if (!fromResume) {
      const dri = sessionDri ?? env.issue_specs.find((i) => i.assignee)?.assignee;
      const type = env.epic_doc_type || env.issue_specs[0]?.type || 'feat';
      const prio = env.issue_specs[0]?.prio;
      const children = env.issue_specs.map((i) => ({ repo: i.repo, title: i.title }));
      // The Epic's body carries the full outer-ring acceptance (the definition of done for the cross-repo
      // contract); the per-repo sub-issues are created from `children` by the epic script.
      const epicBody = [refLine, acceptanceMarkdown(env.acceptance)].filter(Boolean).join('\n\n');
      const r = await pa.createEpic(s.slug, env.epic_title || s.title, children, {
        type, prio, assignee: dri, docUrl: prd, body: epicBody, dryRun: opts.dryRun,
      });
      if (opts.dryRun) return { ok: r.ok, stdout: publishOut + r.stdout, issues: r.issues, published };
      if (!r.ok) throw new Error(`creating the Epic failed: ${r.stderr.slice(0, 300)}`);
      // The port's contract: createEpic.issues is the Epic plus every sub-issue created (the demo adapter
      // parses them out of the script's output; the native one creates them itself and returns them
      // directly).
      // doWrites no longer knows any script's output format, which is what lets multi-repo work end to end on
      // the native path.
      issues = r.issues;
      opts.onCreated?.(issues); // the Epic and every created sub-issue are persisted (keeping what exists makes manual recovery possible and the done card complete)
      stdout = r.stdout;
    }

    // The coverage check runs on **both a fresh run and a resume**, closing the "blocked the first time, then
    // slips in through the side door on a re-run" gap: every expected repo has to have its sub-issue.
    // The main repo's script continues past a failed sub-issue (and still exits 0), so a missing sub-issue
    // must never be silently approved through to DONE.
    let missing = missingOf(issues);
    if (missing.length && fromResume && !opts.dryRun) {
      // On a re-run someone may already have filled the gap with new-req.sh add-child, so it rediscovers them
      // from GitHub by the epic:<slug> label and refreshes created_issues.
      const refreshed = [...issues];
      for (const repo of missing) {
        const q = await pa.listEpicChildren(repo, s.slug);
        if (q.ok) for (const iss of q.issues) if (!refreshed.some((x) => x.repo === iss.repo && x.number === iss.number)) refreshed.push(iss);
      }
      if (refreshed.length !== issues.length) {
        issues = refreshed;
        opts.onCreated?.(issues); // persist the refreshed set, so a later retry hits it directly and the done card is complete
      }
      missing = missingOf(issues);
    }
    if (missing.length) {
      throw new Error(
        `multi-repo sub-issues are missing: ${missing.join('/')} (expected ${expectedRepos.join('/')}). ` +
          `Create them with \`new-req.sh add-child <slug> <repo>\` and retry go (it rediscovers them by the epic label automatically, and never creates them twice)`,
      );
    }

    // The size label goes on the Epic only (the requirement's own row); sub-issues do not carry it (the main
    // repo's convention, and the cross-repo multiplier is computed separately).
    failIfLabelsFailed(await applySizeLabels(issues.filter((i) => i.repo === umbrella), normSize(s.size ?? ''), env.issue_specs, repoMap, pa));
    await approveOrThrow(); // epic.sh set <slug> 3, and the tech-design document becomes active
    await maybeCommitDeliveryDocs(s); // best-effort, gated by config, and it never pushes
    return { ok: true, stdout: publishOut + stdout, issues, published };
  }

  const spec = env.issue_specs[0];
  let issues = resume;
  let stdout = '(the issues already exist; recreating is skipped and only labelling and approval are re-run)';
  if (issues.length === 0) {
    // A single-repo issue's body is the review reference, the plan's background, and that repo's outer-ring
    // acceptance (the definition of done, which the engineer adds inner-ring unit and integration tests
    // against).
    const body = [refLine, spec.body, acceptanceMarkdown(env.acceptance, spec.repo)].filter(Boolean).join('\n\n');
    const r = await pa.createSingle(spec.repo, spec.title, {
      type: spec.type, prio: spec.prio, area: spec.area, assignee: sessionDri ?? spec.assignee, docUrl: prd, body, dryRun: opts.dryRun,
    });
    if (opts.dryRun) return { ok: r.ok, stdout: publishOut + r.stdout, issues: r.issues, published };
    if (!r.ok || r.issues.length === 0) throw new Error(`creating the issue failed: ${r.stderr.slice(0, 300)}`);
    opts.onCreated?.(r.issues);
    issues = r.issues;
    stdout = r.stdout;
  }
  failIfLabelsFailed(await applySizeLabels(issues, (spec.size ? normSize(spec.size) : null) ?? normSize(s.size ?? ''), env.issue_specs, repoMap, pa));
  await approveOrThrow(`${spec.repo}:${issues[0].number}`);
  await maybeCommitDeliveryDocs(s); // best-effort, gated by config, and it never pushes
  return { ok: true, stdout: publishOut + stdout, issues, published };
}
