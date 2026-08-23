// The PRD source of truth (already reviewed over several rounds) — a single document synthesised
// mechanically when the Gate A review is sealed, and the **only** requirement input Gate B reads.
// Design points:
// - **Mechanical concatenation, no claude call**: pure string synthesis (PRD source text + the Gate A review
//   final draft + the PM's multi-round confirmations). Reproducible and snapshot-testable; it pulls in no
//   Date.now or other non-deterministic value, which keeps unit tests and drift reconciliation simple.
// - **Sealing semantics**: written to disk the moment Gate A closes (CONFIRMED), freezing "the requirement
//   truth as converged at this instant". Gate B reads only this one file.
// - **Robust fallback**: if the document is missing when Gate B reads it (an M forced the confirmation, an old
//   session, or it was cleaned up), it is synthesised on the spot and best-effort written back — Gate B must
//   never be handed an empty requirement.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { projectForSession } from '../projects.ts';
import { GateASchema } from './envelopes.ts';
import type { GateAEnvelope } from './envelopes.ts';
import { sizeBadge } from '../util/sizing.ts';
import type { Session } from '../types.ts';

// Path to the source-of-truth document under the delivery directory (it sits alongside req-review.md /
// tech-design.md in <deliveryDir>/<slug>/, is derived deterministically, and is not stored as a DB column).
export function prdTruthPath(s: Session): string {
  return resolve(projectForSession(s).deliveryDir, s.slug, 'prd-truth.md');
}

// Pure synthesis: PRD source text + the Gate A review final draft + the PM's confirmations -> a single
// markdown document. No IO and no time values, which keeps it snapshot-testable.
export function buildPrdTruth(prdText: string, env: GateAEnvelope, confirmedNotes: string): string {
  const repos = (env.repos_touched ?? []).join(' / ') || '(undetermined)';
  const risks = env.risks.length
    ? env.risks.map((r) => `- [${r.area || 'general'}] ${r.detail}${r.evidence ? ` (evidence: ${r.evidence})` : ''}`).join('\n')
    : '- (none)';
  // After the close, open_questions should be empty (all answered). If it is not (residue from an M forcing
  // the gate open) the questions are listed so Gate B knows it is proceeding with open points.
  const oq = env.open_questions.length
    ? env.open_questions.map((q, i) => `${i + 1}. [${q.severity}] ${q.q}${q.suggestion ? `\n   - Leaning: ${q.suggestion}` : ''}`).join('\n')
    : '(everything is clarified; the PM answers are in "3. PM confirmations")';
  return [
    '# PRD source of truth (reviewed over several rounds)',
    '',
    '> Forge synthesises this **mechanically** (no further AI authoring) when the Gate A review is sealed:',
    '> the PRD source text + the claude review / codex adversarial re-review final draft + the PM confirmations.',
    '> This is the **only** requirement input to the Gate B tech design — Gate B reads this file (plus the live',
    '> source of truth in the code) and never re-assembles the three sources itself.',
    '',
    '## 1. PRD source text',
    '',
    prdText.trim() || '(no PRD body was provided)',
    '',
    '## 2. Gate A review, final draft (claude review + codex adversarial re-review, converged)',
    '',
    `- **Summary**: ${env.summary || '(none)'}`,
    `- **Repos touched**: ${repos}`,
    `- **Complexity**: ${sizeBadge(env.size)}${env.size_reason ? ` (${env.size_reason})` : ''}`,
    `- **Confidence**: ${env.confidence}`,
    '',
    '### Risks / conflicts',
    risks,
    '',
    '### Open questions (after the review converged)',
    oq,
    '',
    '## 3. PM confirmations (multi-round answers; Gate B builds the design from these)',
    '',
    confirmedNotes.trim() || '(no additional notes)',
    '',
  ].join('\n');
}

// Read the session's Gate A envelope. It distinguishes two kinds of "missing" and never silently degrades
// "broken" into "empty" (holding the no-silent-failures line):
// - **no gate_a_output_path** (an old session that never produced a Gate A envelope) -> fall back to an empty
//   envelope (legacy; the PRD source text and the PM confirmations still carry the requirement).
// - **a path that is present but unreadable / broken JSON / off-contract** (truncated, written badly, or field
//   drift after a migration) -> **throw**. It must never return a shell labelled "reviewed over several rounds".
//   The throw bubbles through composePrdTruth -> loadPrdTruth -> runGateB, and the worker parks at
//   GATE_B_FAILED for a human (a parse failure is a permanent error, so it is not retried automatically).
function readGateAEnv(s: Session): GateAEnvelope {
  if (!s.gate_a_output_path) return GateASchema.parse({}); // legacy: there never was a Gate A envelope
  const p = s.gate_a_output_path;
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`PRD source of truth: the Gate A envelope could not be read (${p}) - ${String(e).slice(0, 160)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`PRD source of truth: the Gate A envelope failed to parse as JSON (${p}, likely truncated or written badly) - ${String(e).slice(0, 160)}`);
  }
  try {
    return GateASchema.parse(json);
  } catch (e) {
    throw new Error(`PRD source of truth: the Gate A envelope is off-contract (${p}, likely field drift after a migration) - ${String(e).slice(0, 160)}`);
  }
}

// Synthesise the source-of-truth content from the session's three sources on the spot (reading the PRD source
// text, the Gate A envelope and confirmed_notes). Writes nothing to disk.
export function composePrdTruth(s: Session): string {
  const prdText = s.prd_text_path && existsSync(s.prd_text_path) ? readFileSync(s.prd_text_path, 'utf8') : '';
  return buildPrdTruth(prdText, readGateAEnv(s), s.confirmed_notes ?? '');
}

// Seal and write: only once the <slug> delivery directory exists (Gate A has scaffolded req-review.md). Same
// discipline as markReviewActive / appendMachineSection — it avoids conjuring files into the delivery
// directory when nothing has been scaffolded (in tests, for instance). Returns whether it wrote.
export function writePrdTruth(s: Session): boolean {
  const p = prdTruthPath(s);
  if (!existsSync(dirname(p))) return false; // delivery directory not ready -> do not conjure it (Gate B's loadPrdTruth synthesises a fallback)
  writeFileSync(p, composePrdTruth(s));
  return true;
}

// The Gate B read: prefer the sealed document; if it is missing, synthesise on the spot and best-effort write
// it back (so a later drift loop reads the same file). Always returns content.
export function loadPrdTruth(s: Session): string {
  const p = prdTruthPath(s);
  if (existsSync(p)) return readFileSync(p, 'utf8');
  const content = composePrdTruth(s);
  try {
    if (existsSync(dirname(p))) writeFileSync(p, content);
  } catch {
    /* best-effort write-back; a failure must not block Gate B */
  }
  return content;
}
