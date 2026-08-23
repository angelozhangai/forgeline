// Persisting and reading an eval run (the history the trend comparison draws on). Stored under
// logs/eval/<stamp>.json.
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOGS_DIR } from '../root.ts';
import type { EvalReport } from './aggregate.ts';

export const EVAL_RUNS_DIR = resolve(LOGS_DIR, 'eval');

// Persist one eval run. The caller passes the stamp (the pure logic never reads the clock), which becomes the
// filename. Returns the path.
export function saveEvalRun(rep: EvalReport, stamp: string, dir: string = EVAL_RUNS_DIR): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${stamp}.json`);
  writeFileSync(path, JSON.stringify(rep, null, 2));
  return path;
}

// Read the most recently persisted run (filenames sort by ISO stamp, so take the last). None, or an
// unreadable file -> null, and the trend comparison degrades to "no history".
export function loadLatestEvalRun(dir: string = EVAL_RUNS_DIR): EvalReport | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (!files.length) return null;
  try {
    return JSON.parse(readFileSync(resolve(dir, files[files.length - 1]), 'utf8')) as EvalReport;
  } catch {
    return null;
  }
}
