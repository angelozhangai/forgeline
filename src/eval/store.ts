// eval run 落盘 + 读取（趋势对比的历史来源）。存到 logs/eval/<stamp>.json。
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOGS_DIR } from '../root.ts';
import type { EvalReport } from './aggregate.ts';

export const EVAL_RUNS_DIR = resolve(LOGS_DIR, 'eval');

// 落盘一次 eval run。stamp 由调用方传（纯逻辑不取时间），作文件名。返回路径。
export function saveEvalRun(rep: EvalReport, stamp: string, dir: string = EVAL_RUNS_DIR): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${stamp}.json`);
  writeFileSync(path, JSON.stringify(rep, null, 2));
  return path;
}

// 读最近一次落盘的 run（文件名按 ISO stamp 排序取末尾）。无 / 坏盘 → null（趋势对比降级为「无历史」）。
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
