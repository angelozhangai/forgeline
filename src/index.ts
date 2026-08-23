import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SVC_DIR, SCRIPTS_DIR, ENV_FILE, EXT_DIR } from './root.ts';
import { loadConfig } from './config.ts';
import { project, defaultProjectId } from './projects.ts';
import { parseHumanAsks } from './gates/envelopes.ts';
import { commandExists, runSync } from './util/proc.ts';
import { out, log } from './util/log.ts';
import { store as sessions } from './store/index.ts'; // through the SessionStore seam (the selection point), never straight to store/sessions.ts
import { db } from './store/db.ts';
import { addPrd, addImplementTask } from './intake.ts';
import { parseAnyRef, registeredIds } from './docs/index.ts';
import { port } from './messaging/index.ts';
import { tick } from './orchestrator/worker.ts';
import { listen } from './daemon/listen.ts';
import { confirm, submitPmAnswers, requestGateB, submitGateBAnswers, forceGateBGo, go, deny, retry, setSize, assign, postConfirmComment, requestGateC, submitGateCAnswers, requestReviewPr, submitGateDAnswers, ackMerged } from './actions.ts';
import { scoreBadge, scoreBand } from './util/scoring.ts';
import { routingOf, parseDims } from './store/readModel.ts';
import { costRows, costSummary, formatCost } from './cost.ts';
import { days } from './util/time.ts';
import { evaluateHealth } from './health/check.ts';
import { healthConfig } from './health/config.ts';
import { runWatchdog } from './health/watchdog.ts';
import { runContractCheckCli } from './health/contract.ts';
import { allProbes } from './store/contract.ts';
import { initHeartbeat, pingLiveness } from './health/heartbeat.ts';
import { startHealthServer } from './health/server.ts';
import { startControlServer } from './control/server.ts';
import { ACTIVE_GATE_STATES } from './statemachine/states.ts';
import { loadExtensions, extCommands, activePackName } from './ext/index.ts'; // the extension seam: a downstream product's CLI commands and lifecycle hooks

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

function userOf(flags: Flags): string {
  return str(flags.user) ?? 'M';
}

function help(): void {
  out(`forge - Forge · automated PRD review and technical planning

Usage: ./forge <command> [arguments]

  doctor                              check the environment (repos / claude / codex / gh / config / DB) · static
  health  [--json]                    check the running service (heartbeat / connection / DB / backups / dependencies / disk) plus the status page address
  status-page                         preview the status page on its own (health service only: no tick, no IM, no cost; Ctrl-C to exit)
  watchdog                            one watchdog pass: probe, self-heal, alert (launchd's StartInterval calls it; rarely typed by hand)
  contract-check                      actively probe the external CLI/API output contracts (one paid trivial call each for codex and claude, free for gh and IM) -> persist and alert on drift
  add --prd <document link> [--slug s] register a PRD (read the document and create a session; which source a link belongs to is decided by the registry)
      [--title t] [--branch prod|dev] [--chat <chatId>] [--project <id>]
  tick                                advance every ready session (Gate A / Gate B plus the adversarial review)
  listen                              the long-running daemon: the IM connection (card buttons and the channel entry point) plus the periodic tick
  control [--port N] [--host H]        the control-plane HTTP server (/jobs and /store only; it runs no orchestration). For orchestration and serving in one, use listen with FORGE_CONTROL_PORT (FORGE_CONTROL_* sets the port and auth; a non-loopback address requires a token)
  list | board  [--project <id>]      list every session and its state (--project filters by project)
  show <id|slug>                      show one session's detail and its event chain
  answer  <id|slug> [--notes ".."] [--user W]  product answers the open questions -> the next review round (runs on the next tick; the card in the channel is easier)
  confirm <id|slug> --user W [--notes ".."]   the maintainer forces the review closed -> CONFIRMED (product only answers on the channel card; the multi-round loop is ended by claude or the maintainer)
  size    <id|slug> <S|M|L|XL> [--reason ".."]  a reviewer sets or adjusts the complexity tier (it becomes a size:* label on the issues)
  workload [--since D] [--until D] [people...]   weighted load per person (private, management-facing: size x cross-repo x quality)
  scores  [--sort score] [--min N] [--project <id>]  the PRD quality scores (private, management-facing: scored by the Gate A AI, never shown outside)
  cost    [--since N] [--project <id>]  the cost board (private, management-facing: the claude dollars aggregated; --since N limits it to the last N days, --project filters by project)
  gateb   <id|slug> --user W           trigger Gate B (requires gate_b_allowed)
  gateb-answer <id|slug> [--notes ".."] [--user W]  the maintainer answers Gate B's escalated question -> the revision carries on (runs on the next tick; the card in the channel is easier)
  gateb-go <id|slug> --user W          force the work open while Gate B is parked for a decision (requires go_approvers)
  assign  <id|slug> [<M|EO|CC|DE>] --user W [--auto]  assign the DRI: a short code assigns by hand; nothing or --auto recommends by load and WIP
  go      <id|slug> --user W [--dry-run] [--assignee <code>]  create the work items in one step (requires go_approvers)
  deny    <id|slug> --user W [--reason ".."]  refuse the GO
  retry   <id|slug> --user W           reset a failed session to run again (authorised by the gate that failed: B -> gate_b_allowed / C -> gate_c_allowed / D -> pr_create_approvers / anything else -> go_approvers)
  eval    [--fixture <name>] [--runs N] [--no-save]  the golden offline evaluation: really run Gate A over the PRDs in fixtures/eval, compare against the expectations and report regressions, persist the run, and compare the trend against last time (⚠️ it calls claude for real, costs money, and is run by hand — never in CI; --runs N takes several samples to see the jitter)

  -- Downstream (Gate C implementation and Gate D PR review) --
  implement <slug> --user W                       chained: trigger Gate C after DONE (implement in an isolated worktree until local CI is green)
  implement --issue <repo#n|url> --title t [...]   standalone: start Gate C straight from a bare issue (--project/--repo/--branch optional)
  gatec-answer <id|slug> [--notes ".."] [--user W]  the maintainer answers Gate C's escalated question, or decides a parked session -> it carries on
  review-pr <id|slug> --user W                     once Gate C is green, trigger opening the PR (delegated to a script, and never merged automatically) plus Gate D, where codex reviews the diff and claude fixes (requires pr_create_approvers)
  gated-answer <id|slug> [--notes ".."] [--user W]  the maintainer answers Gate D's escalated question, or decides a parked session -> the revision carries on
  merged <id|slug> --user W [--force]              acknowledge a human-merged PR -> SHIPPED (it verifies the merge with gh first, then clears the isolated worktree and hands off to the drift loop; requires merge_ack_allowed. --force skips the verification)

Stages: INTAKE -> (Gate A, first round) -> AWAITING_PM_CONFIRM <-> (product answers -> re-review, resumed) -> CONFIRMED -> (gateb) -> ADVERSARIAL_LOOP <-> (codex reviews, claude revises, resumed) -> AWAITING_GO -> (go) -> DONE
      Gate A's rounds: each round of answers from product is fed back into the same session for another review, until claude judges no open question remains (or the maintainer forces it closed with confirm); still unsettled at max_pm_rounds -> GATE_A_STALLED, waiting on the maintainer to decide
      Gate B's rounds: codex reviewing and claude revising the technical plan each resume their own session; a revision that hits an open point -> AWAITING_GATE_B_INPUT, waiting on the maintainer (gateb-answer); still unsettled at the cap -> GATE_B_STALLED, waiting on the maintainer (gateb-go forces the work open, gateb-answer takes another round)
      Downstream: DONE -> (implement) -> Gate C implements until local CI is green -> AWAITING_GATE_D -> (review-pr) -> the PR is opened -> Gate D, where codex reviews the diff and claude fixes (CI has to be green before anything is pushed) -> GATE_D_HARDENING (add the inner-ring tests, get CI green, produce the merge-readiness report) -> AWAITING_HUMAN_MERGE (a human merges; never automatic) -> (merged) -> SHIPPED -> drift reconciliation
      Gate C and D's rounds: an escalation -> AWAITING_GATE_C/D_INPUT, waiting on the maintainer (gatec-answer / gated-answer); at the cap -> GATE_C/D_STALLED, waiting on a decision (a Gate C stall means CI is not green, so the only way on is another round — it is never released)`);
  // The commands an extension pack provides (see src/ext/). With no pack installed this whole section does
  // not appear, so the pure open-source help output is unchanged byte for byte.
  const ext = extCommands();
  if (ext.length > 0) {
    out(`\n  -- Extension commands (from the pack ${activePackName()}) --`);
    for (const c of ext) out(`  ${c.name.padEnd(36)}${c.summary}`);
  }
}

function doctor(extError: string | null): void {
  let bad = 0;
  const ck = (label: string, ok: boolean, note = ''): void => {
    out(`${ok ? '✓' : '✗'} ${label}${note ? `  — ${note}` : ''}`);
    if (!ok) bad++;
  };
  out('── Forge doctor ──');
  const cfg = (() => {
    try {
      return loadConfig();
    } catch (e) {
      ck('load the configuration', false, String(e).slice(0, 120));
      return null;
    }
  })();
  if (cfg) ck('load the configuration yaml', true);

  // Check each registered project in turn: its layout, and the code source-of-truth repos Gate A compares
  // against. With no registry, only the default project.
  const reg = cfg?.projects;
  const defId = defaultProjectId();
  const ids = reg ? Object.keys(reg.projects) : [defId];
  const multi = ids.length > 1;
  for (const id of ids) {
    const p = project(id);
    const tag = multi ? `[${id}${id === defId ? ' · default' : ''}] ` : '';
    out(`${tag}ROOT = ${p.root}`);
    ck(`${tag}the project layout (CLAUDE.md + scripts)`, p.looksValid());
    for (const repo of p.repos) {
      const gitdir = resolve(p.repoPath(repo), '.git');
      const ok = existsSync(gitdir);
      let sha = '';
      if (ok) {
        try {
          sha = runSync('git', ['-C', p.repoPath(repo), 'rev-parse', '--short', 'HEAD']).trim();
        } catch {
          /* ignore */
        }
      }
      ck(`${tag}the repo ${repo}`, ok, ok ? `HEAD ${sha}` : "not cloned (run the project's ./scripts/bootstrap.sh)");
    }
  }
  if (cfg) {
    ck('the claude CLI', commandExists(cfg.runtime.claude_bin), commandExists(cfg.runtime.claude_bin) ? 'present' : 'missing');
    const codexOk = commandExists(cfg.runtime.codex_bin);
    ck(`the codex CLI (the adversarial reviewer=${cfg.runtime.adversarial.reviewer})`, codexOk, codexOk ? 'present' : `missing -> on_missing=${cfg.runtime.adversarial.on_missing}`);
  }
  const ghOk = commandExists('gh');
  let ghUser = '';
  if (ghOk) {
    try {
      ghUser = runSync('gh', ['api', 'user', '-q', '.login']).trim();
    } catch {
      /* ignore */
    }
  }
  ck('the gh CLI is logged in', ghOk && !!ghUser, ghUser ? `as ${ghUser}` : "not logged in (the write scripts need write access to the target project's GitHub org)");
  ck('feishu-doc.js', existsSync(resolve(SCRIPTS_DIR, 'feishu-doc.js')));
  ck('config/forge.env', existsSync(ENV_FILE), existsSync(ENV_FILE) ? '' : 'missing (optional; copy it from the .example)');
  if (cfg) {
    // Only the provider **currently in effect** is checked: one machine never runs two IMs at once, and
    // listing the one that is not in use would be pure noise.
    out(`  IM provider: ${port.id} (FORGE_MESSAGING_PROVIDER, defaulting to feishu)`);
    if (port.id === 'slack') {
      const e = cfg.env;
      ck('the Slack bot token (posting, editing and reading history)', !!e.SLACK_BOT_TOKEN, e.SLACK_BOT_TOKEN ? 'configured' : 'SLACK_BOT_TOKEN is missing (xoxb-...)');
      ck('the Slack app token (connecting in Socket Mode)', !!e.SLACK_APP_TOKEN, e.SLACK_APP_TOKEN ? 'configured' : 'SLACK_APP_TOKEN is missing (xapp-..., and Socket Mode has to be enabled in the app settings)');
      ck('the Slack direct-message target', !!e.SLACK_DM_USER_ID, e.SLACK_DM_USER_ID ? 'configured' : 'SLACK_DM_USER_ID is missing (it degrades to the desktop notification and the log)');
      ck('the Slack channels to watch (the channel entry point and the offline backfill)', !!e.SLACK_WATCH_CHANNELS, e.SLACK_WATCH_CHANNELS ? 'configured' : 'SLACK_WATCH_CHANNELS is missing');
      // With no bot user id, a channel message cannot be checked for "was I mentioned", so the core
      // conservatively ignores **every** channel message. This is not optional — without it, it is silent.
      ck('the Slack bot user id (deciding whether a channel message mentions the bot)', !!e.SLACK_BOT_USER_ID, e.SLACK_BOT_USER_ID ? 'configured' : 'SLACK_BOT_USER_ID is missing -> every channel message is conservatively ignored');
      ck('the native WebSocket (Socket Mode connects with no dependency)', typeof WebSocket === 'function', typeof WebSocket === 'function' ? `Node ${process.version}` : 'only Node >= 22 has it built in');
    } else {
      const botOk = !!(cfg.env.FEISHU_BOT_APP_ID && cfg.env.FEISHU_BOT_APP_SECRET);
      const tgt = cfg.env.FEISHU_DM_OPEN_ID || cfg.env.FEISHU_DM_UNION_ID || cfg.env.FEISHU_DM_CHAT_ID || cfg.env.FEISHU_DM_EMAIL;
      ck('the Feishu bot direct-message notification', botOk && !!tgt, botOk ? (tgt ? 'configured' : 'the target FEISHU_DM_* is missing') : 'not configured (it degrades to the desktop notification and the log)');
      const sdkOk = existsSync(resolve(SVC_DIR, 'node_modules/@larksuiteoapi/node-sdk'));
      ck('the Feishu connection SDK (forge listen: card buttons and the channel entry point)', sdkOk, sdkOk ? 'installed (the app settings need event subscription over a long connection enabled; see deploy/README)' : 'npm install');
    }
  }
  try {
    db();
    ck('the SQLite state store', true);
    // The external tools' contracts: this only reads the last probe state, and never triggers a probe inside
    // doctor — that costs money, and belongs to `forge contract-check` or the daily schedule.
    try {
      const probes = allProbes();
      if (probes.length === 0) {
        ck("the external tools' contracts (from the last probe)", true, 'not probed yet (run ./forge contract-check)');
      } else {
        const drifted = probes.filter((p) => !p.ok);
        const ageMin = Math.max(0, Math.round((Date.now() - Math.max(...probes.map((p) => p.checkedAt))) / 60000));
        ck("the external tools' contracts (from the last probe)", drifted.length === 0, drifted.length ? `drifted: ${drifted.map((d) => d.dep).join(', ')} (${ageMin} minutes ago)` : `${probes.map((p) => p.dep).join('/')} are fine (${ageMin} minutes ago)`);
      }
    } catch {
      /* showing the contracts is best-effort */
    }
  } catch (e) {
    ck('the SQLite state store', false, String(e).slice(0, 120));
  }
  // The extension pack: not configured simply means not configured (the normal pure open-source path, and not
  // a problem). Configured but failing to load must go visibly red — which is exactly why doctor exists: when
  // loading fails every other command exits non-zero, and only doctor can still tell you why.
  if (extError) ck('the extension pack', false, extError.slice(0, 160));
  else out(`· extension pack: ${activePackName()}${activePackName() === '(none)' ? ` (none configured; running the pure core — see ${EXT_DIR})` : ''}`);
  out(bad === 0 ? '\nEverything is ready.' : `\n${bad} item(s) need attention.`);
  process.exitCode = bad === 0 ? 0 : 1;
}

// Preview the status page on its own: it starts the health service and the heartbeat/liveness only, and does
// **not** run a tick, connect to IM, or cost anything.
// It is for glancing at the page on your own machine; for a real long-running service see ./forge listen or
// ./deploy/install.sh.
async function statusPage(): Promise<void> {
  const hcfg = healthConfig();
  initHeartbeat({ pid: process.pid, port: hcfg.port, wsConfigured: false, now: Date.now() });
  startHealthServer(hcfg.port);
  const ping = async (): Promise<void> => {
    try {
      pingLiveness(Date.now(), await sessions.countByStates([...ACTIVE_GATE_STATES]));
    } catch {
      /* the ping is best-effort */
    }
  };
  await ping();
  setInterval(() => void ping(), hcfg.livenessPingSec * 1000);
  out(`Status page (standalone preview; no tick, no IM): http://127.0.0.1:${hcfg.port}/  -- Ctrl-C to exit`);
  await new Promise(() => {}); // stays up until Ctrl-C
}

// The control-plane server (the control-plane / runner split): it serves /jobs (where a runner pulls jobs)
// and /store (reading and writing the central state).
// It is separate from the local status page (health/server.ts). Auth, port and bind address come from the
// FORGE_CONTROL_* env vars (the forge wrapper exports them from forge.env).
// ⚠️ This command **only starts the HTTP surface and runs no orchestration tick** (reclaim, retry, autonomy,
// reminders, the sweep and drift all live in worker.tick). So for a "control plane plus pure runners" setup
// to actually orchestrate, something on the control-plane machine has to run a tick — **the recommended way
// is `forge listen` with FORGE_CONTROL_PORT set**: one listen process is orchestration plus its own jobs plus
// serving the extra runners (see daemon/listen.ts). This standalone command is for the case where you want
// only the HTTP surface, with orchestration provided separately by a `forge listen` on the same sqlite.
// It stays up until Ctrl-C.
async function controlCmd(flags: Flags): Promise<void> {
  const port = Number(str(flags.port) ?? process.env.FORGE_CONTROL_PORT ?? '4320') || 4320;
  const host = str(flags.host) ?? process.env.FORGE_CONTROL_HOST ?? '127.0.0.1';
  const token = process.env.FORGE_CONTROL_TOKEN || undefined;
  // A non-loopback address with no token, or FORGE_CONTROL_URL being set, throws synchronously (fail-closed);
  // a failed bind rejects. Both propagate to main().catch and exit 1.
  await startControlServer({ port, host, token });
  out(`The control-plane server is running: http://${host}:${port}/ (/jobs /store /healthz) -- Ctrl-C to exit`);
  await new Promise(() => {}); // stays up
}

// Checking the running service: whether the daemon is alive, the connection, the database, backups,
// dependencies and disk, plus the local status page address. It complements the static doctor.
async function healthCmd(flags: Flags): Promise<void> {
  const report = await evaluateHealth();
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'down' ? 1 : 0;
    return;
  }
  const icon = (s: string): string => (s === 'healthy' ? '🟢' : s === 'degraded' ? '🟡' : s === 'down' ? '🔴' : '⚪');
  out('-- Forge health --');
  out(`${icon(report.status)} overall: ${report.status}`);
  if (report.daemon.pid != null) {
    out(`daemon PID ${report.daemon.pid} · up ${report.uptimeSec ?? '—'}s · cycles ${report.daemon.cycleCount} · active gates ${report.daemon.activeGates}${report.daemon.wedged ? ' · ⚠️ wedged' : ''}`);
  } else {
    out('the daemon is not running (no heartbeat) -- start it with ./forge listen, or let launchctl manage it');
  }
  out('');
  for (const c of report.checks) out(`${icon(c.status)} ${c.name}  ${c.detail}`);
  out('');
  out(`Board: ${report.board.total} in total · ${report.board.awaiting} waiting on a human · ${report.board.failed} failed`);
  out(`Status page: http://127.0.0.1:${healthConfig().port}/`);
  process.exitCode = report.status === 'down' ? 1 : 0;
}

async function listCmd(flags: Flags): Promise<void> {
  const rows = await sessions.listAll(str(flags.project)); // --project <id> filters by project (the default is the whole database)
  if (rows.length === 0) {
    out('(no sessions)');
    return;
  }
  out('STATE                 SLUG                      ROUTING        ID');
  for (const s of rows) {
    const r = routingOf(s);
    const routing = r ? (r.toLead ? `→${r.reviewer}` : 'DRI') : '';
    out(
      `${s.state.padEnd(21)} ${s.slug.slice(0, 25).padEnd(25)} ${routing.padEnd(14)} ${s.id}`,
    );
  }
}

// The PRD quality scores (private, management-facing): the score the Gate A AI review gave, which neither
// engineers nor anyone outside can see. A low score signals a PRD that needs work.
// The default order is by requirement number, descending (newest first); `--sort score` puts the lowest
// scores first (so the worst get attention); `--min N` shows only those at or above N.
async function scoresCmd(flags: Flags): Promise<void> {
  const byScore = str(flags.sort) === 'score';
  const min = str(flags.min) !== undefined ? Number(str(flags.min)) : undefined;
  let rows = (await sessions.listAll(str(flags.project))).filter((s) => s.prd_score != null); // --project <id> filters by project
  if (min !== undefined && !Number.isNaN(min)) rows = rows.filter((s) => (s.prd_score ?? 0) >= min);
  if (rows.length === 0) {
    out('(no PRD scores yet — only a requirement that has been through the Gate A review has one)');
    return;
  }
  if (byScore) rows = rows.slice().sort((a, b) => (a.prd_score ?? 0) - (b.prd_score ?? 0));
  out('REQ       SCORE  BAND       CLR/CMP/FEA/TST     SIZE  SLUG');
  for (const s of rows) {
    const score = s.prd_score ?? 0;
    const d = parseDims(s.prd_score_dims);
    const dims = d ? `${d.clarity}/${d.completeness}/${d.feasibility}/${d.testability}` : '-';
    const ref = s.ref_num != null ? `REQ-${s.ref_num}` : s.id.slice(0, 8);
    const flag = score < 55 ? ' ⚠' : '';
    out(
      `${ref.padEnd(9)} ${String(score).padStart(3)}    ${scoreBand(score).padEnd(10)} ${dims.padEnd(18)}  ${(s.size ?? '-').padEnd(4)}  ${s.slug.slice(0, 24)}${flag}`,
    );
  }
  const avg = Math.round(rows.reduce((a, s) => a + (s.prd_score ?? 0), 0) / rows.length);
  out(`\n${rows.length} rows · average ${avg} (private; visible only to this service)`);
}

// The cost board (private, management-facing): the claude dollars aggregated per requirement, summarised by
// state, plus the total.
// `--since N` limits it to requirements updated in the last N days (by updated_at). ⚠️ Never shown outside;
// like scores and workload it belongs to the management surface.
async function costCmd(flags: Flags): Promise<void> {
  let rows = await sessions.listAll(str(flags.project)); // --project <id> filters by project (the default is the whole database)
  const since = str(flags.since) !== undefined ? Number(str(flags.since)) : undefined;
  if (since !== undefined && !Number.isNaN(since)) {
    const cutoff = Date.now() - days(since);
    rows = rows.filter((s) => s.updated_at >= cutoff);
  }
  const cr = costRows(rows);
  out(formatCost(cr, costSummary(cr)));
}

async function showCmd(idOrSlug: string): Promise<void> {
  const s = await sessions.resolve(idOrSlug);
  if (!s) {
    out(`not found: ${idOrSlug}`);
    process.exitCode = 1;
    return;
  }
  out(`# ${s.slug}  (${s.id})`);
  out(`state:   ${s.state}`);
  out(`title:   ${s.title}`);
  out(`branch:  ${s.branch}`);
  out(`prd:     ${s.prd_url ?? '-'}`);
  if (s.routing) out(`routing: ${s.routing}`);
  if (s.gate_a_round != null) {
    out(`Gate A review: round ${s.gate_a_round}${s.gate_a_session_id ? `  (session ${s.gate_a_session_id.slice(0, 8)}..., the re-review resumes it)` : ''}`);
  }
  if (s.gate_a_residual) {
    out('-- Gate A hit its round cap with open questions unresolved (waiting on the maintainer) --');
    try {
      const r = JSON.parse(s.gate_a_residual) as { round: number; open_questions: { q: string; severity?: string; suggestion?: string }[] };
      out(`  ${r.open_questions.length} still open at round ${r.round}:`);
      r.open_questions.forEach((q, i) => {
        out(`  ${i + 1}. [${q.severity ?? 'med'}] ${q.q}`);
        if (q.suggestion) out(`      suggestion: ${q.suggestion}`);
      });
      out(`  Force it through: ./forge confirm ${s.slug} --user M`);
    } catch {
      out(`  ${s.gate_a_residual}`);
    }
  }
  if (s.gate_b_round != null && s.gate_b_round > 0) {
    const rev = s.gate_b_reviewer_session ? `codex ${s.gate_b_reviewer_session.slice(0, 8)}…` : '-';
    const fix = s.gate_b_fixer_session ? `claude ${s.gate_b_fixer_session.slice(0, 8)}…` : '-';
    out(`Gate B adversarial: round ${s.gate_b_round} (reviewer ${rev} / fixer ${fix}, both resumed)`);
  }
  {
    // Normalised by the schema (an older string[] of options still works) — it goes through parseHumanAsks
    // like the cards and gateBLoop, so [object Object] is never rendered.
    const asks = parseHumanAsks(s.gate_b_human_asks);
    if (asks.length) {
      out("-- Gate B's revision escalated, waiting on the maintainer --");
      asks.forEach((a, i) => {
        const opts = a.options.map((o) => `${o.recommended ? '★' : ''}${o.label}`).join(' / ');
        out(`  ${i + 1}. [${a.severity}] ${a.question}${opts ? ` (options: ${opts})` : ''}`);
      });
      out(`  Answer: ./forge gateb-answer ${s.slug} --notes "..."`);
    }
  }
  if (s.prd_score != null) {
    out(`prd score: ${scoreBadge(s.prd_score, parseDims(s.prd_score_dims))}${s.prd_score_reason ? ` — ${s.prd_score_reason}` : ''}  (private)`);
  }
  if (s.confirmed_by) out(`confirmed: ${s.confirmed_by} ${s.confirmed_notes ?? ''}`);
  if (s.created_issues) out(`issues:  ${s.created_issues}`);
  if (s.error) out(`error:   ${s.error}`);
  const cost = (s.gate_a_cost_usd ?? 0) + (s.gate_b_cost_usd ?? 0) + (s.gate_c_cost_usd ?? 0) + (s.gate_d_cost_usd ?? 0);
  if (cost) out(`cost:    $${cost.toFixed(4)}`);
  if (s.adversarial_residual) {
    out('-- Adversarial review comments still undecided (a human has to decide before GO) --');
    try {
      const r = JSON.parse(s.adversarial_residual) as {
        round: number;
        used: string;
        findings: { severity: string; issue: string; where?: string; fix?: string; evidence?: string }[];
      };
      out(`  At the cap, round ${r.round} (reviewer=${r.used}), ${r.findings.length} unresolved:`);
      r.findings.forEach((f, i) => {
        out(`  ${i + 1}. [${f.severity}] ${f.issue}${f.where ? ` @${f.where}` : ''}`);
        if (f.fix) out(`      suggestion: ${f.fix}`);
        if (f.evidence) out(`      evidence: ${f.evidence}`);
      });
    } catch {
      out(`  ${s.adversarial_residual}`);
    }
  }
  out('── events ──');
  for (const e of await sessions.events(s.id)) {
    out(`  ${new Date(e.ts).toISOString()}  ${e.kind}  ${e.detail ?? ''}`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  // The extension pack loads first: help lists its commands, doctor reports its state, and the default branch
  // dispatches to it.
  // A load failure is **not thrown here** — that would stop `forge doctor`, the one command that can tell you
  // why it failed, from running at all.
  // Instead it is recorded: doctor shows it, and every other command refuses to run and exits non-zero
  // (present means it has to load successfully; it never degrades silently).
  let extError: string | null = null;
  try {
    await loadExtensions();
  } catch (e) {
    extError = String(e instanceof Error ? e.message : e);
  }
  if (extError && cmd !== 'doctor') {
    log.err(`the extension pack failed to load, so "${cmd ?? '(none)'}" was refused: ${extError}`);
    log.err('Run `forge doctor` for the details; if you really do not want the extension, clear FORGE_EXT_DIR or move $FORGE_HOME/ext away.');
    process.exitCode = 1;
    return;
  }
  switch (cmd) {
    case 'doctor':
      doctor(extError);
      break;
    case 'add': {
      const raw = str(flags.prd) ?? pos[0] ?? '';
      // Which source a link belongs to is the registry's decision; if nobody recognises it, **say so** — never
      // guess a source, because guessing wrong registers a requirement whose body can never be read.
      const doc = raw ? parseAnyRef(raw) : null;
      if (!doc) {
        out(raw ? `unrecognised requirement document: ${raw} (the registered document sources are: ${registeredIds().join('/') || 'none'})` : 'missing --prd <document link>');
        process.exitCode = 1;
        break;
      }
      const r = await addPrd({
        doc,
        slug: str(flags.slug),
        title: str(flags.title),
        projectId: str(flags.project), // name the target project explicitly (by default it resolves through the channel-to-project mapping, then the default)
        branch: str(flags.branch) === 'prod' ? 'prod' : str(flags.branch) === 'dev' ? 'dev' : undefined,
        chatId: str(flags.chat),
      });
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'tick':
      await tick();
      break;
    case 'listen':
      await listen();
      break;
    case 'health':
      await healthCmd(flags);
      break;
    case 'status-page':
      await statusPage();
      break;
    case 'control':
      await controlCmd(flags);
      break;
    case 'watchdog': {
      const d = await runWatchdog();
      out(`watchdog: ${d.klass} · action=${d.action.kind}${d.livenessAgeSec != null ? ` · liveness ${d.livenessAgeSec}s ago` : ''}`);
      break;
    }
    case 'contract-check': {
      // Actively probe the external CLI and API output contracts (one paid trivial call each for codex and
      // claude; gh and the IM API are free and read-only) -> persist and alert on drift.
      const results = await runContractCheckCli(Date.now());
      const drifted = results.filter((r) => r.available && !r.ok);
      process.exitCode = drifted.length ? 1 : 0;
      break;
    }
    case 'eval': {
      // The golden eval: really run the Gate A prompt over the PRDs in fixtures/eval and compare the output's
      // shape against the expectations -> report regressions.
      // ⚠️ It calls claude for real (**and costs money**), so it is not part of npm run ci and is only run by
      // hand. --runs N takes several samples to see the jitter; the run is persisted and compared against the
      // previous one.
      const { runEval } = await import('./eval/runEval.ts');
      const { loadFixtures } = await import('./eval/expectations.ts');
      const { formatReport, diffRuns, formatTrend } = await import('./eval/aggregate.ts');
      const { saveEvalRun, loadLatestEvalRun } = await import('./eval/store.ts');
      const only = str(flags.fixture);
      const runs = Math.max(1, Number(str(flags.runs) ?? '1') || 1);
      const fxs = loadFixtures(undefined, only);
      const n = fxs.length;
      if (n === 0) {
        out(only ? `no such fixture: ${only}` : 'there are no fixtures (fixtures/eval/ is empty)');
        process.exitCode = 1;
        break;
      }
      const judgeN = fxs.filter((f) => f.expect.acceptance_judge).length; // each Gate B fixture with an acceptance-judge costs one extra claude call
      const calls = (n + judgeN) * runs;
      out(`⚠️ forge eval calls claude for real (**it costs money**): ${n} fixture(s)${judgeN ? ` (${judgeN} of them with an acceptance-judge, each costing one extra call)` : ''} x ${runs} run(s) = ${calls} claude calls, each a real review...\n`);
      const prev = loadLatestEvalRun(); // read the previous run before persisting this one, as the trend baseline
      const report = await runEval({ only, runs });
      out(formatReport(report));
      if (!flags['no-save']) {
        report.ranAt = new Date().toISOString().replace(/[:.]/g, '-');
        try {
          report.gitSha = runSync('git', ['rev-parse', '--short', 'HEAD']).trim() || null;
        } catch {
          report.gitSha = null;
        }
        out(`\nPersisted to: ${saveEvalRun(report, report.ranAt)}`);
      }
      if (prev) out(`\n${formatTrend(diffRuns(prev, report))}`);
      process.exitCode = report.allPass ? 0 : 1;
      break;
    }
    case 'list':
    case 'board':
      await listCmd(flags);
      break;
    case 'show':
      await showCmd(pos[0] ?? '');
      break;
    case 'answer': {
      const who = str(flags.user) ?? 'PM';
      const r = await submitPmAnswers(pos[0] ?? '', who, str(flags.notes));
      const s = await sessions.resolve(pos[0] ?? '');
      if (r.ok && s) await postConfirmComment(s, { who, notes: str(flags.notes) }); // product's answer leaves a record on the document
      out(r.msg);
      if (r.ok) out(`Next: ./forge tick  to run this round's re-review`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'confirm': {
      const r = await confirm(pos[0] ?? '', userOf(flags), str(flags.notes));
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'size': {
      const r = await setSize(pos[0] ?? '', pos[1] ?? '', userOf(flags), str(flags.reason));
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'workload': {
      // Weighted load per person (private, management-facing): size x cross-repo x quality. The tool and the
      // weighting stay in the private Forge, out of sight of engineers.
      const tool = resolve(SVC_DIR, 'tools/weekly-load.sh');
      const r = spawnSync('bash', [tool, ...rest], { stdio: 'inherit' });
      process.exitCode = r.status ?? 0;
      break;
    }
    case 'scores':
      // The PRD quality scores (private, management-facing): scored by the Gate A AI, and visible to neither
      // engineers nor anyone outside.
      await scoresCmd(flags);
      break;
    case 'cost':
      // The cost board (private, management-facing): the claude dollars aggregated, never shown outside.
      await costCmd(flags);
      break;
    case 'gateb': {
      const r = await requestGateB(pos[0] ?? '', userOf(flags));
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'gateb-answer': {
      const r = await submitGateBAnswers(pos[0] ?? '', str(flags.user) ?? 'M', str(flags.notes));
      out(r.msg);
      if (r.ok) out(`Next: ./forge tick  to run this round's revision`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'gateb-go': {
      const r = await forceGateBGo(pos[0] ?? '', userOf(flags));
      out(r.msg);
      if (r.ok) out(`Next: ./forge go ${pos[0] ?? ''} --user ${userOf(flags)}  to create the work items`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'assign': {
      // Assign the DRI: a short code assigns by hand; no code, or --auto, recommends with the least-loaded plus
      // WIP algorithm and adopts it (printing everyone's load as the reasoning).
      const code = pos[1] && !pos[1].startsWith('--') ? pos[1] : undefined;
      const r = await assign(pos[0] ?? '', userOf(flags), { to: code, auto: !!flags.auto });
      out(r.msg);
      if (r.ok) out(`Next: ./forge go ${pos[0] ?? ''} --user ${userOf(flags)}  to create the work items (or use the card's one-click GO)`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'go': {
      const r = await go(pos[0] ?? '', userOf(flags), { dryRun: !!flags['dry-run'], force: !!flags.force, assignee: str(flags.assignee) });
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'deny': {
      const r = await deny(pos[0] ?? '', userOf(flags), str(flags.reason));
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'implement': {
      // Standalone, from a bare issue: implement --issue <ref> --title "..." [--body "..."] [--project id] [--repo r] [--branch prod|dev]
      if (str(flags.issue)) {
        const r = await addImplementTask({
          issueRef: str(flags.issue) ?? '',
          title: str(flags.title) ?? '',
          body: str(flags.body),
          projectId: str(flags.project),
          repo: str(flags.repo),
          branch: str(flags.branch) === 'prod' ? 'prod' : str(flags.branch) === 'dev' ? 'dev' : undefined,
          by: userOf(flags),
        });
        out(r.msg);
        if (r.ok && r.created) out('Next: ./forge tick  to create the worktree, implement, and run local CI automatically');
        process.exitCode = r.ok ? 0 : 1;
        break;
      }
      // Chained: implement <slug> (triggering Gate C from DONE)
      const r = await requestGateC(pos[0] ?? '', userOf(flags));
      out(r.msg);
      if (r.ok) out('Next: ./forge tick  to create the worktree, implement, and run local CI automatically');
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'gatec-answer': {
      const r = await submitGateCAnswers(pos[0] ?? '', str(flags.user) ?? 'M', str(flags.notes));
      out(r.msg);
      if (r.ok) out('Next: ./forge tick  to carry on with this round');
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'review-pr': {
      // Once Gate C is green, trigger opening the PR plus Gate D's adversarial PR review: review-pr <slug> [--user M]
      const r = await requestReviewPr(pos[0] ?? '', userOf(flags));
      out(r.msg);
      if (r.ok) out('Next: ./forge tick  to delegate opening the PR (never merging it automatically), then codex reviews the diff and claude fixes');
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'gated-answer': {
      const r = await submitGateDAnswers(pos[0] ?? '', str(flags.user) ?? 'M', str(flags.notes));
      out(r.msg);
      if (r.ok) out("Next: ./forge tick  to run this round's revision");
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'merged': {
      // Acknowledge a human-merged PR -> SHIPPED (clear the worktree and hand off to the drift loop):
      // merged <slug> [--user M]
      const r = await ackMerged(pos[0] ?? '', userOf(flags), { force: !!flags.force });
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'retry': {
      const r = await retry(pos[0] ?? '', userOf(flags));
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      help();
      break;
    // An extension command only gets its turn once no core command matched — **on a name collision the core
    // always wins**.
    // That one-way precedence is deliberate: downstream cannot quietly replace a core action that carries
    // permissions and red lines, such as `go` or `merged`, by reusing its name.
    default: {
      const ext = extCommands().find((c) => c.name === cmd);
      if (ext) {
        await ext.run({ argv: rest, pos, flags });
        break;
      }
      log.err(`unknown command: ${cmd}`);
      help();
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  log.err(String(e?.stack ?? e));
  process.exitCode = 1;
});
