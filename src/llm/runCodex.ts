import { run, commandExists } from '../util/proc.ts';
import { ROOT } from '../root.ts';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import { codexEnvelopeCollapsed, assertCodexEnvelope } from './contract.ts';

export interface CodexTokens {
  input: number;
  cachedInput: number;
  output: number;
}

export interface CodexResult {
  ok: boolean;
  result: string; // 助手最终文本（含我们要的 fenced JSON 块）
  threadId: string | null; // codex thread_id（resume 续接用）
  tokens: CodexTokens | null; // codex 用量是 token，无美元口径（另存，不混入 USD 成本）
  raw: string;
  available: boolean;
  error?: string;
}

export interface CodexParsed {
  threadId: string | null;
  result: string | null; // 最后一条 agent_message 文本
  tokens: CodexTokens | null;
  isError: boolean;
  sawThreadStarted: boolean; // 见过 thread.started 事件（信封标记，契约漂移判别用）
  sawTurnCompleted: boolean; // 见过 turn.completed 事件（同上）
}

// 解析 `codex exec --json` 的 JSONL：thread.started→thread_id；最后一条 agent_message→最终答复；
// turn.completed.usage→token；turn.failed/error→标错。纯函数，便于单测喂 canned JSONL。
// sawThreadStarted/sawTurnCompleted：记是否见过这两个信封事件——供 contract.ts 判 codex CLI 升级是否改了 schema。
export function parseCodexJsonl(stdout: string): CodexParsed {
  const acc: CodexParsed = { threadId: null, result: null, tokens: null, isError: false, sawThreadStarted: false, sawTurnCompleted: false };
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // 非 JSON 行忽略
    }
    const type = ev.type as string | undefined;
    if (type === 'thread.started') {
      acc.sawThreadStarted = true;
      acc.threadId = (ev.thread_id as string) ?? acc.threadId;
    } else if (type === 'item.completed') {
      const item = ev.item as { type?: string; text?: string } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') acc.result = item.text; // 保留最后一条
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
  threadId?: string; // 给定则 `codex exec resume <id>` 续接既有会话（省 token，记忆保留）
  readOnly?: boolean; // 仅首轮生效；默认 true（只读评审，不改仓库）。resume 不接受 -s（沙箱继承）。
  label?: string;
  cwd?: string; // 目标项目根（多项目：调用方传 project(s.project_id).root）
}

// 本机 codex CLI 非交互执行（对抗复审 reviewer）。用 `--json` 捕获 thread_id 以便后续 resume 续接。
// codex 未安装 → available=false，由调用方降级（claude 自审 / skip / error）。
// 首轮：`codex exec --json --skip-git-repo-check [-s read-only] -`（prompt 走 stdin）。
// 续接：`codex exec resume <threadId> --json --skip-git-repo-check -`（不传 -s——resume 拒绝该参数，沙箱继承首轮）。
export async function runCodex(prompt: string, opts: CodexOpts = {}): Promise<CodexResult> {
  const cfg = loadConfig();
  if (!commandExists(cfg.runtime.codex_bin)) {
    return { ok: false, result: '', threadId: null, tokens: null, raw: '', available: false, error: 'codex CLI 未安装' };
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
        if (item?.type === 'command_execution') log.info(`  ${tag}→ codex 跑命令核对代码真源…`);
      }
    } catch {
      /* 非 JSON 行忽略 */
    }
  };

  const r = await run(cfg.runtime.codex_bin, args, {
    cwd: opts.cwd ?? ROOT, // 目标项目根（多项目：调用方传 project(s.project_id).root）
    input: prompt,
    timeoutMs: cfg.runtime.claude_timeout_sec * 1000,
    onStdoutLine,
  });
  if (r.timedOut) {
    return { ok: false, result: '', threadId: null, tokens: null, raw: r.stdout, available: true, error: 'codex 超时' };
  }
  if (r.code !== 0) {
    return {
      ok: false,
      result: '',
      threadId: null,
      tokens: null,
      raw: r.stdout + r.stderr,
      available: true,
      error: `codex 退出码 ${r.code}: ${(r.stderr || '').slice(0, 400)}`,
    };
  }
  const p = parseCodexJsonl(r.stdout);
  // 契约漂移守卫（失败不静默）：退出 0 但一个已知信封事件都没见到 → codex CLI 升级疑似改了
  // exec --json 的事件 schema。绝不把整坨 JSONL 当「结果文本」静默传下去（那会被当成「模型没吐 JSON」
  // 白烧 parse-repair，最后还误判成业务问题）。停泊待人核对 → 改 contract.ts 信封定义（单点）。
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
    log.info(`  ${tag}✓ codex 复审完成（in ${p.tokens.input}/out ${p.tokens.output} tok）`);
  }
  // 信封完好。拿到 agent_message → 用它（含 fenced JSON）；p.result 为 null（模型没吐 agent_message）
  // → 降级把整段 stdout 当文本走下游 parse-repair（合法「无 JSON」路径，非契约漂移）。
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
