-- The Forge state database (node:sqlite). JSON fields are stored as TEXT.

CREATE TABLE IF NOT EXISTS session (
  id                   TEXT PRIMARY KEY,
  ref_num              INTEGER,
  slug                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  state                TEXT NOT NULL,
  project_id           TEXT NOT NULL DEFAULT 'demo',  -- the target project id (which Forge project this belongs to; set at intake and never changed)
  branch               TEXT NOT NULL,
  prd_url              TEXT,
  prd_text_path        TEXT,
  chat_id              TEXT,
  doc_ref              TEXT,   -- the requirement-document reference: '<source>:<token>' (the source of truth for PRD-level deduplication; see src/docs/port.ts)
  poster_id            TEXT,
  intake_msg_id        TEXT,
  status_msg_id        TEXT,
  size                 TEXT,
  size_reason          TEXT,
  size_source          TEXT,
  prd_score            INTEGER,  -- the PRD quality score, 0-100 (produced by the Gate A AI; private, never shown outside)
  prd_score_dims       TEXT,     -- json {clarity,completeness,feasibility,testability}, each 0-25
  prd_score_reason     TEXT,     -- one sentence on the main reason points were deducted
  gate_a_output_path   TEXT,
  gate_a_session_id    TEXT,
  gate_a_round         INTEGER,  -- the current Gate A review round (1 = the first; every PM answer adds another re-review)
  gate_a_pending_input TEXT,     -- the answer the PM just submitted, awaiting this round's re-review (cleared once consumed)
  gate_a_residual      TEXT,     -- still unresolved at the cap and handed to the owner to arbitrate (open PM questions, or codex's adversarial findings; json)
  gate_a_reviewer_session TEXT,  -- Gate A adversarial: the codex thread_id (resumed to continue)
  gate_a_fixer_session    TEXT,  -- Gate A adversarial: the claude revision session_id (resumed to continue)
  gate_a_adv_round        INTEGER, -- how many Gate A adversarial re-review rounds are done (counted separately from the PM rounds in gate_a_round)
  gate_a_fix_fail_streak  INTEGER, -- consecutive failed fix (claude) calls (the circuit breaker; at max_fix_failures -> STALLED, and a success clears it)
  gate_a_cost_usd      REAL,
  repo_shas_a          TEXT,
  routing              TEXT,
  confirmed_at         INTEGER,
  confirmed_by         TEXT,
  confirmed_notes      TEXT,
  gate_b_requested_by  TEXT,
  gate_b_draft_path    TEXT,
  issue_specs_path     TEXT,
  repo_shas_b          TEXT,
  adversarial_rounds   INTEGER,
  adversarial_residual TEXT,
  gate_b_cost_usd      REAL,
  gate_b_reviewer_session TEXT,    -- the codex thread_id (resumed across adversarial re-review rounds, which saves tokens)
  gate_b_fixer_session    TEXT,    -- the claude revision session_id (resumed to continue)
  gate_b_round            INTEGER, -- how many Gate B adversarial re-review rounds are done (1 = the first review; each revise-and-re-review adds one)
  gate_b_fix_fail_streak  INTEGER, -- consecutive failed fix (claude) calls (the circuit breaker; at max_fix_failures -> STALLED, and a success clears it)
  gate_b_pending_input    TEXT,    -- the input the owner just answered with, awaiting this round's revision (cleared once consumed)
  gate_b_human_asks       TEXT,    -- json HumanAsk[]: the escalated questions currently awaiting the owner (needs_human)
  gate_b_reviewer_tokens  TEXT,    -- json {input,cachedInput,output}: codex's review tokens (stored separately, since codex reports no dollar figure)
  -- -- Downstream Gate C: implementation + local CI (the reviewer is deterministic CI/acceptance, with no codex session) --
  gate_c_requested_by  TEXT,
  gate_c_draft_path    TEXT,     -- logs/<id>/gate-c.json (a snapshot of the ImplementationEnvelope)
  gate_c_round         INTEGER,  -- how many implement/CI rounds are done
  gate_c_fix_fail_streak INTEGER, -- consecutive failed fix (claude) calls (the circuit breaker; at max_fix_failures -> STALLED, and a success clears it)
  gate_c_pending_input TEXT,     -- the input the owner just answered with, awaiting this round's continuation
  gate_c_human_asks    TEXT,     -- json HumanAsk[]: implementation questions escalated to the owner
  gate_c_fixer_session TEXT,     -- the claude implementation session_id (resumed to continue the work)
  gate_c_residual      TEXT,     -- the CI/acceptance failure summary that was still red at the cap (handed to the owner to arbitrate)
  gate_c_cost_usd      REAL,
  -- -- Downstream Gate D: PR adversarial review + test hardening + merge readiness --
  gate_d_requested_by  TEXT,
  gate_d_draft_path    TEXT,     -- logs/<id>/gate-d.json
  gate_d_round         INTEGER,
  gate_d_fix_fail_streak INTEGER, -- consecutive failed fix (claude) calls (the circuit breaker; at max_fix_failures -> STALLED, and a success clears it)
  gate_d_pending_input TEXT,
  gate_d_human_asks    TEXT,
  gate_d_reviewer_session TEXT,  -- the codex thread_id (reviewing the diff, resumed to continue)
  gate_d_fixer_session    TEXT,  -- the session_id of the claude that edits the worktree
  gate_d_reviewer_tokens  TEXT,  -- json {input,cachedInput,output}
  gate_d_residual      TEXT,
  gate_d_cost_usd      REAL,
  gate_d_rollback_to   TEXT,     -- the poison pill: when a Gate D revision rollback (reset --hard) fails, this holds "the green HEAD sha the worktree must be reset to". Set <=> the worktree is in an unconfirmed state, and the reset must be confirmed before the loop runs again - review-first must never run on an un-reset tree
  gate_d_harden_round  INTEGER,  -- how many test-hardening (GATE_D_HARDENING) rounds have started: > 0 <=> hardening has begun (planRetry uses this to send a GATE_D_FAILED back to HARDENING rather than burning another codex round for nothing)
  gate_d_green_sha     TEXT,     -- the worktree's pinned green HEAD sha at the moment codex said LGTM in Gate D. Hardening only ever resets to this **immutable sha**, never to the moving ref origin/<branch> (otherwise what gets hardened is not what codex reviewed)
  gate_d_harden_verified_sha TEXT, -- the HEAD sha at the moment the local CI went green after hardening. The idempotent finish's fast path checks against it that "HEAD is still the verified commit" before re-pushing, so it never pushes an unverified object blindly
  -- worktree / PR / merge
  target_repos         TEXT,     -- json string[]: the directory names of the code repos the implementation lands in (a chained run takes Gate A's repos_touched intersected with proj.repos; a standalone run takes --repo). Empty or missing -> fall back to proj.repos[0]
  legs                 TEXT,     -- json Leg[]: one leg per repo (worktree, branch, baseSha, CI, PR and every Gate D field - see src/gates/legs.ts). A single repo is one leg; several repos get one tree and one PR each
  worktree_path        TEXT,     -- the absolute path of the isolated worktree (created through proj.scripts.worktree_add; its identity derives uniquely from session.id)
  impl_branch          TEXT,     -- the implementation branch = the safe key derived by gateC.implIdentity(): forge/<slug prefix>-<sha1 of the whole id> (based on the unique id, so two sessions sharing a slug cannot delete each other)
  base_shas            TEXT,     -- json {repo: the origin/<base> sha the worktree was anchored to}
  pr_url               TEXT,
  pr_number            INTEGER,
  merge_readiness_path TEXT,     -- <deliveryDir>/<slug>/merge-readiness.md
  merged_by            TEXT,     -- who confirmed the merge via `forge merged` (-> SHIPPED)
  merged_at            INTEGER,
  -- the standalone entry point (a bare issue), plus room for multi-tenancy
  source_kind          TEXT,     -- 'prd' (the chained upstream flow) | 'issue' (standalone, starting directly at Gate C)
  issue_ref            TEXT,     -- the standalone deduplication key: repo#n or an issue URL
  tenant_id            TEXT,     -- reserved for multi-tenancy (no isolation logic is enabled in this version)
  assignee             TEXT,     -- the DRI's short code assigned at kickoff; written into the issue's assignee on GO
  assignee_source      TEXT,     -- 'auto' (the algorithm's recommendation was accepted) | 'human' (the owner chose it)
  assigned_by          TEXT,     -- who made the assignment decision
  assigned_at          INTEGER,
  assign_snapshot      TEXT,     -- json: each person's load at the moment the recommendation was computed (rendered as the reason on the GO card; purely for display)
  go_by                TEXT,
  go_at                INTEGER,
  created_issues       TEXT,
  techdesign_branch    TEXT,
  error                TEXT,
  retry_count          INTEGER,  -- how many automatic retries this parked state has already used for transient errors (reset to 0 as soon as it advances)
  next_retry_at        INTEGER,  -- when the transient-error backoff expires (ms); set <=> an automatic retry is scheduled
  reclaim_count        INTEGER,  -- how many times an orphaned state (the process died midway) has been reset; guards against a crash-restart loop
  dead_letter          INTEGER,  -- 1 = automation gave up (retries or reclaims exhausted), parked until a human retries and clears it
  lease_owner          TEXT,     -- so several runners cannot claim the same job: the runner id currently holding this job's lease (NULL = unowned)
  lease_expires_at     INTEGER,  -- when the lease expires (ms); once it is in the past another runner may claim it (the holder is presumed dead)
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_state ON session(state);
CREATE INDEX IF NOT EXISTS idx_session_slug ON session(slug);

CREATE TABLE IF NOT EXISTS event_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_session ON event_log(session_id);
-- The MAX(ts) debounce query behind lastEventTs(session_id, kind): this composite index lets it find the
-- extreme value through the index instead of scanning every event for that session (event_log grows with every
-- transition and event, and with only the session_id index it degrades into a scan filtered by kind).
CREATE INDEX IF NOT EXISTS idx_event_session_kind_ts ON event_log(session_id, kind, ts);

-- The group-message backfill cursor: one row per chat, where last_ts is the create_time (ms) of the last
-- message processed. After being offline, history is pulled from last_ts so the PRDs missed in the meantime are
-- recovered (see messaging/backfill.ts).
CREATE TABLE IF NOT EXISTS chat_cursor (
  chat_id  TEXT PRIMARY KEY,
  last_ts  INTEGER NOT NULL
);

-- The rolling health sample: the daemon writes a row roughly every 60s, and the status page draws the uptime
-- over the last N hours plus a timeline of outage and recovery events.
-- Pruned according to health.history_retain_hours (src/health/history.ts).
CREATE TABLE IF NOT EXISTS health_sample (
  ts            INTEGER NOT NULL,   -- when the sample was taken (ms)
  status        TEXT NOT NULL,      -- healthy | degraded | down
  ws            TEXT,               -- connected | disconnected | na
  db_ok         INTEGER,            -- 1/0
  active_gates  INTEGER,            -- how many gates were active at sampling time
  detail        TEXT                -- json: a summary of each check (for debugging)
);

CREATE INDEX IF NOT EXISTS idx_health_sample_ts ON health_sample(ts);

-- The latest result of each external dependency's "contract probe": one row per dependency (codex / claude /
-- gh / im), upserted after the daily scheduled probe.
-- ok=1 means the envelope is intact, 0 means it has drifted. The previous state is kept so a flip can be
-- debounced (a persistent drift alerts only once), and so the cache is restored after the daemon restarts.
-- Bounded at a handful of rows, so it needs no pruning. See src/health/contract.ts and src/llm/probes.ts.
CREATE TABLE IF NOT EXISTS contract_probe (
  dep         TEXT PRIMARY KEY,   -- 'codex' | 'claude' | 'gh' | 'im'
  ok          INTEGER NOT NULL,   -- 1 = the envelope is intact, 0 = it drifted
  detail      TEXT,               -- one line in plain language
  raw         TEXT,               -- the truncated raw payload (attached when it drifted)
  checked_at  INTEGER NOT NULL    -- when the probe ran (ms)
);
