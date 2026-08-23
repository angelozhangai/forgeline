import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROMPTS_DIR, LOGS_DIR } from '../root.ts';

// Prompt resolution order (first match wins):
//   1. $FORGE_PROMPTS_DIR/<projectId>/<rel>   private overlay · per-project variant
//   2. $FORGE_PROMPTS_DIR/<rel>               private overlay · global override
//   3. prompts/<projectId>/<rel>              in-repo · per-project variant
//   4. prompts/<rel>                          in-repo · default template
// FORGE_PROMPTS_DIR points at a directory outside this repo (the checkout of a private repo, say), so a
// deployment can override the built-in defaults with its own tuned prompts without forking this repo. With
// the variable unset, the behaviour is exactly what it always was.
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

// Replace {{KEY}} with vars[KEY]; a placeholder with no value is left as it is.
export function render(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => (k in vars ? vars[k] : `{{${k}}}`));
}

export function sessionLogDir(id: string): string {
  const d = resolve(LOGS_DIR, id);
  mkdirSync(d, { recursive: true });
  return d;
}
