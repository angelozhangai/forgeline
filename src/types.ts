import type { State } from './statemachine/states.ts';

export interface Session {
  id: string;
  ref_num: number | null; // human-readable requirement number -> displayed as REQ-<ref_num> (assigned on receipt, carried throughout)
  slug: string;
  title: string;
  state: State;
  project_id: string; // target project id (which of the Forge service's projects; defaults to 'demo'). Set at insert, never changes.
  branch: string; // 'main' | 'dev'
  prd_url: string | null;
  prd_text_path: string | null;
  chat_id: string | null; // originating channel id (IM-provider-neutral)
  doc_ref: string | null; // requirement document reference '<source>:<token>' (see src/docs/port.ts)
  poster_id: string | null; // id of the PM who posted the PRD, within that IM (used to @-mention them in the channel)
  intake_msg_id: string | null; // id of the PM's message (the bot replies underneath it)
  status_msg_id: string | null; // id of the bot's status card in the channel (edited in place throughout)
  // Complexity (relative estimate; Gate A proposes, a human confirms; carried throughout, written into
  // the issue, summable into a workload total)
  size: string | null; // S|M|L|XL (aligned with the main repo's load-eval / size:* labels)
  size_reason: string | null; // one sentence justifying the size
  size_source: string | null; // 'ai' | 'human'
  // PRD quality score (produced by Gate A's AI). Warning: private — queried only by `forge show` /
  // `forge scores`, never surfaced externally and never written into delivery documents (see
  // util/scoring.ts)
  prd_score: number | null; // total, 0-100
  prd_score_dims: string | null; // json ScoreDims {clarity,completeness,feasibility,testability}, each 0-25
  prd_score_reason: string | null; // one sentence on the main reason for lost points
  // gate A
  gate_a_output_path: string | null;
  gate_a_session_id: string | null; // self-pinned claude session id (pinned with --session-id on the first round, continued with --resume on re-review, saving tokens)
  gate_a_round: number | null; // current review round (1 = first; +1 for each PM answer that triggers a re-review)
  gate_a_pending_input: string | null; // an answer the PM just submitted, awaiting digestion by this round's re-review (cleared once digested)
  gate_a_residual: string | null; // json: still unresolved at the cap, handed to the maintainer to arbitrate (PM open questions, or codex adversarial findings)
  gate_a_reviewer_session: string | null; // Gate A adversarial: codex thread_id (continued via resume)
  gate_a_fixer_session: string | null; // Gate A adversarial: claude revision session_id (continued via resume)
  gate_a_adv_round: number | null; // completed Gate A adversarial rounds (counted separately from the PM rounds in gate_a_round)
  gate_a_fix_fail_streak: number | null; // consecutive failed fix invocations (circuit breaker; at max_fix_failures -> STALLED, reset to 0 on success)
  gate_a_cost_usd: number | null;
  repo_shas_a: string | null; // json {demo,example-web,example-admin}
  // triage
  routing: string | null; // json Routing
  // confirm
  confirmed_at: number | null;
  confirmed_by: string | null;
  confirmed_notes: string | null;
  // gate B
  gate_b_requested_by: string | null;
  gate_b_draft_path: string | null;
  issue_specs_path: string | null;
  repo_shas_b: string | null;
  adversarial_rounds: number | null; // final Gate B adversarial round (reused as the review-fix engine's round)
  adversarial_residual: string | null; // json {round,used,verdict,findings[]} — opinions still unresolved at the cap, handed over for human arbitration
  gate_b_cost_usd: number | null; // cumulative claude revision cost (codex review has no dollar figure; its tokens are stored separately)
  gate_b_reviewer_session: string | null; // codex thread_id (adversarial review, continued via resume)
  gate_b_fixer_session: string | null; // claude revision session_id (continued via resume)
  gate_b_round: number | null; // completed adversarial review rounds (drives orphan recovery and the round shown on the card)
  gate_b_fix_fail_streak: number | null; // consecutive failed fix invocations (circuit breaker; at max_fix_failures -> STALLED, reset to 0 on success)
  gate_b_pending_input: string | null; // input the maintainer just supplied, awaiting digestion by this round's revision (cleared once digested)
  gate_b_human_asks: string | null; // json HumanAsk[]: escalated questions currently awaiting the maintainer
  gate_b_reviewer_tokens: string | null; // json {input,cachedInput,output}: codex review tokens
  // Downstream Gate C (implementation + local CI; the reviewer is deterministic CI/acceptance, with no codex session)
  gate_c_requested_by: string | null;
  gate_c_draft_path: string | null; // logs/<id>/gate-c.json (ImplementationEnvelope)
  gate_c_round: number | null; // completed implement/CI rounds
  gate_c_fix_fail_streak: number | null; // consecutive failed fix invocations (circuit breaker; at max_fix_failures -> STALLED, reset to 0 on success)
  gate_c_pending_input: string | null; // input the maintainer just supplied, awaiting digestion by the resumed work
  gate_c_human_asks: string | null; // json HumanAsk[]: escalated implementation questions awaiting the maintainer
  gate_c_fixer_session: string | null; // claude implementation session_id (continued via resume)
  gate_c_residual: string | null; // summary of CI/acceptance failures still red at the cap (handed to the maintainer to arbitrate)
  gate_c_cost_usd: number | null;
  // Downstream Gate D (adversarial PR review + test hardening + merge readiness)
  gate_d_requested_by: string | null;
  gate_d_draft_path: string | null; // logs/<id>/gate-d.json
  gate_d_round: number | null;
  gate_d_fix_fail_streak: number | null; // consecutive failed fix invocations (circuit breaker; at max_fix_failures -> STALLED, reset to 0 on success)
  gate_d_pending_input: string | null;
  gate_d_human_asks: string | null; // json HumanAsk[]
  gate_d_reviewer_session: string | null; // codex thread_id (reviewing the diff, continued via resume)
  gate_d_fixer_session: string | null; // claude session_id for editing the worktree
  gate_d_reviewer_tokens: string | null; // json {input,cachedInput,output}
  gate_d_residual: string | null;
  gate_d_cost_usd: number | null;
  gate_d_rollback_to: string | null; // Gate D rollback-failure poison pill: the green HEAD sha to reset to; set <=> the worktree is in an unconfirmed state and must be reset and confirmed before entering the loop
  gate_d_harden_round: number | null; // test-hardening rounds started (>0 <=> GATE_D_HARDENING has been entered)
  gate_d_green_sha: string | null; // the green HEAD sha pinned at Gate D LGTM (the hardening baseline, immutable)
  gate_d_harden_verified_sha: string | null; // the HEAD sha whose CI was green after hardening (guards the idempotent fast path)
  // worktree / PR / merge
  target_repos: string | null; // json string[]: which code repo dir names the implementation lands in (chained runs take Gate A's repos_touched INTERSECT proj.repos; standalone takes --repo). Empty or missing -> falls back to proj.repos[0]
  legs: string | null; // json Leg[]: one leg per repo (worktree/branch/baseSha/CI/PR/Gate D fields — see src/gates/legs.ts). One repo = 1 leg; multi-repo gets one tree and one PR per repo
  worktree_path: string | null; // absolute path of the isolated worktree (created via proj.scripts.worktree_add; its identity is derived uniquely by gateC.implIdentity)
  impl_branch: string | null; // implementation branch = the safe key from gateC.implIdentity(): forge/<slug prefix>-<sha1 of the full id> (based on the unique id)
  base_shas: string | null; // json {repo: the origin/<base> sha anchored when the tree was created}
  pr_url: string | null;
  pr_number: number | null;
  merge_readiness_path: string | null; // docs/delivery/<slug>/merge-readiness.md
  merged_by: string | null; // who confirmed via forge merged (-> SHIPPED)
  merged_at: number | null;
  // standalone entry (a bare issue) + multi-tenant groundwork
  source_kind: string | null; // 'prd' (the chained upstream flow) | 'issue' (standalone, straight into Gate C)
  issue_ref: string | null; // standalone dedup key: repo#n or an issue URL
  tenant_id: string | null; // reserved for multi-tenancy (isolation logic is not enabled in this version)
  // assign (the DRI at filing time: automatic least-loaded + WIP recommendation, or a manual choice; written into the issue's assignee)
  assignee: string | null; // short code M/EO/CC/DE
  assignee_source: string | null; // 'auto' | 'human'
  assigned_by: string | null;
  assigned_at: number | null;
  assign_snapshot: string | null; // json AssignSnapshot: each person's load at the time the recommendation was computed (display only)
  // go / writes
  go_by: string | null;
  go_at: number | null;
  created_issues: string | null; // json [{repo,number,url}]
  techdesign_branch: string | null;
  // bookkeeping
  error: string | null;
  // Retry bookkeeping (automatic backoff retry on step failure + poison-pill dead lettering, see orchestrator/retry.ts)
  retry_count: number | null; // automatic transient-error retries already used in the current parked state (reset to 0 as soon as it advances)
  next_retry_at: number | null; // the moment (ms) a transient-error backoff expires; set <=> an automatic retry is scheduled
  reclaim_count: number | null; // cumulative recoveries from an orphaned state (the process died mid-run); prevents an infinite crash-restart loop
  dead_letter: number | null; // 1 = automation gave up (retries/recoveries exhausted), parked until a human clears it with retry
  // Multi-runner claim protection (lease; see leaseClaim in store/sessions.ts and orchestrator/jobs/runner.ts)
  lease_owner: string | null; // id of the runner currently holding this job's lease (NULL = unowned)
  lease_expires_at: number | null; // lease expiry (ms); once < now another runner may re-claim it (the holder is presumed dead)
  created_at: number;
  updated_at: number;
}

export interface Routing {
  reviewer: string; // short code M/CC/... (or 'engineer', meaning the DRI reviews their own)
  reviewerLogin: string | null;
  toLead: boolean; // whether to escalate to the tech lead
  reasons: string[];
  confidence: number;
}

export interface RepoShas {
  [repo: string]: string; // repo dir name -> origin/<branch> sha
}

export interface CreatedIssue {
  repo: string;
  number: number;
  url: string;
}
