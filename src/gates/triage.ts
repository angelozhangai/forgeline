import { loadConfig, resolveLogin } from '../config.ts';
import type { Config } from '../config.ts';
import type { Routing } from '../types.ts';
import type { GateAEnvelope } from './envelopes.ts';

// 纯规则路由：决定 @谁来确认（不决定是否停——AWAITING_PM_CONFIRM 必停）。
// cfg 由调用方按 session 项目传入（配置分化：敏感域/置信阈/lead 可项目级覆盖）；缺省回退全局。
export function triage(env: GateAEnvelope, cfg: Config = loadConfig()): Routing {
  const reasons: string[] = [];

  const repos = env.repos_touched ?? [];
  if (repos.length > 1) reasons.push(`跨仓(${repos.join('/')})`);

  const sens = cfg.routing.sensitive_areas.map((s) => s.toLowerCase());
  const hit = [
    ...new Set(
      (env.risks ?? [])
        .map((r) => (r.area ?? '').toLowerCase())
        .filter((a) => a && sens.some((s) => a.includes(s))),
    ),
  ];
  if (hit.length) reasons.push(`敏感域(${hit.join('/')})`);

  const conf = typeof env.confidence === 'number' ? env.confidence : 0;
  if (conf < cfg.routing.min_confidence) reasons.push(`低置信(${conf})`);
  if (env.needs_lead) reasons.push('模型建议升级');

  const toLead = reasons.length > 0;
  if (!toLead) reasons.push('单仓 + 无敏感域 + 高置信 → DRI 自评');

  return {
    reviewer: toLead ? cfg.routing.lead : 'engineer',
    reviewerLogin: toLead ? resolveLogin(cfg, cfg.routing.lead) : null,
    toLead,
    reasons,
    confidence: conf,
  };
}
