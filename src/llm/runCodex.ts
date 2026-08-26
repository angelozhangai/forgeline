import { run, commandExists } from '../util/proc.ts';
import { ROOT } from '../root.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { codexEnvelopeCollapsed, assertCodexEnvelope } from './contract.ts';
import { rehearsalOn, cannedText } from '../rehearsal.ts';

export interface CodexTokens {
  input: number;
  cachedInput: number;
  output: number;
}

export interface CodexResult {
  ok: boolean;
  result: string; // the assistant's final text (containing the fenced JSON block we want)
  threadId: string | null; // codex thread_id (used to resume)
  tokens: CodexTokens | null; // codex usage is measured in tokens with no dollar figure (stored separately, never mixed into the USD cost)
  raw: string;
  available: boolean;
  error?: string;
}

export interface CodexParsed {
  threadId: string | null;
  result: string | null; // the text of the last agent_message
  tokens: CodexTokens | null;
  isError: boolean;
  sawThreadStarted: boolean; // a thread.started event was seen (an envelope marker, used to detect contract drift)
  sawTurnCompleted: boolean; // a turn.completed event was seen (likewise)
}

// Parse the JSONL of `codex exec --json`: thread.started -> thread_id; the last agent_message -> the final
// answer; turn.completed.usage -> tokens; turn.failed/error -> mark it errored. A pure function, so unit
// tests can feed it canned JSONL.
// sawThreadStarted/sawTurnCompleted record whether those two envelope events were seen, which lets
// contract.ts decide whether a codex CLI upgrade changed the schema.
export function parseCodexJsonl(stdout: string): CodexParsed {
  const acc: CodexParsed = { threadId: null, result: null, tokens: null, isError: false, sawThreadStarted: false, sawTurnCompleted: false };
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // ignore non-JSON lines
    }
    const type = ev.type as string | undefined;
    if (type === 'thread.started') {
      acc.sawThreadStarted = true;
      acc.threadId = (ev.thread_id as string) ?? acc.threadId;
    } else if (type === 'item.completed') {
      const item = ev.item as { type?: string; text?: string } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') acc.result = item.text; // keep the last one
    } else if (type === 'turn.completed') {
      acc.sawTurnCompleted = true;
      const u = ev.usage as Record<string, number> | undefined;
      if (u) {
        acc.tokens = {
          input: u.input_tokens ?? 0,
          cachedInput: u.cached_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
        };
      }
    } else if (type === 'turn.failed' || type === 'error') {
      acc.isError = true;
    }
  }
  return acc;
}

export interface CodexOpts {
  threadId?: string; // when given, `codex exec resume <id>` continues an existing session (saving tokens, preserving memory)
  readOnly?: boolean; // applies to the first round only; defaults to true (a read-only review that does not modify the repo). resume does not accept -s (the sandbox is inherited).
  label?: string;
  cwd?: string; // the target project root (multi-project: the caller passes project(s.project_id).root)
}

// Non-interactive execution of the local codex CLI (the adversarial reviewer). `--json` is used to capture
// the thread_id so a later round can resume it.
// codex not installed -> available=false, and the caller degrades (claude self-review / skip / error).
// First round: `codex exec --json --skip-git-repo-check [-s read-only] -` (the prompt goes through stdin).
// Resume: `codex exec resume <threadId> --json --skip-git-repo-check -` (no -s — resume rejects that
// argument, and the sandbox is inherited from the first round).
export async function runCodex(prompt: string, opts: CodexOpts = {}): Promise<CodexResult> {
  // available:true matters as much as the canned text. Reporting the reviewer as unavailable would send the
  // gate down its degraded claude-self-review path, and the rehearsal would then be exercising the fallback
  // rather than the adversarial path a production run takes.
  if (rehearsalOn()) {
    try {
      return { ok: true, result: cannedText(opts.label), threadId: 'rehearsal', tokens: null, raw: '', available: true };
    } catch (e) {
      return { ok: false, result: '', threadId: null, tokens: null, raw: '', available: true, error: String(e instanceof Error ? e.message : e) };
    }
  }
  const cfg = loadConfig();
  if (!commandExists(cfg.runtime.codex_bin)) {
    return { ok: false, result: '', threadId: null, tokens: null, raw: '', available: false, error: 'the codex CLI is not installed' };
  }
  const tag = opts.label ? `${opts.label} ` : '';
  const args = opts.threadId
    ? ['exec', 'resume', opts.threadId, '--json', '--skip-git-repo-check', '-']
    : ['exec', '--json', '--skip-git-repo-check', ...(opts.readOnly === false ? [] : ['-s', 'read-only']), '-'];

  const onStdoutLine = (line: string): void => {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.type === 'item.completed') {
        const item = ev.item as { type?: string } | undefined;
        if (item?.type === 'command_execution') log.info(`  ${tag}→ codex is running commands to check the source of truth…`);
      }
    } catch {
      /* ignore non-JSON lines */
    }
  };

  const r = await run(cfg.runtime.codex_bin, args, {
    cwd: opts.cwd ?? ROOT, // the target project root (multi-project: the caller passes project(s.project_id).root)
    input: prompt,
    timeoutMs: cfg.runtime.claude_timeout_sec * 1000,
    onStdoutLine,
  });
  if (r.timedOut) {
    // "timed out" is the wording orchestrator/retry.ts classifies as transient — keep it.
    return { ok: false, result: '', threadId: null, tokens: null, raw: r.stdout, available: true, error: 'codex timed out' };
  }
  if (r.code !== 0) {
    return {
      ok: false,
      result: '',
      threadId: null,
      tokens: null,
      raw: r.stdout + r.stderr,
      available: true,
      error: `codex exited ${r.code}: ${(r.stderr || '').slice(0, 400)}`,
    };
  }
  const p = parseCodexJsonl(r.stdout);
  // Contract drift guard (the failure is never silent): exit 0 but not one known envelope event was seen ->
  // a codex CLI upgrade probably changed the event schema of exec --json. Never pass the whole blob of JSONL
  // downstream as "the result text" (that would be taken as "the model emitted no JSON", burning
  // parse-repair for nothing and ending up misdiagnosed as a business problem). Park it for a human to
  // check -> then edit the envelope definition in contract.ts (one place).
  if (codexEnvelopeCollapsed({ threadStarted: p.sawThreadStarted, turnCompleted: p.sawTurnCompleted })) {
    return {
      ok: false,
      result: '',
      threadId: p.threadId,
      tokens: p.tokens,
      raw: r.stdout,
      available: true,
      error: `CODEX_CONTRACT_DRIFT: ${assertCodexEnvelope({ threadStarted: p.sawThreadStarted, turnCompleted: p.sawTurnCompleted }).detail}`,
    };
  }
  if (p.result && p.tokens) {
    log.info(`  ${tag}✓ codex review complete (in ${p.tokens.input} / out ${p.tokens.output} tok)`);
  }
  // The envelope is intact. If an agent_message came back, use it (it holds the fenced JSON); if p.result is
  // null (the model emitted no agent_message), degrade by passing the whole stdout downstream as text for
  // parse-repair — a legitimate "no JSON" path, not contract drift.
  return {
    ok: !p.isError,
    result: p.result ?? r.stdout,
    threadId: p.threadId,
    tokens: p.tokens,
    raw: r.stdout,
    available: true,
    error: p.isError ? 'codex turn failed' : undefined,
  };
}
