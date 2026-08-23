// The automatic-assignment recommendation: least-loaded plus a WIP limit (a pure function, easy to unit-test).
// It picks the person with the lowest projected load who is still under their WIP limit. Projected = their
// current in-progress load + this requirement's size points, which minimises the peak (an approximation of
// minimising makespan); the WIP limit stops one person holding too many concurrent threads (the cost is
// context switching). If everyone is over the limit it falls back to the whole pool — never blocking, only
// flagging it, and leaving the judgement to a human.
import { sizePoints, type Size } from './sizing.ts';
import type { AssignmentConfig } from '../config.ts';

export interface LoadRow {
  code: string; // the short code
  wip: number; // how many requirements are in progress
  loadPoints: number; // the weighted points in progress
  ok?: boolean; // whether the load probe succeeded (a failure means unknown; they still appear, but the caller can flag it on the card)
}

export interface RecoRow extends LoadRow {
  projected: number; // loadPoints + this requirement's points
  wipLimit: number;
  eligible: boolean; // still under the WIP limit
}

export interface Recommendation {
  pick: string | null; // the recommended short code (null when there is no determinable candidate, which forces a human decision)
  allOverWip: boolean; // everyone with a known load is over their WIP limit -> fall back to picking the best of the known pool
  probeIncomplete: boolean; // some member's load probe failed or is unknown -> they are excluded from the automatic pick (never treated as zero load)
  points: number; // this requirement's size points
  table: RecoRow[]; // every candidate laid out (so the card and the CLI can show the reasoning)
}

export function wipLimitOf(cfg: AssignmentConfig, code: string): number {
  return cfg.wip_limit[code] ?? cfg.wip_limit.default;
}

// Normalise a short code to the pool's canonical spelling (case-insensitive); not in the pool -> null.
export function inPool(cfg: AssignmentConfig, raw: string): string | null {
  const up = raw.trim().toUpperCase();
  return cfg.pool.find((c) => c.toUpperCase() === up) ?? null;
}

export function recommend(size: Size | null, loads: LoadRow[], cfg: AssignmentConfig): Recommendation {
  const points = sizePoints(size);
  const byCode = new Map(loads.map((l) => [l.code, l]));
  const order = cfg.pool;
  // A missing row means a pool member was never probed -> their load is unknown (ok:false), and must never be
  // treated as zero load.
  const table: RecoRow[] = order.map((code) => {
    const l = byCode.get(code) ?? { code, wip: 0, loadPoints: 0, ok: false };
    const wipLimit = wipLimitOf(cfg, code);
    return { ...l, code, projected: l.loadPoints + points, wipLimit, eligible: l.wip < wipLimit };
  });
  // Pick automatically only among those whose load is known: a failed or unknown probe (ok === false) is
  // excluded — otherwise a momentary GitHub outage would make someone look like zero load and win every
  // assignment.
  const known = table.filter((r) => r.ok !== false);
  const probeIncomplete = known.length < table.length;
  const underCap = known.filter((r) => r.eligible);
  let candidates: RecoRow[];
  let allOverWip = false;
  if (underCap.length) candidates = underCap;
  else if (known.length) {
    candidates = known; // everyone known is over their WIP limit -> pick the best of the known pool anyway (still flagged)
    allOverWip = true;
  } else candidates = []; // nobody's load is known (every probe failed) -> no determinable candidate, pick=null, a human decides
  // argmin: projected load -> requirements in progress -> current load -> pool order (stable and deterministic)
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
