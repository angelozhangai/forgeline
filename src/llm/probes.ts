// Layer 2/3 — 主动契约探针：对真二进制/真 API 跑一发最便宜的只读往返，断言我们解析所依赖的
// 信封字段还在。被 test/contract.test.ts（缺则 skip）与 health/contract.ts（每日定时）共用。
// 判别：available=能跑（装了/配齐）；ok=信封完好。非零退出/网络错 = available 但 ok:false（可能是鉴权，
// 不一定漂移），detail 区分；信封缺失 = 真漂移。
import { run, commandExists } from '../util/proc.ts';
import { minutes } from '../util/time.ts';
import { ROOT } from '../root.ts';
import { loadConfig } from '../config.ts';
import { parseCodexJsonl } from './runCodex.ts';
import { runClaude } from './runClaude.ts';
import { CODEX_ENVELOPE, assertCodexEnvelope } from './contract.ts';
import { port } from '../messaging/index.ts';

export type ProbeDep = 'codex' | 'claude' | 'gh' | 'feishu';

export interface ProbeResult {
  dep: ProbeDep;
  available: boolean; // 二进制装了 / API 配齐 → 能探
  ok: boolean; // 信封完好（available 且未漂移）
  detail: string; // 人话一行（给告警 / 状态页 / 停泊原文）
  raw?: string; // 截断的原始载荷，供告警附上
  at: number;
  // !ok 时的归因，决定告警给哪种「处置」：auth=登录/鉴权疑似失效（重新登录、清停泊）；
  // drift=输出信封漂移（改 src/llm/contract.ts）。缺省/ok 时按 drift 文案（保守，沿用旧行为）。
  kind?: 'auth' | 'drift';
}

// 最便宜的一轮：逼出完整信封又不让模型乱跑工具。
const TRIVIAL = 'Reply with the single word OK. Do not use any tools.';
const PROBE_TIMEOUT_MS = minutes(1); // 探针用短超时，绝不用 gate 的 1200s——挂死的探针不该堵任何东西
// 默认项目 org 兜底。探针只验「默认项目可达」（非按 session 项目），故就地从注册表取默认项目 owner，
// 不 import projects.ts 的 project()——那会让一众 mock projects.ts（缺 project 导出）的测试在导入期炸（同 writes.ts 教训）。
const DEFAULT_OWNER = 'your-org';

export async function probeCodex(now: number): Promise<ProbeResult> {
  const cfg = loadConfig();
  if (!commandExists(cfg.runtime.codex_bin)) {
    return { dep: 'codex', available: false, ok: false, detail: 'codex 未安装（跳过）', at: now };
  }
  const r = await run(cfg.runtime.codex_bin, [...CODEX_ENVELOPE.probeArgs], { cwd: ROOT, input: TRIVIAL, timeoutMs: PROBE_TIMEOUT_MS });
  if (r.timedOut) return { dep: 'codex', available: true, ok: false, detail: 'codex 探针超时', raw: r.stdout.slice(0, 1200), at: now };
  if (r.code !== 0) return { dep: 'codex', available: true, ok: false, kind: 'auth', detail: `codex 非零退出（${r.code}，可能鉴权/环境，非必然漂移）`, raw: (r.stdout + r.stderr).slice(0, 1200), at: now };
  const p = parseCodexJsonl(r.stdout);
  const drift = assertCodexEnvelope({ threadStarted: p.sawThreadStarted, turnCompleted: p.sawTurnCompleted });
  return { dep: 'codex', available: true, ok: !drift.drifted, kind: drift.drifted ? 'drift' : undefined, detail: drift.detail, raw: drift.drifted ? r.stdout.slice(0, 1200) : undefined, at: now };
}

export async function probeClaude(now: number): Promise<ProbeResult> {
  const cfg = loadConfig();
  if (!commandExists(cfg.runtime.claude_bin)) {
    return { dep: 'claude', available: false, ok: false, detail: 'claude 未安装（跳过）', at: now };
  }
  // 复用生产代码路径：runClaude 已含 Layer-1 信封断言，漂移即 error 带 CLAUDE_CONTRACT_DRIFT。
  const res = await runClaude(TRIVIAL, { label: 'probe', timeoutSec: PROBE_TIMEOUT_MS / 1000 });
  if (res.ok) return { dep: 'claude', available: true, ok: true, detail: 'claude 信封完好', at: now };
  const drift = (res.error ?? '').startsWith('CLAUDE_CONTRACT_DRIFT');
  return { dep: 'claude', available: true, ok: false, kind: drift ? 'drift' : 'auth', detail: drift ? res.error! : `claude 探针失败（${(res.error ?? '').slice(0, 120)}，可能鉴权/超时，非必然漂移）`, raw: drift ? res.raw.slice(0, 1200) : undefined, at: now };
}

export async function probeGh(now: number): Promise<ProbeResult> {
  if (!commandExists('gh')) return { dep: 'gh', available: false, ok: false, detail: 'gh 未安装（跳过）', at: now };
  const cfg = loadConfig();
  const repo = cfg.runtime.repos[0];
  const reg = cfg.projects; // 默认项目 owner：注册表里默认项目的 owner，缺省 DEFAULT_OWNER
  const owner = reg?.projects?.[reg.default_project]?.owner ?? DEFAULT_OWNER;
  // 只读、无副作用：验的正是 workspace.ts 依赖的 `gh issue list --json number,url` 字段投影。
  const r = await run('gh', ['issue', 'list', '-R', `${owner}/${repo}`, '--json', 'number,url', '-L', '1'], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
  if (r.code !== 0) return { dep: 'gh', available: true, ok: false, kind: 'auth', detail: `gh 非零退出（${r.code}，可能未登录，非必然漂移）`, raw: r.stderr.slice(0, 600), at: now };
  try {
    const arr = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(arr)) return { dep: 'gh', available: true, ok: false, kind: 'drift', detail: 'gh --json 没返回数组（疑似 gh CLI 输出 schema 变更）', raw: r.stdout.slice(0, 600), at: now };
    const bad = arr.length > 0 && !(typeof (arr[0] as Record<string, unknown>).number === 'number' && typeof (arr[0] as Record<string, unknown>).url === 'string');
    return bad
      ? { dep: 'gh', available: true, ok: false, kind: 'drift', detail: 'gh issue 项缺 number/url 字段（疑似 gh --json 投影变更）', raw: r.stdout.slice(0, 600), at: now }
      : { dep: 'gh', available: true, ok: true, detail: 'gh issue list --json 字段完好', at: now };
  } catch {
    return { dep: 'gh', available: true, ok: false, kind: 'drift', detail: 'gh --json 解析失败（疑似 gh CLI 输出 schema 变更）', raw: r.stdout.slice(0, 600), at: now };
  }
}

// 飞书入站传输探针：im/v1/messages 信封校验本是 messaging-provider 专属知识——逻辑收进 adapter
// （port.probe），这里只薄壳映射成统一 ProbeResult，断开 llm 层对 feishu/dm（base/token）的直连。
export async function probeFeishu(now: number): Promise<ProbeResult> {
  const p = await port.probe();
  // kind 必须透传（auth/drift）：丢了它则 health/contract 告警退回 drift 缺省文案（误导去改 contract.ts），
  // 漏掉「飞书 token 过期 / 群未加 bot」这类登录·权限失效——正是 #1 要直击的场景。
  return { dep: 'feishu', available: p.available, ok: p.ok, kind: p.kind, detail: p.detail, raw: p.raw, at: now };
}

// 跑全部探针（codex/claude 付费 trivial；gh/飞书免费只读）。available=false 的也返回（上层据此跳过告警）。
export async function runAllProbes(now: number): Promise<ProbeResult[]> {
  return [await probeCodex(now), await probeClaude(now), await probeGh(now), await probeFeishu(now)];
}
