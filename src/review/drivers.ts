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

// codex审⇄claude改 真实驱动的参数化：闸A/闸B 仅这些点不同（label / 落盘名 / on_missing=skip 日志 /
// 成本累加列 / codex-token 列）。列特定的写库用回调注入——保持「列知识」在各 gate 模块、避开 computed-key
// 的 TS 摩擦，工厂体本身完全 product-agnostic。
export interface ReviewFixDriverOpts {
  reviewLabel: string; // codex 复审标签（'闸A·对抗'）
  reviewClaudeLabel: string; // claude 降级自审标签（'闸A·对抗·claude'）
  fixLabel: string; // claude 改方标签（'闸A·改评审'）
  reviewDumpName: string; // 复审原文落盘名（'gate-a-review.raw.txt'）
  fixDumpName: string; // 改方原文落盘名（'gate-a-fix.raw.txt'）
  skipLog: string; // on_missing=skip 时的日志（'…→ 跳过闸A 对抗复审'）
  accrueFixCost: (costUsd: number) => void; // 累加 claude 改方成本到本 gate 的成本列
  persistReviewerTokens?: (tokensJson: string) => void; // codex token 用量落列（仅闸B；codex 无美元口径）
}

// 真实驱动工厂：reviewer=codex（thread_id resume；on_missing 降级 claude 自审 / skip / error），
// fixer=claude（pin session 续修）。抽这一处后，gateALoop/gateBLoop 不再各拷一份近 50 行近同的驱动。
export function makeReviewFixDrivers(s: Session, o: ReviewFixDriverOpts): ReviewFixDrivers {
  const proj = projectForSession(s); // 目标项目根：codex/claude 都以它为 cwd（读代码真源 + PRD）
  const dumpRaw = (name: string, raw: string): void => {
    try {
      writeFileSync(resolve(sessionLogDir(s.id), name), raw); // 失败/解析失败时人核对的原文
    } catch {
      /* 落盘失败不阻断流程 */
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
          if (cfg.runtime.adversarial.on_missing === 'error') throw new Error('codex 不可用且 on_missing=error');
          log.warn('codex 未安装，降级用 claude 自审（独立性弱，装上 codex 自动切回）');
        } else {
          log.warn(`codex 复审失败（${c.error}），降级用 claude`);
        }
      }
      // claude 自审降级（无会话续接，每轮重发——独立性弱，仅 codex 缺失时兜底）。失败**不再按通过**：available=true+ok=false 上抛停泊。
      // 【为何不 resume 省 token】引擎只有一个 reviewer-session 槽，codex 路径把它当 codex thread_id 续接。
      // 若让 claude 兜底也 pin/resume 自己的 session 存进该槽，下一轮 codex 路径会拿 claude session 当 thread_id 误用
      // （codex 偶发失败回到这里时尤甚）。安全的续接要么加第二个 claude-reviewer 槽、要么持久化「reviewer 模式」——
      // 对一个 README 已建议「装上 codex 即自动切回」的降级路径而言，这点 token 省不值得给核心引擎加状态。故保持每轮重发。
      const r = await runClaude(prompt, { label: o.reviewClaudeLabel, cwd: proj.root });
      dumpRaw(o.reviewDumpName, r.raw ?? '');
      if (!r.ok) {
        log.warn(`claude 复审失败（${r.error}）→ 上抛停泊，绝不静默放行`);
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
        sid = randomUUID(); // pin 新会话，便于后续续修 resume
        res = await runClaude(prompt, { label: o.fixLabel, sessionId: sid, cwd: proj.root });
      }
      dumpRaw(o.fixDumpName, res.raw ?? '');
      if (res.ok && res.costUsd != null) o.accrueFixCost(res.costUsd); // 累加，不覆盖初稿/评审成本
      return { ok: res.ok, text: res.result, sessionId: res.ok ? sid : null, costUsd: res.costUsd, error: res.error };
    },
  };
}
