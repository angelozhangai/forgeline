import { loadConfig, resolveLogin } from '../config.ts';
import type { Config } from '../config.ts';
import type { Routing } from '../types.ts';
import type { GateAEnvelope } from './envelopes.ts';

// Pure rule-based routing: decides who is @-mentioned to confirm (it does not decide whether to stop —
// AWAITING_PM_CONFIRM always stops).
// `cfg` is passed in by the caller for that session's project (configuration divergence: sensitive areas,
// the confidence threshold and the lead can all be overridden per project); it falls back to the global one.
export function triage(env: GateAEnvelope, cfg: Config = loadConfig()): Routing {
  const reasons: string[] = [];

  const repos = env.repos_touched ?? [];
  if (repos.length > 1) reasons.push(`spans repos (${repos.join('/')})`);

  const sens = cfg.routing.sensitive_areas.map((s) => s.toLowerCase());
  const hit = [
    ...new Set(
      (env.risks ?? [])
        .map((r) => (r.area ?? '').toLowerCase())
        .filter((a) => a && sens.some((s) => a.includes(s))),
    ),
  ];
  if (hit.length) reasons.push(`sensitive area (${hit.join('/')})`);

  const conf = typeof env.confidence === 'number' ? env.confidence : 0;
  if (conf < cfg.routing.min_confidence) reasons.push(`low confidence (${conf})`);
  if (env.needs_lead) reasons.push('the model recommended escalation');

  const toLead = reasons.length > 0;
  if (!toLead) reasons.push('single repo + no sensitive area + high confidence -> DRI self-review');

  return {
    reviewer: toLead ? cfg.routing.lead : 'engineer',
    reviewerLogin: toLead ? resolveLogin(cfg, cfg.routing.lead) : null,
    toLead,
    reasons,
    confidence: conf,
  };
}
