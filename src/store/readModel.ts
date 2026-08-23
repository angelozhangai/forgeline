// The "read model" for the JSON text columns on a session: it parses the routing, residue and score-dimension
// TEXT columns into structures.
// One source of truth - this used to be duplicated between notify.ts (privately) and index.ts (inline). Broken
// or missing JSON always yields an empty skeleton or null (the display layer is best-effort and never throws;
// the no-silent-failures discipline is enforced on the write side, where a genuine failure parks the session -
// this is only reading for rendering).
import type { Session, Routing } from '../types.ts';
import type { ScoreDims } from '../util/scoring.ts';

export function routingOf(s: Session): Routing | null {
  try {
    return s.routing ? (JSON.parse(s.routing) as Routing) : null;
  } catch {
    return null;
  }
}

// The four PRD score dimensions (clarity, completeness, feasibility, testability; each 0-25). Broken or
// missing -> null (the badge degrades).
export function parseDims(json: string | null): ScoreDims | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ScoreDims;
  } catch {
    return null;
  }
}

// One residual finding (an adversarial-review or Gate B finding that was never resolved). `evidence` is only
// shown in the CLI detail view and is not read by the cards (carrying it along is harmless).
export interface ResidualFinding {
  severity?: string;
  issue: string;
  where?: string;
  fix?: string;
  evidence?: string;
}

// The Gate A residue (gate_a_residual): either the PM's still-open questions across rounds, or codex's
// unresolved adversarial findings (`source` tells them apart).
export interface ResidualRead {
  round: number;
  source?: string; // 'codex' = unresolved adversarial-review findings; absent = the PM's still-open questions
  open_questions: { q: string; suggestion?: string; severity?: string }[];
  findings: ResidualFinding[];
}
export function readResidual(json: string | null): ResidualRead {
  const empty: ResidualRead = { round: 0, open_questions: [], findings: [] };
  if (!json) return empty;
  try {
    const j = JSON.parse(json) as Partial<ResidualRead>;
    return {
      round: j.round ?? 0,
      source: j.source,
      open_questions: Array.isArray(j.open_questions) ? j.open_questions : [],
      findings: Array.isArray(j.findings) ? j.findings : [],
    };
  } catch {
    return empty;
  }
}

// The Gate B adversarial residue (adversarial_residual): the findings still unresolved at the cap, the round
// number, and which reviewer produced them.
export interface GateBResidualRead {
  round: number;
  used: string;
  findings: ResidualFinding[];
}
export function readGateBResidual(json: string | null): GateBResidualRead {
  const empty: GateBResidualRead = { round: 0, used: '', findings: [] };
  if (!json) return empty;
  try {
    const j = JSON.parse(json) as Partial<GateBResidualRead>;
    return { round: j.round ?? 0, used: j.used ?? '', findings: Array.isArray(j.findings) ? j.findings : [] };
  } catch {
    return empty;
  }
}

// How many findings in the adversarial residue await arbitration (the GO card and the CLI show "N awaiting
// arbitration"). Broken or missing -> 0.
export function residualCount(json: string | null): number {
  return readGateBResidual(json).findings.length;
}
