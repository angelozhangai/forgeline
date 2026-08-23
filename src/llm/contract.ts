// The single source of truth for the external CLIs' **envelope contract**: which **framing fields and
// events** in claude's and codex's --json / stream-json output our parsing depends on (the envelope is what
// the CLI itself controls, as distinct from the content the model emits).
// Both the Layer-1 runtime fallback (runCodex/runClaude) and the Layer-2/3 active probes (probes.ts)
// reference this — so if a CLI upgrade legitimately renames a field, only this one place changes.
//
// Detection precision:
//  · The runtime hot path (Layer 1) parks only when the **envelope has collapsed entirely** (not one known
//    event was seen), so it does not misjudge legitimate cases such as "the model emitted no JSON" (those
//    still go through parse-repair downstream).
//  · The active probes (Layer 2/3) use the **strict** rule: any missing required envelope field is drift,
//    and it alerts.

export interface EnvelopeDrift {
  drifted: boolean;
  missing: string[]; // envelope events or fields we depend on that were not seen this time
  detail: string; // one plain-language line for the alert or the parked session's error text
}

// -- CODEX: the JSONL events of `codex exec --json` -------------------------
// parseCodexJsonl depends on thread.started (thread_id, used to resume) and turn.completed (usage, token
// accounting).
export const CODEX_ENVELOPE = {
  // Used by the probe: a trivial prompt through stdin in a read-only sandbox, the cheapest way to force a
  // complete round of envelope events.
  probeArgs: ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-'] as const,
  requiredEvents: ['thread.started', 'turn.completed'] as const,
};

export interface CodexEnvelopeSeen {
  threadStarted: boolean;
  turnCompleted: boolean;
}

function codexMissing(seen: CodexEnvelopeSeen): string[] {
  const missing: string[] = [];
  if (!seen.threadStarted) missing.push('thread.started');
  if (!seen.turnCompleted) missing.push('turn.completed');
  return missing;
}

// Layer 1 (the hot path): only a **fully collapsed envelope** — not one known event seen — counts as drift
// and parks.
// If any known event was seen, the framing is still a version we recognise, so even a null p.result is
// treated as "the model emitted no JSON" and goes through parse-repair.
export function codexEnvelopeCollapsed(seen: CodexEnvelopeSeen): boolean {
  return codexMissing(seen).length === CODEX_ENVELOPE.requiredEvents.length;
}

// Layer 2/3 (the probes, strict): any missing required event is drift.
export function assertCodexEnvelope(seen: CodexEnvelopeSeen): EnvelopeDrift {
  const missing = codexMissing(seen);
  return {
    drifted: missing.length > 0,
    missing,
    detail: missing.length
      ? `codex output is missing envelope events: ${missing.join(', ')} (a codex CLI upgrade may have changed the exec --json event schema)`
      : 'codex envelope intact',
  };
}

// -- CLAUDE: the events of `claude -p --output-format stream-json` ----------
// runClaude depends on the type:'result' event (the result text + session_id + total_cost_usd + is_error).
export const CLAUDE_ENVELOPE = {
  probeArgs: ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'] as const,
  requiredEvents: ['result'] as const,
};

export interface ClaudeEnvelopeSeen {
  resultEvent: boolean; // whether a type:'result' event was seen (or a result-shaped object was found by scanning back)
}

// Layer 1 uses the same rule as the probe: no result envelope at all -> drift (claude emits a result event
// on every turn).
export function assertClaudeEnvelope(seen: ClaudeEnvelopeSeen): EnvelopeDrift {
  const missing = seen.resultEvent ? [] : ['the result event'];
  return {
    drifted: missing.length > 0,
    missing,
    detail: missing.length
      ? `claude output is missing part of the envelope: ${missing.join(', ')} (a claude CLI upgrade may have changed the stream-json schema)`
      : 'claude envelope intact',
  };
}
