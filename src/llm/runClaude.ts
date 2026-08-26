import { run } from '../util/proc.ts';
import { ROOT, SVC_DIR } from '../root.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { assertClaudeEnvelope } from './contract.ts';
import { rehearsalOn, cannedText } from '../rehearsal.ts';

// A lightweight bare call: no CLAUDE.md or skills from the main repo, no tools, no MCP. Used for small
// utility work such as producing a slug — cheap and fast.
export async function runClaudeBare(prompt: string): Promise<string | null> {
  // The rehearsal short-circuits **before** the config is read and before anything is spawned: no token is
  // spent, and no claude_bin has to exist on the machine running the rehearsal.
  if (rehearsalOn()) return cannedText(undefined);
  const cfg = loadConfig();
  const r = await run(
    cfg.runtime.claude_bin,
    ['-p', '--output-format', 'json', '--strict-mcp-config'],
    { cwd: SVC_DIR, input: prompt, timeoutMs: 60000 },
  );
  if (r.code !== 0) return null;
  try {
    return (JSON.parse(r.stdout) as { result?: string }).result?.trim() ?? null;
  } catch {
    return r.stdout.trim() || null;
  }
}

export interface ClaudeResult {
  ok: boolean;
  result: string; // the assistant's text (containing the JSON block we want)
  sessionId: string | null;
  costUsd: number | null;
  raw: string;
  error?: string;
}

// Compress one tool_use into a line of human-readable progress ("which file is it reading / what is it
// grepping for").
function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (!input) return name;
  switch (name) {
    case 'Read':
      return `Read ${s(input.file_path)}`;
    case 'Grep':
      return `Grep "${s(input.pattern)}"${input.path ? ` in ${s(input.path)}` : ''}`;
    case 'Glob':
      return `Glob ${s(input.pattern)}`;
    case 'Bash':
      return `Bash ${s(input.command).slice(0, 70)}`;
    default:
      return name;
  }
}

// The rehearsal's stand-in for one runClaude call. A label the canned table does not answer throws, and the
// throw is turned into an ordinary failed ClaudeResult rather than propagated: that is what parks the gate in
// its *_FAILED state with the reason recorded, exactly as a real CLI failure would — instead of taking down
// the whole tick with an exception the state machine never sees.
function rehearsalResult(label: string | undefined): ClaudeResult {
  try {
    return { ok: true, result: cannedText(label), sessionId: 'rehearsal', costUsd: 0, raw: '' };
  } catch (e) {
    return { ok: false, result: '', sessionId: null, costUsd: 0, raw: '', error: String(e instanceof Error ? e.message : e) };
  }
}

// Run the local claude -p with cwd=$ROOT (loading CLAUDE.md and skills); the prompt goes through stdin
// (avoiding argv size limits).
// stream-json is used to report progress live (otherwise a headless run echoes nothing at all and looks
// hung).
// opts.sessionId: pin the session id with --session-id (the first round, so it can be resumed later);
// opts.resume: continue an existing session with --resume (Gate A's multi-round re-reviews, saving tokens —
// the previous round's PRD and code context is already in the session).
export async function runClaude(
  prompt: string,
  opts: { label?: string; sessionId?: string; resume?: string; timeoutSec?: number; cwd?: string } = {},
): Promise<ClaudeResult> {
  if (rehearsalOn()) return rehearsalResult(opts.label);
  const cfg = loadConfig();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (cfg.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = cfg.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  const tag = opts.label ? `${opts.label} ` : '';
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose', // stream-json with -p requires --verbose
    '--strict-mcp-config', // no --mcp-config -> nothing MCP is loaded (Gate A/B only need Read/Grep/Glob/Bash, saving tokens and startup time)
    '--allowedTools',
    cfg.runtime.claude_allowed_tools,
  ];
  // resume and session-id are mutually exclusive: continuing an existing session uses resume, a new session
  // uses the self-pinned session-id.
  if (opts.resume) args.push('--resume', opts.resume);
  else if (opts.sessionId) args.push('--session-id', opts.sessionId);

  // The final result extracted from the stream (the result event). Accumulated in an object to sidestep
  // TypeScript's "assignment inside a closure does not narrow" trap.
  const acc: {
    finalResult: string | null;
    sessionId: string | null;
    costUsd: number | null;
    isError: boolean;
    tools: number;
  } = { finalResult: null, sessionId: null, costUsd: null, isError: false, tools: 0 };

  const onStdoutLine = (line: string): void => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON lines
    }
    const type = ev.type as string | undefined;
    if (type === 'assistant') {
      const msg = ev.message as { content?: unknown[] } | undefined;
      for (const block of msg?.content ?? []) {
        const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
        if (b.type === 'tool_use') {
          acc.tools++;
          log.info(`  ${tag}→ ${summarizeTool(b.name ?? '?', b.input)}`);
        }
      }
    } else if (type === 'result') {
      acc.finalResult = (ev.result as string) ?? '';
      acc.sessionId = (ev.session_id as string) ?? null;
      acc.costUsd = (ev.total_cost_usd as number) ?? null;
      acc.isError = ev.is_error === true || (ev.subtype as string) === 'error';
    }
  };

  const r = await run(cfg.runtime.claude_bin, args, {
    cwd: opts.cwd ?? ROOT, // the target project root (multi-project: the caller passes project(s.project_id).root)
    env,
    input: prompt,
    // Tiered timeout: light calls such as a parse-repair re-emit can pass a shorter timeoutSec, so a hung
    // call cannot hold the tick lock (the default uses the global value).
    timeoutMs: (opts.timeoutSec ?? cfg.runtime.claude_timeout_sec) * 1000,
    onStdoutLine,
  });

  if (r.timedOut) {
    // The wording "timed out" matters: it is what lets orchestrator/retry.ts classify this as transient and
    // retry it rather than parking the session permanently.
    return { ok: false, result: '', sessionId: null, costUsd: null, raw: r.stdout, error: 'claude timed out' };
  }
  if (r.code !== 0) {
    // The claude CLI stuffs API-layer errors (a dropped socket, rate limiting, overloaded and so on) into
    // stream-json's result(is_error:true) while exiting 1 with an often-empty stderr. Reporting only "exit
    // code 1" would throw away the network evidence, and classifyError would then wrongly call it permanent
    // and not retry.
    // So stderr is preferred, and otherwise the captured result text is folded into the error so the
    // classifier can see the real cause.
    const detail = (r.stderr || '').trim() || (acc.finalResult || '').trim();
    return {
      ok: false,
      result: '',
      sessionId: null,
      costUsd: null,
      raw: r.stdout + r.stderr,
      error: `claude exited ${r.code}: ${detail.slice(0, 600)}`,
    };
  }

  if (acc.finalResult !== null) {
    if (acc.tools)
      log.info(
        `  ${tag}✓ analysis complete (${acc.tools} tool calls${acc.costUsd != null ? `, $${acc.costUsd.toFixed(4)}` : ''})`,
      );
    return {
      ok: !acc.isError,
      result: acc.finalResult,
      sessionId: acc.sessionId,
      costUsd: acc.costUsd,
      raw: r.stdout,
      error: acc.isError ? 'claude returned is_error' : undefined,
    };
  }

  // No result event arrived: degrade by scanning the lines for an object carrying a result field (covering
  // the case where the stream-json framing changed but the object is still there).
  for (const line of r.stdout.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { result?: string; session_id?: string; total_cost_usd?: number };
      if (typeof j.result === 'string') {
        return { ok: true, result: j.result, sessionId: j.session_id ?? null, costUsd: j.total_cost_usd ?? null, raw: r.stdout };
      }
    } catch {
      /* continue */
    }
  }
  // Neither a result event nor a result-shaped object found by scanning backwards -> contract drift (a
  // claude CLI upgrade probably changed the stream-json schema).
  // The failure is never silent: never quietly accept the whole stdout as "the analysis result" (the old
  // ok:true behaviour). Park it for a human to check -> then edit contract.ts.
  return {
    ok: false,
    result: '',
    sessionId: acc.sessionId,
    costUsd: acc.costUsd,
    raw: r.stdout,
    error: `CLAUDE_CONTRACT_DRIFT: ${assertClaudeEnvelope({ resultEvent: false }).detail}`,
  };
}
