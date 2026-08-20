// 外部 CLI「信封契约」单一真源：claude/codex 的 --json/stream-json 输出里，
// 哪些**框架字段/事件**是我们解析所依赖的（信封=CLI 自己控制，区别于模型吐的内容）。
// Layer-1 运行时兜底（runCodex/runClaude）与 Layer-2/3 主动探针（probes.ts）都引这里——
// CLI 升级若合法改了字段名，只改这一处。
//
// 判别精度：
//  · 运行时热路径（Layer 1）只在**信封整体坍塌**（一个已知事件都没见到）时停泊，
//    避免对「模型没吐 JSON」这类合法情况误判（那个仍走下游 parse-repair）。
//  · 主动探针（Layer 2/3）用**严格**口径：任一必需信封字段缺失即判漂移，主动告警。

export interface EnvelopeDrift {
  drifted: boolean;
  missing: string[]; // 我们依赖、但本次没见到的信封事件/字段
  detail: string; // 给告警/停泊原文的人话一行
}

// ── CODEX：`codex exec --json` 的 JSONL 事件 ──────────────────────────
// parseCodexJsonl 依赖 thread.started（thread_id，resume 续接）与 turn.completed（usage，token 计量）。
export const CODEX_ENVELOPE = {
  // 探针用：trivial prompt 走 stdin，只读沙箱，最便宜地逼出完整一轮信封。
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

// Layer 1（热路径）：仅「信封整体坍塌」= 一个已知事件都没见到 → 判漂移并停泊。
// 见到任一已知事件 → 框架还是我们认识的版本，p.result 即便为 null 也当「模型没吐 JSON」走 parse-repair。
export function codexEnvelopeCollapsed(seen: CodexEnvelopeSeen): boolean {
  return codexMissing(seen).length === CODEX_ENVELOPE.requiredEvents.length;
}

// Layer 2/3（探针，严格）：任一必需事件缺失即判漂移。
export function assertCodexEnvelope(seen: CodexEnvelopeSeen): EnvelopeDrift {
  const missing = codexMissing(seen);
  return {
    drifted: missing.length > 0,
    missing,
    detail: missing.length
      ? `codex 输出缺信封事件：${missing.join('、')}（疑似 codex CLI 升级改了 exec --json 事件 schema）`
      : 'codex 信封完好',
  };
}

// ── CLAUDE：`claude -p --output-format stream-json` 的事件 ─────────────
// runClaude 依赖 type:'result' 事件（result 文本 + session_id + total_cost_usd + is_error）。
export const CLAUDE_ENVELOPE = {
  probeArgs: ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'] as const,
  requiredEvents: ['result'] as const,
};

export interface ClaudeEnvelopeSeen {
  resultEvent: boolean; // 是否见到 type:'result' 事件（或反扫到 result 形状的对象）
}

// Layer 1 与探针同口径：没有任何 result 信封 → 漂移（claude 的 result 事件在每轮必出）。
export function assertClaudeEnvelope(seen: ClaudeEnvelopeSeen): EnvelopeDrift {
  const missing = seen.resultEvent ? [] : ['result 事件'];
  return {
    drifted: missing.length > 0,
    missing,
    detail: missing.length
      ? `claude 输出缺信封：${missing.join('、')}（疑似 claude CLI 升级改了 stream-json schema）`
      : 'claude 信封完好',
  };
}
