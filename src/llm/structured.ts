// The one "structured LLM output" kernel: extraction + zod validation + **self-healing on a parse failure**
// (resume the same session and feed it back to the model to re-emit).
// Every parse point (Gate A / Gate B / the adversarial verdict / a revision's FixResult) shares it, which
// avoids building a second one and avoids contract drift.

import { z } from 'zod';
import { extractJsonBlock } from '../util/json.ts';

// A zod error -> one line a human or a model can read (pasted into the repair instruction when fed back).
export function formatZodError(e: unknown): string {
  if (e instanceof z.ZodError) {
    return e.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ');
  }
  return e instanceof Error ? e.message : String(e);
}

// Extract and validate, throwing a **readable** Error on failure (reused by the parse closures).
// It returns z.infer<S>, the schema's **output** type (after default/preprocess have been applied), rather
// than inferring the optional input type.
export function strictParse<S extends z.ZodTypeAny>(schema: S, text: string): z.infer<S> {
  const raw = extractJsonBlock(text); // not found / bad JSON -> throws
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error(`Output does not match the contract: ${formatZodError(r.error)}`);
  return r.data;
}

export interface ParseStructuredOpts<T> {
  text: string; // the LLM's original output
  parse: (text: string) => T; // throwing = not acceptable (use strictParse or a config hook)
  reEmit: (instruction: string) => Promise<string | null>; // resume the same session and feed it back, returning the new output; null = the feedback call itself failed (transient, or no session)
  buildRepairInstruction: (error: string) => string; // build the repair instruction from the error (including a contract reminder)
  maxRetries: number; // the maximum number of self-healing retries (0 = no self-healing, equivalent to the old behaviour)
  reEmitCallRetries?: number; // inner retries when the feedback call itself fails transiently (null); defaults to 2, retried after a backoff, and does not consume maxRetries
  backoffMs?: (call: number) => number; // the backoff after a failed feedback call (defaults to exponential + jitter); tests can inject () => 0
  sleep?: (ms: number) => Promise<void>; // the backoff implementation (defaults to setTimeout); tests can inject one that does not really sleep
  note?: (kind: string, detail: unknown) => void; // audit event
  dump?: (raw: string) => void; // persist the fed-back output for troubleshooting
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The backoff after a transiently failed feedback call: 1s/3s/8s, exponential and capped, plus ±20% jitter
// (so several sessions do not hit the rate limit wall in lockstep).
const REPAIR_BACKOFF_MS = [1000, 3000, 8000];
function repairBackoff(call: number): number {
  const base = REPAIR_BACKOFF_MS[Math.min(Math.max(call, 0), REPAIR_BACKOFF_MS.length - 1)];
  return Math.round(base + base * 0.2 * (Math.random() * 2 - 1));
}

// Parse -> on failure feed back for a re-emit -> parse again, at most maxRetries times. Once exhausted it
// throws the last error (behaving exactly as parking does today).
// P1-1: a transient failure of the **feedback call itself** (null) no longer ends the self-healing at the
// first blip; it backs off and retries a bounded number of times (reEmitCallRetries), and only throws to
// park if it still gets nothing. P1-2: those inner retries carry backoff and jitter, so back-to-back
// resends do not smash through the rate limit.
export async function parseStructured<T>(opts: ParseStructuredOpts<T>): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const backoff = opts.backoffMs ?? repairBackoff;
  const callRetries = opts.reEmitCallRetries ?? 2;
  let text = opts.text;
  for (let attempt = 0; ; attempt++) {
    try {
      return opts.parse(text);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      if (attempt >= opts.maxRetries) {
        opts.note?.('parse_repair_exhausted', { attempts: attempt, error: msg });
        throw e;
      }
      opts.note?.('parse_repair_attempt', { attempt: attempt + 1, error: msg });
      const instruction = opts.buildRepairInstruction(msg);
      // Feed back for a re-emit: the first attempt is sent immediately (bad JSON is usually a model slip and
      // resending fixes it); a failed call (null) backs off and retries inside, without ending the
      // self-healing.
      let next: string | null = null;
      for (let call = 0; call <= callRetries; call++) {
        if (call > 0) await sleep(backoff(call - 1));
        next = await opts.reEmit(instruction);
        if (next != null) break;
        opts.note?.('parse_repair_reemit_failed', { attempt: attempt + 1, call: call + 1 });
      }
      if (next == null) {
        // The feedback failed repeatedly (probably no session, or an ongoing fault) -> stop pushing and
        // throw to park.
        opts.note?.('parse_repair_no_reemit', { attempt: attempt + 1 });
        throw e;
      }
      opts.dump?.(next);
      text = next;
    }
  }
}
