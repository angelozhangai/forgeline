import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { sessionLogDir } from '../util/render.ts';
import { runCodex } from '../llm/runCodex.ts';
import { runClaude } from '../llm/runClaude.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { projectForSession } from '../projects.ts';
import type { ReviewFixDrivers } from './reviewFixLoop.ts';
import type { Session } from '../types.ts';

// Parameterisation of the real codex-reviews / claude-revises drivers: Gate A and Gate B differ only in these
// points (the label, the dump filename, the on_missing=skip log line, which cost column accrues, and which
// codex-token column is written).
// The column-specific database writes are injected as callbacks, which keeps that "column knowledge" in each
// gate's own module, avoids TypeScript friction with computed keys, and leaves the factory body entirely
// product-agnostic.
export interface ReviewFixDriverOpts {
  reviewLabel: string; // the codex review label ('Gate A · adversarial')
  reviewClaudeLabel: string; // the label for the degraded claude self-review ('Gate A · adversarial · claude')
  fixLabel: string; // the claude revision label ('Gate A · revise the review')
  reviewDumpName: string; // the filename the raw review output is dumped to ('gate-a-review.raw.txt')
  fixDumpName: string; // the filename the raw revision output is dumped to ('gate-a-fix.raw.txt')
  skipLog: string; // the log line for on_missing=skip ('… -> skipping the Gate A adversarial review')
  accrueFixCost: (costUsd: number) => void; // accrue the claude revision cost into this gate's cost column
  persistReviewerTokens?: (tokensJson: string) => void; // persist codex's token usage into its column (Gate B only; codex has no dollar figure)
}

// The real driver factory: the reviewer is codex (resuming by thread_id; on_missing degrades to a claude
// self-review, or skips, or errors) and the fixer is claude (with a pinned session for resumed revisions).
// With this extracted, gateALoop and gateBLoop no longer each carry their own near-identical 50 lines of
// driver code.
export function makeReviewFixDrivers(s: Session, o: ReviewFixDriverOpts): ReviewFixDrivers {
  const proj = projectForSession(s); // the target project root: both codex and claude use it as cwd (to read the source of truth in the code, and the PRD)
  const dumpRaw = (name: string, raw: string): void => {
    try {
      writeFileSync(resolve(sessionLogDir(s.id), name), raw); // the raw output a human checks when something fails or does not parse
    } catch {
      /* a failed dump must not block the flow */
    }
  };
  return {
    review: async (prompt, opts) => {
      const cfg = loadConfig();
      if (cfg.runtime.adversarial.reviewer === 'codex') {
        const c = await runCodex(prompt, opts.sessionId ? { threadId: opts.sessionId, label: o.reviewLabel, cwd: proj.root } : { label: o.reviewLabel, readOnly: true, cwd: proj.root });
        dumpRaw(o.reviewDumpName, c.raw ?? '');
        if (c.ok) {
          if (o.persistReviewerTokens && c.tokens) o.persistReviewerTokens(JSON.stringify(c.tokens));
          return { ok: true, text: c.result, sessionId: c.threadId, available: true, used: 'codex' };
        }
        if (!c.available) {
          if (cfg.runtime.adversarial.on_missing === 'skip') {
            log.warn(o.skipLog);
            return { ok: false, text: '', sessionId: null, available: false, used: 'codex' };
          }
          if (cfg.runtime.adversarial.on_missing === 'error') throw new Error('codex is unavailable and on_missing=error');
          log.warn('codex is not installed; degrading to a claude self-review (weaker independence — install codex and it switches back automatically)');
        } else {
          log.warn(`The codex review failed (${c.error}); degrading to claude`);
        }
      }
      // The degraded claude self-review (no session continuation, so every round resends — weaker
      // independence, used only as a fallback when codex is missing). A failure is **no longer treated as
      // approved**: available=true with ok=false propagates up and parks.
      // [Why it does not resume to save tokens] The engine has a single reviewer-session slot, and the codex
      // path uses it as a codex thread_id. If the claude fallback also pinned and resumed its own session in
      // that slot, the next round's codex path would misuse a claude session as a thread_id — especially
      // likely when codex fails intermittently and control returns here. Safe continuation would need either a
      // second claude-reviewer slot or a persisted "reviewer mode", and for a degraded path whose README
      // already says "install codex and it switches back automatically", that token saving is not worth adding
      // state to the core engine. So it resends every round.
      const r = await runClaude(prompt, { label: o.reviewClaudeLabel, cwd: proj.root });
      dumpRaw(o.reviewDumpName, r.raw ?? '');
      if (!r.ok) {
        log.warn(`The claude review failed (${r.error}) -> propagating up to park; never let it through silently`);
        return { ok: false, text: '', sessionId: null, available: true, used: 'claude', error: r.error };
      }
      return { ok: true, text: r.result, sessionId: null, available: true, used: 'claude' };
    },
    fix: async (prompt, opts) => {
      let sid = opts.sessionId;
      let res: Awaited<ReturnType<typeof runClaude>>;
      if (sid) {
        res = await runClaude(prompt, { label: o.fixLabel, resume: sid, cwd: proj.root });
      } else {
        sid = randomUUID(); // pin a new session so later revisions can resume it
        res = await runClaude(prompt, { label: o.fixLabel, sessionId: sid, cwd: proj.root });
      }
      dumpRaw(o.fixDumpName, res.raw ?? '');
      if (res.ok && res.costUsd != null) o.accrueFixCost(res.costUsd); // accrue rather than overwrite the first-draft and review costs
      return { ok: res.ok, text: res.result, sessionId: res.ok ? sid : null, costUsd: res.costUsd, error: res.error };
    },
  };
}
