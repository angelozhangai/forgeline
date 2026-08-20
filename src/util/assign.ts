// 自动指派推荐：least-loaded + WIP limit（纯函数，便于单测）。
// 选「投影负载最低且未超 WIP 上限」的人：投影 = 当前在研负载 + 本需求规模点数 → 最小化削峰（近似 makespan 最小）；
// WIP 上限防单人并发线头过多（上下文切换成本）。全员超上限 → 回退全池（不阻断，仅标注，交人裁量）。
import { sizePoints, type Size } from './sizing.ts';
import type { AssignmentConfig } from '../config.ts';

export interface LoadRow {
  code: string; // 短码
  wip: number; // 在研需求条数
  loadPoints: number; // 在研加权点数
  ok?: boolean; // 负载探测是否成功（失败=未知；仍参与，但调用方可在卡上标注）
}

export interface RecoRow extends LoadRow {
  projected: number; // loadPoints + 本需求点数
  wipLimit: number;
  eligible: boolean; // 未超 WIP 上限
}

export interface Recommendation {
  pick: string | null; // 推荐短码（无可定候选→null，强制人工）
  allOverWip: boolean; // 已知负载者全超 WIP → 回退「已知池」择优
  probeIncomplete: boolean; // 有成员负载探测失败/未知 → 已从自动选里排除（绝不当 0 负载）
  points: number; // 本需求规模点数
  table: RecoRow[]; // 各候选展开（供卡片/CLI 展示理由）
}

export function wipLimitOf(cfg: AssignmentConfig, code: string): number {
  return cfg.wip_limit[code] ?? cfg.wip_limit.default;
}

// 短码归一到池内规范写法（大小写不敏感）；不在池 → null。
export function inPool(cfg: AssignmentConfig, raw: string): string | null {
  const up = raw.trim().toUpperCase();
  return cfg.pool.find((c) => c.toUpperCase() === up) ?? null;
}

export function recommend(size: Size | null, loads: LoadRow[], cfg: AssignmentConfig): Recommendation {
  const points = sizePoints(size);
  const byCode = new Map(loads.map((l) => [l.code, l]));
  const order = cfg.pool;
  // 缺行=池成员未被探测到 → 负载未知（ok:false），绝不当 0 负载。
  const table: RecoRow[] = order.map((code) => {
    const l = byCode.get(code) ?? { code, wip: 0, loadPoints: 0, ok: false };
    const wipLimit = wipLimitOf(cfg, code);
    return { ...l, code, projected: l.loadPoints + points, wipLimit, eligible: l.wip < wipLimit };
  });
  // 只在「负载已知」者里自动选：探测失败/未知（ok===false）排除——否则瞬时 GitHub 故障会把人误判成 0 负载抢着指派。
  const known = table.filter((r) => r.ok !== false);
  const probeIncomplete = known.length < table.length;
  const underCap = known.filter((r) => r.eligible);
  let candidates: RecoRow[];
  let allOverWip = false;
  if (underCap.length) candidates = underCap;
  else if (known.length) {
    candidates = known; // 已知者全超 WIP → 回退已知池择优（仍标注）
    allOverWip = true;
  } else candidates = []; // 全员负载未知（全探测失败）→ 无可定候选，pick=null 强制人工
  // argmin：投影负载 → 在研条数 → 当前负载 → pool 顺序（稳定，决定性）
  const pick =
    [...candidates].sort(
      (a, b) =>
        a.projected - b.projected ||
        a.wip - b.wip ||
        a.loadPoints - b.loadPoints ||
        order.indexOf(a.code) - order.indexOf(b.code),
    )[0]?.code ?? null;
  return { pick, allOverWip, probeIncomplete, points, table };
}
