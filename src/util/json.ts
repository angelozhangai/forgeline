// Extract JSON from an LLM's text output: a fenced ```json block if there is one, otherwise a balanced
// {...}.
// The robustness trade-off: models usually put the final answer at the end and occasionally embed an example
// block along the way, so this takes the **last** candidate. Parsing tolerates a trailing comma and a BOM
// (strict first, lenient only on the second attempt). If it still fails it throws, and parseStructured
// takes over the self-healing.

// Scan one balanced object from `start` (which must be a '{'), returning its slice, or null.
function sliceBalancedFrom(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Every top-level balanced object in the text (skipping ranges already consumed).
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      const slice = sliceBalancedFrom(text, i);
      if (slice) {
        out.push(slice);
        i += slice.length;
        continue;
      }
    }
    i++;
  }
  return out;
}

// Collect the contents of every matching fence (trimmed).
function allFenced(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(m[1].trim());
  return out;
}

// Parse strictly first; on failure strip the BOM and any trailing commas and try once more. If that still
// fails, throw.
function tolerantParse(s: string): unknown {
  const cleaned = s.replace(/^﻿/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const noTrailing = cleaned.replace(/,(\s*[}\]])/g, '$1'); // a comma immediately before } or ] -> drop it
    return JSON.parse(noTrailing);
  }
}

export function extractJsonBlock(text: string): unknown {
  const jsonFences = allFenced(text, /```json\s*([\s\S]*?)```/gi);
  const fences = jsonFences.length ? jsonFences : allFenced(text, /```\s*([\s\S]*?)```/g);
  const candidates = fences.length ? fences : balancedObjects(text);
  if (!candidates.length) throw new Error('no JSON block found in the LLM output');
  // Take the last candidate (the final answer is usually at the end). If it fails to parse, throw — never
  // quietly fall back to an earlier block, which could be an example or a stale draft.
  return tolerantParse(candidates[candidates.length - 1]);
}

// A forgiving read of a JSON TEXT column out of the database: a dirty value degrades to the fallback rather
// than crashing rendering or the CLI.
export function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
