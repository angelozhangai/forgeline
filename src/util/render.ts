import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROMPTS_DIR, LOGS_DIR } from '../root.ts';

// 提示词解析顺序（先到先用）：
//   ① $FORGE_PROMPTS_DIR/<projectId>/<rel>   私有叠加层 · 项目变体
//   ② $FORGE_PROMPTS_DIR/<rel>               私有叠加层 · 全局覆盖
//   ③ prompts/<projectId>/<rel>              仓内 · 项目变体
//   ④ prompts/<rel>                          仓内 · 默认模板
// FORGE_PROMPTS_DIR 指向仓外目录（如另一个私有仓的 checkout），用自己调教的提示词
// 覆盖内置默认版而无需 fork 本仓；未设置时行为与从前完全一致。
export function loadPrompt(rel: string, projectId?: string): string {
  const overlay = process.env.FORGE_PROMPTS_DIR;
  const candidates: string[] = [];
  if (overlay) {
    if (projectId) candidates.push(resolve(overlay, projectId, rel));
    candidates.push(resolve(overlay, rel));
  }
  if (projectId) candidates.push(resolve(PROMPTS_DIR, projectId, rel));
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return readFileSync(resolve(PROMPTS_DIR, rel), 'utf8');
}

// 把 {{KEY}} 替换为 vars[KEY]；未提供的占位保留原样。
export function render(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => (k in vars ? vars[k] : `{{${k}}}`));
}

export function sessionLogDir(id: string): string {
  const d = resolve(LOGS_DIR, id);
  mkdirSync(d, { recursive: true });
  return d;
}
