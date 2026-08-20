import { run } from '../util/proc.ts';
import { ROOT, SVC_DIR } from '../root.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { assertClaudeEnvelope } from './contract.ts';

// 轻量裸调：不载主仓 CLAUDE.md/skills、无工具、零 MCP。用于起 slug 这类小工具活，便宜快。
export async function runClaudeBare(prompt: string): Promise<string | null> {
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
  result: string; // 助手文本（含我们要的 JSON 块）
  sessionId: string | null;
  costUsd: number | null;
  raw: string;
  error?: string;
}

// 把一次 tool_use 压成一行人能看懂的进度（"在读哪个文件/grep 什么"）。
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

// 以 cwd=$ROOT 跑本机 claude -p（加载 CLAUDE.md + skills）；prompt 走 stdin（避免 argv 体积限制）。
// 用 stream-json 实时上报进度（否则 headless 全程无回显，像卡死）。
// opts.sessionId：用 --session-id 钉死会话号（首轮，便于后续 resume）；
// opts.resume：用 --resume 续接既有会话（闸A 多轮复评，省 token——上轮 PRD/代码上下文已在会话里）。
export async function runClaude(
  prompt: string,
  opts: { label?: string; sessionId?: string; resume?: string; timeoutSec?: number; cwd?: string } = {},
): Promise<ClaudeResult> {
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
    '--verbose', // stream-json + -p 要求 --verbose
    '--strict-mcp-config', // 不带 --mcp-config → 零 MCP 加载（闸A/B 只需 Read/Grep/Glob/Bash，省 token+启动）
    '--allowedTools',
    cfg.runtime.claude_allowed_tools,
  ];
  // resume 与 session-id 互斥：续接既有会话用 resume；新会话用自钉的 session-id。
  if (opts.resume) args.push('--resume', opts.resume);
  else if (opts.sessionId) args.push('--session-id', opts.sessionId);

  // 从流里提取的最终结果（result 事件）。用对象累加，规避 TS「闭包内赋值不窄化」坑。
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
      return; // 非 JSON 行忽略
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
    cwd: opts.cwd ?? ROOT, // 目标项目根（多项目：调用方传 project(s.project_id).root）
    env,
    input: prompt,
    // 分级超时：解析自愈这类「重出 JSON」的轻调用可传更短 timeoutSec，避免挂死调用霸占 tick 锁（默认走全局）。
    timeoutMs: (opts.timeoutSec ?? cfg.runtime.claude_timeout_sec) * 1000,
    onStdoutLine,
  });

  if (r.timedOut) {
    return { ok: false, result: '', sessionId: null, costUsd: null, raw: r.stdout, error: 'claude 超时' };
  }
  if (r.code !== 0) {
    // claude CLI 把 API 层错误（socket 断开/限流/overloaded 等）塞进 stream-json 的 result(is_error:true)，
    // 退码却是 1、stderr 常为空。只回「退出码 1」会丢掉网络线索 → classifyError 误判 permanent 不重试。
    // 故优先用 stderr，否则把已捕获的 result 文本并进 error，让分类器看得见真实原因。
    const detail = (r.stderr || '').trim() || (acc.finalResult || '').trim();
    return {
      ok: false,
      result: '',
      sessionId: null,
      costUsd: null,
      raw: r.stdout + r.stderr,
      error: `claude 退出码 ${r.code}: ${detail.slice(0, 600)}`,
    };
  }

  if (acc.finalResult !== null) {
    if (acc.tools)
      log.info(
        `  ${tag}✓ 分析完成（${acc.tools} 次工具调用${acc.costUsd != null ? `，$${acc.costUsd.toFixed(4)}` : ''}）`,
      );
    return {
      ok: !acc.isError,
      result: acc.finalResult,
      sessionId: acc.sessionId,
      costUsd: acc.costUsd,
      raw: r.stdout,
      error: acc.isError ? 'claude 返回 is_error' : undefined,
    };
  }

  // 没拿到 result 事件：降级——尝试逐行找含 result 字段的对象（stream-json 框架变了但对象还在的情况）。
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
  // 既无 result 事件、也反扫不到 result 形状对象 → 契约漂移（claude CLI 升级疑似改了 stream-json schema）。
  // 失败不静默：绝不把整段 stdout 当「分析结果」静默放过（旧行为 ok:true），停泊待人核对 → 改 contract.ts。
  return {
    ok: false,
    result: '',
    sessionId: acc.sessionId,
    costUsd: acc.costUsd,
    raw: r.stdout,
    error: `CLAUDE_CONTRACT_DRIFT: ${assertClaudeEnvelope({ resultEvent: false }).detail}`,
  };
}
