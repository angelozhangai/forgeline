// 唯一的「LLM 结构化输出」内核：抽取 + zod 校验 + **解析失败自愈**（resume 同会话回喂模型重出）。
// 所有解析点（闸A/闸B/对抗 verdict/改方 FixResult）共用，避免再造第二套、避免契约漂移。

import { z } from 'zod';
import { extractJsonBlock } from '../util/json.ts';

// zod 报错 → 人/模型都能读的一行（回喂时贴进修复指令）。
export function formatZodError(e: unknown): string {
  if (e instanceof z.ZodError) {
    return e.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '(根)'}: ${i.message}`)
      .join('; ');
  }
  return e instanceof Error ? e.message : String(e);
}

// 抽取 + 校验，失败抛**可读** Error（供 parse 闭包复用）。
// 用 z.infer<S> 返回 schema 的**输出**类型（default/preprocess 应用后），避免推断成可选的输入类型。
export function strictParse<S extends z.ZodTypeAny>(schema: S, text: string): z.infer<S> {
  const raw = extractJsonBlock(text); // 找不到/坏 JSON → 抛
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error(`输出不符合契约：${formatZodError(r.error)}`);
  return r.data;
}

export interface ParseStructuredOpts<T> {
  text: string; // 首次 LLM 原文
  parse: (text: string) => T; // 抛错 = 不合格（用 strictParse 或 cfg 钩子）
  reEmit: (instruction: string) => Promise<string | null>; // resume 同会话回喂，返回新原文；null = 回喂调用失败（瞬时/无会话）
  buildRepairInstruction: (error: string) => string; // 据报错构造修复指令（含契约提醒）
  maxRetries: number; // 自愈最多重试次数（0 = 不自愈，等价旧行为）
  reEmitCallRetries?: number; // 回喂调用本身瞬时失败(null)时的内层重试次数（默认 2，退避后重试，不消耗 maxRetries）
  backoffMs?: (call: number) => number; // 回喂调用失败后的退避（默认指数+jitter）；测试可注入 () => 0
  sleep?: (ms: number) => Promise<void>; // 退避实现（默认 setTimeout）；测试可注入免真睡
  note?: (kind: string, detail: unknown) => void; // 审计事件
  dump?: (raw: string) => void; // 落盘回喂原文（排障）
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 回喂调用瞬时失败后的退避：1s/3s/8s 指数封顶 + ±20% jitter（错开多 session 同时砸限流墙）。
const REPAIR_BACKOFF_MS = [1000, 3000, 8000];
function repairBackoff(call: number): number {
  const base = REPAIR_BACKOFF_MS[Math.min(Math.max(call, 0), REPAIR_BACKOFF_MS.length - 1)];
  return Math.round(base + base * 0.2 * (Math.random() * 2 - 1));
}

// 解析 → 失败则回喂重出 → 重解析，最多 maxRetries 次。耗尽抛最后一次 error（行为同现状停泊）。
// P1-1：回喂**调用本身**瞬时失败(null) 不再一抖就终结自愈，而是退避后内层有限重试（reEmitCallRetries 次）；
// 仍拿不到才抛停泊。P1-2：内层重试带退避+jitter，避免背靠背重发砸穿限流。
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
      // 回喂重出：首次立即发（坏 JSON 多是模型笔误、重发即好）；调用失败(null) → 退避后内层重试，不终结自愈。
      let next: string | null = null;
      for (let call = 0; call <= callRetries; call++) {
        if (call > 0) await sleep(backoff(call - 1));
        next = await opts.reEmit(instruction);
        if (next != null) break;
        opts.note?.('parse_repair_reemit_failed', { attempt: attempt + 1, call: call + 1 });
      }
      if (next == null) {
        // 回喂连续失败（疑似无会话 / 持续故障）→ 不再硬撑，抛出停泊。
        opts.note?.('parse_repair_no_reemit', { attempt: attempt + 1 });
        throw e;
      }
      opts.dump?.(next);
      text = next;
    }
  }
}
